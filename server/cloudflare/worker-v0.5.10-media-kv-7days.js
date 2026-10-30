// Orbita · Cloudflare Worker + D1 — общий сервер для расширения.
//
// Как выложить (без CLI и без ключей):
//   1) dash.cloudflare.com → «Storage & Databases» → D1 → создать базу `orbita`,
//      выполнить в её консоли server/cloudflare/schema.sql.
//   2) «Compute» (или «Workers & Pages») → Create application → Worker → шаблон
//      Hello World → имя `orbita` → Deploy. При первом заходе Cloudflare попросит
//      придумать поддомен для *.workers.dev — это тот адрес, что потом вставите в расширение.
//   3) У воркера: Settings → Bindings → Add → D1 Database → Variable name ровно `DB`
//      → Database: orbita → Save and Deploy.
//   4) Вкладка Code → заменить всё содержимое index.js ЭТИМ файлом → Save and Deploy.
//   5) Проверка: https://orbita.<поддомен>.workers.dev/api/health → JSON.
//
// Контракт совпадает с server/supabase/function_orbita.ts и локальным server/server.js:
// шесть ручек, JSON, CORS *. В расширение не вписывается ни один ключ — D1 доступна
// воркеру через binding, наружу торчит только сам воркер.
//
// /api/pull умеет ждать: ?wait=30 держит соединение и отвечает в момент, когда в базе
// появляется новое сообщение или удаление (доставка за секунды вместо полминуты).
// Там же присутствие: &dev=<алиас:вкладка>&beat=<токен комнаты> обновляет строку онлайн и
// возвращает счётчик комнаты — отдельного POST раз в 15 секунд клиенту больше не нужно.
// Клиенты до v0.3.0 шлют сюда сырой адрес страницы; воркер хэширует его сам, поэтому и
// старые, и новые попадут в одну корзину. Сырых адресов в базе не остаётся.
// Серверы, которые wait/beat не знают (Supabase, server/server.js), отвечают мгновенно
// без поля clients, и клиент сам возвращается на старый режим: редкий POST + таймер.
//
// Авторство: /api/push принимает одноразовый ключ удаления, от которого в базе остаётся
// только sha256. /api/delete сверяет ключ, а не публичный id автора — id лежит в открытом
// потоке и никому не доказывает, что сообщение его.
//
// Зависимостей нет намеренно: только Web API + env.DB.

const RATE_WINDOW_MS = 20_000;
const RATE_MAX = 5;
// отдельный потолок на сутки для одного адреса: иначе можно было бы залить сеть каналов,
// оставаясь в лимите каждого из них
const RATE_DAY_MS = 86_400_000;
const RATE_DAY_MAX = 300;
// присутствие обновляют редкие «биты» внутри pull (клиент шлёт их раз в ~4 минуты),
// поэтому и living-окно широкое: человек закрыл вкладку — счётчик догорает за 5 минут
const PRESENCE_TTL_MS = 300_000;
// двойной бит из той же комнаты за эту срок не записывается: строка и так свежая
const PRESENCE_SKIP_MS = 30_000;
const KEEP_DAYS = 30;
const PULL_LIMIT = 500;
const WAIT_MAX_SEC = 45;
const WAIT_STEPS_MS = [2000, 3000, 5000, 7000, 8000];
// /api/health и корневая страница не должны пересчитывать count(*) по всем сообщениям
// на каждом запросе: D1 считает прочитанные строки, и на большой базе это сжигает дневной
// лимит. Счётчик живёт в orb_meta и обновляется не чаще раза в 5 минут.
const META_TTL_MS = 300_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
  "cache-control": "no-store",
};

function send(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

const asText = (v) => (typeof v === "string" ? v : "");
const asList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 5000) : []);

/* Криптография та же, что в store.js: комната — это sha1 от «url#lang@orbita.room»,
   первые 32 знака. Хэш необратим, поэтому по таблице присутствия больше нельзя прочитать,
   на каких страницах человек сидит. */
const SALT_ROOM = "@orbita.room";

async function digest(algorithm, text) {
  const buf = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// клиент v0.3 присылает готовый токен, клиент v0.2 — сырой «url#lang»: хэшируем здесь,
// чтобы оба считались одной комнатой
async function roomToken(value) {
  const v = String(value || "");
  if (/^[0-9a-f]{32}$/.test(v)) return v;
  return (await digest("SHA-1", v + SALT_ROOM)).slice(0, 32);
}

// SQLite хранит массивы и вложенные объекты как JSON-текст
function parse(s, fallback) {
  if (typeof s !== "string" || !s) return fallback;
  try {
    const v = JSON.parse(s);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

const stringify = (v) => JSON.stringify(v === undefined || v === null ? null : v);

function msgOf(r) {
  return {
    id: r.id,
    ch: r.ch,
    url: r.url,
    lang: r.lang,
    ts: r.ts,
    author: parse(r.author, {}),
    text: r.body,
    links: parse(r.links, []),
    up: parse(r.up, []),
    down: parse(r.down, []),
    stars: parse(r.stars, []),
    reports: parse(r.reports, []),
    effect: parse(r.effect, null),
    quote: r.quote || "",
    replyTo: r.reply_to || "",
  };
}

// Числа в D1/SQLite приходят целыми, но на всякий случай держим ms-точность:
// |0 здесь убивает смысл (1.7e12 не влезает в 32 бита), поэтому только Math.floor.
const asTime = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

let lastPrune = 0;

export async function prune(db, keepDays) {
  const t = Date.now();
  await db.prepare("delete from orb_msg  where ts < ?").bind(t - keepDays * 86_400_000).run();
  await db.prepare("delete from orb_gone where ts < ?").bind(t - 30 * 86_400_000).run();
  await db.prepare("delete from orb_pres where ts < ?").bind(t - PRESENCE_TTL_MS).run();
  // суточный лимит считается по часам, поэтому строки rate живут сутки, а не час
  await db.prepare("delete from orb_rate where ts < ?").bind(t - RATE_DAY_MS).run();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function health(db, ctx) {
  const t = Date.now();
  return {
    ok: true,
    now: t,
    messages: await cachedCount(db, "messages", "select count(*) as c from orb_msg", ctx),
    clients: await roomCount(db, null, t),
  };
}

// Дневной лимит D1 считается в ПРОЧИТАННЫХ СТРОКАХ, поэтому count(*) по всей таблице
// сообщений нельзя вызывать на каждом health-запросе. Держим число в orb_meta и
// пересчитываем в фоне не чаще раза в пять минут.
async function cachedCount(db, key, sql, ctx) {
  const write = async (value) => {
    await db
      .prepare(
        `insert into orb_meta (key, val, ts) values (?, ?, ?)
         on conflict (key) do update set val = excluded.val, ts = excluded.ts`
      )
      .bind(key, value, Date.now())
      .run();
  };
  const count = async () => {
    const c = await db.prepare(sql).first();
    return (c && c.c) || 0;
  };
  const row = await db.prepare("select val, ts from orb_meta where key = ?").bind(key).first();
  if (!row) {
    // первый запрос после деплоя считает сразу: иначе страница-сводка молчала бы
    // пять минут нулём, и это выглядело бы как пустая база
    const value = await count();
    await write(value);
    return value;
  }
  if (Date.now() - row.ts < META_TTL_MS) return row.val || 0;
  // число устарело — отдаём прошлое, настоящий пересчёт уходит в фон после ответа
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(count().then(write).catch(() => {}));
  return row.val || 0;
}

// Сколько клиентов в комнате (или во всех комнатах, если токен не задан)
async function roomCount(db, room, t) {
  const n = room
    ? await db
        .prepare("select count(*) as c from orb_pres where room = ? and ts > ?")
        .bind(room, t - PRESENCE_TTL_MS)
        .first()
    : await db.prepare("select count(*) as c from orb_pres where ts > ?").bind(t - PRESENCE_TTL_MS).first();
  return (n && n.c) || 0;
}

/* Присутствие приходит внутри pull: отдельного POST раз в 15 секунд больше нет.
   Клиент шлёт dev=<алиас:вкладка> и beat=<токен комнаты>, на которую он сейчас смотрит, —
   это и есть честный «онлайн». Ответ приносит счётчик для этой же комнаты. */
async function beat(db, params) {
  const client = asText(params.get("dev")).slice(0, 120);
  const raw = asText(params.get("beat")).slice(0, 600);
  if (!client || !raw) return undefined;
  const room = await roomToken(raw);
  const t = Date.now();
  /* Запись в D1 — самое дорогое, что тут есть (100 000 в сутки на весь аккаунт, и с осени
     2026-го сверх лимита запросы падают ошибкой). Строка живёт 5 минут, поэтому бит,
     прилетевший через минуту после предыдущего из той же комнаты, можно просто посчитать
     и не записывать: чтение дешевле записи в пятьдесят раз. */
  const cur = await db.prepare("select room, ts from orb_pres where client = ?").bind(client).first();
  if (cur && cur.room === room && t - (cur.ts || 0) < PRESENCE_SKIP_MS) return roomCount(db, room, t);
  await db
    .prepare(
      `insert into orb_pres (client, room, ts) values (?, ?, ?)
       on conflict (client) do update set room = excluded.room, ts = excluded.ts`
    )
    .bind(client, room, t)
    .run();
  return roomCount(db, room, t);
}

const waitMs = (params) => {
  const w = Number(params.get("wait"));
  if (!Number.isFinite(w) || w <= 0) return 0;
  return Math.min(Math.floor(w), WAIT_MAX_SEC) * 1000;
};

async function pull(db, params) {
  const since = asTime(params.get("since"));
  const lang = params.get("lang");
  const chan = params.get("channel");
  const where = ["updated_at > ?"];
  const args = [since];
  if (lang && lang !== "*") { where.push("lang = ?"); args.push(lang); }
  if (chan && chan !== "*") { where.push("ch = ?"); args.push(chan); }
  const sql = `select * from orb_msg where ${where.join(" and ")} order by updated_at asc limit ${PULL_LIMIT}`;
  const read = async () => {
    const rows = await db.prepare(sql).bind(...args).all();
    const gone = await db
      .prepare(`select id from orb_gone where ts > ? order by ts asc limit ${PULL_LIMIT}`)
      .bind(since)
      .all();
    return {
      messages: (rows.results || []).map(msgOf),
      deleted: (gone.results || []).map((r) => r.id),
    };
  };

  let data = await read();
  /* Держим соединение, пока ничего не появилось: это даёт доставку за секунды,
     не превращая каждый открытый чат в опрос раз в две секунды. Стенные часы
     HTTP-запроса на бесплатном плане не ограничены, а ожидание — не CPU.
     Внутри ожидания нужен только ответ «есть ли новости», поэтому дешёвый probe
     (индекс по updated_at, строк ноль) вместо полного read на каждом шаге.
     Клиент, который не понимает wait, просто получит обычный мгновенный ответ. */
  const probeSql = `select id from orb_msg where ${where.join(" and ")} union all select id from orb_gone where ts > ? limit 1`;
  const deadline = Date.now() + waitMs(params);
  let waitStep = 0;
  while (!data.messages.length && !data.deleted.length && Date.now() < deadline) {
    await sleep(Math.min(WAIT_STEPS_MS[Math.min(waitStep++, WAIT_STEPS_MS.length - 1)], deadline - Date.now()));
    if (Date.now() >= deadline) break;
    const news = await db.prepare(probeSql).bind(...args, since).all();
    if ((news.results || []).length) {
      data = await read();
      break;
    }
  }
  const clients = await beat(db, params);
  return { now: Date.now(), ...data, ...(clients === undefined ? {} : { clients }) };
}

async function push(db, req, body) {
  const msg = (body && body.message) || {};
  const id = asText(msg.id);
  const pageUrl = asText(msg.url);
  const lang = asText(msg.lang);
  const text = asText(msg.text);
  if (!id || !pageUrl || !lang || !text.trim()) return send({ error: "bad_message" }, 400);

  if (pageUrl.startsWith('orbita:channel:')) {
    const cid=pageUrl.slice('orbita:channel:'.length);
    const topic=await db.prepare('SELECT lang FROM orb_channel_topics WHERE id=? AND enabled=1').bind(cid).first();
    if(!topic || topic.lang!==lang) return send({error:'invalid_channel_language'},403);
  }
  const t = Date.now();
  const ip = req.headers.get("cf-connecting-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "no-ip";
  const ch = asText(msg.ch) || `${pageUrl}#${lang}`;
  /* В orb_rate лежит не IP, а sha256 от пары «IP + сутки»: лимит работает так же, но по таблице
     нельзя построить историю, кто с какого адреса что читал. Сутки соли нужны, чтобы и сам
     адрес нельзя было связать с вчерашним днём. */
  const who = (await digest("SHA-256", `${ip}|${Math.floor(t / RATE_DAY_MS)}`)).slice(0, 32);
  const chanBucket = `c|${who}|${ch}`.slice(0, 400);
  const dayBucket = `d|${who}`;

  await db.prepare("delete from orb_rate where bucket = ? and ts < ?").bind(chanBucket, t - RATE_WINDOW_MS).run();
  const recent = await db.prepare("select count(*) as c from orb_rate where bucket = ?").bind(chanBucket).first();
  if (((recent && recent.c) || 0) >= RATE_MAX) {
    return send({ error: "rate_limited", retryInSec: Math.ceil(RATE_WINDOW_MS / 1000) }, 429);
  }
  // суточный потолок по адресу: он же защищает дневной лимит записей D1 от одного человека
  const today = await db
    .prepare("select count(*) as c from orb_rate where bucket = ? and ts > ?")
    .bind(dayBucket, t - RATE_DAY_MS)
    .first();
  if (((today && today.c) || 0) >= RATE_DAY_MAX) {
    return send({ error: "rate_limited", retryInSec: 3600 }, 429);
  }
  await db.prepare("insert into orb_rate (bucket, ts) values (?, ?)").bind(chanBucket, t).run();
  await db.prepare("insert into orb_rate (bucket, ts) values (?, ?)").bind(dayBucket, t).run();

  const gone = await db.prepare("select id from orb_gone where id = ?").bind(id.slice(0, 64)).first();
  if (gone) return send({ ok: true, ignored: "deleted" });

  // в базе остаётся только хэш ключа: сам ключ сервер больше не может ни восстановить, ни переслать
  const secret = asText(body.secret).slice(0, 128);
  const secretHash = secret ? await digest("SHA-256", secret) : null;

  // повторный push того же id ничего не перезаписывает: голоса живут в /api/patch,
  // иначе сосед с устаревшей копией затёр бы чужие голоса
  await db
    .prepare(
      `insert or ignore into orb_msg
       (id, ch, url, lang, ts, updated_at, author, body, links, up, "down", stars, reports, effect, quote, reply_to, secret_hash)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id.slice(0, 64),
      ch.slice(0, 600),
      pageUrl.slice(0, 500),
      lang.slice(0, 8),
      asTime(msg.ts) || t,
      t,
      stringify(msg.author ?? {}),
      text.slice(0, 2000),
      stringify(Array.isArray(msg.links) ? msg.links.slice(0, 4) : []),
      stringify(asList(msg.up)),
      stringify(asList(msg.down)),
      stringify(asList(msg.stars)),
      stringify(asList(msg.reports)),
      msg.effect ? stringify(msg.effect) : null,
      asText(msg.quote).slice(0, 500),
      asText(msg.replyTo).slice(0, 64),
      secretHash
    )
    .run();

  return send({ ok: true, now: Date.now() });
}

// Public activity events, stored by message author alias. A public alias is not
// an authentication credential: do not put private content in these records.
async function activityEvents(db, params) {
  const alias = asText(params.get("alias")).slice(0, 96);
  if (!/^[a-zA-Z0-9_-]{8,96}$/.test(alias)) return send({error:"bad_alias"},400);
  const rows = await db.prepare(`select c.id,c.msg_id,c.url,c.lang,c.stars,c.likes,c.effect_type,c.ts,coalesce(m.body, '') as text
    from orb_event_cards c left join orb_msg m on m.id=c.msg_id
    where c.recipient = ? order by c.ts desc limit 100`).bind(alias).all();
  return send({ok:true,events:rows.results||[],now:Date.now()});
}
async function recordActivityCard(db,row,changes,ts) {
  const recipient = asText(parse(row.author,{}).id).slice(0,96);
  if (!recipient) return;
  const id = (await digest("SHA-256",`${row.id}|${recipient}`)).slice(0,48);
  const current = await db.prepare("select stars,likes,effect_type from orb_event_cards where id=?").bind(id).first();
  const stars = changes.stars ?? (current ? Number(current.stars) : 0);
  const likes = changes.likes ?? (current ? Number(current.likes) : 0);
  const effectType = changes.effectType ?? (current ? current.effect_type : null);
  await db.prepare(`insert into orb_event_cards
    (id,msg_id,recipient,url,lang,stars,likes,effect_type,ts) values(?,?,?,?,?,?,?,?,?)
    on conflict(id) do update set stars=excluded.stars,likes=excluded.likes,
      effect_type=excluded.effect_type,ts=excluded.ts`)
    .bind(id,row.id,recipient,row.url,row.lang,stars,likes,effectType,ts).run();
}

// Массивы объединяются на сервере: клиент присылает свой голос, а не полный список,
// так что два соседа не перетирают друг друга.
async function patch(db, body) {
  const msgId = asText(body.msgId).slice(0, 64);
  if (!msgId) return send({ error: "bad_request" }, 400);

  const gone = await db.prepare("select id from orb_gone where id = ?").bind(msgId).first();
  if (gone) return send({ error: "deleted" });

  const row = await db.prepare("select * from orb_msg where id = ?").bind(msgId).first();
  if (!row) return send({ error: "not_found" }, 404);

  const merged = {};
  /* Массивы объединяются, поэтому ОТСУТСТВИЕ alias'а в body[field] ничего не значит:
     снятую звезду, голос или жалобу надо вычеркнуть явно — списком в body.rm.
     Старый клиент v0.2 rm не присылает, и для него поведение остаётся прежним. */
  const rm = body.rm && typeof body.rm === "object" ? body.rm : {};
  for (const field of ["up", "down", "stars", "reports"]) {
    const base = asList(parse(row[field], []));
    const add = Array.isArray(body[field]) ? asList(body[field]) : [];
    const union = add.length ? Array.from(new Set([...base, ...add])) : base;
    const drop = new Set(asList(rm[field]));
    merged[field] = drop.size ? union.filter((a) => !drop.has(a)) : union;
  }
  const effect = body.effect ? stringify(body.effect) : row.effect;
  const t = Date.now();
  const oldStars = new Set(asList(parse(row.stars,[])));
  const newStars = merged.stars.filter(alias => !oldStars.has(alias));
  const oldUp = new Set(asList(parse(row.up,[])));
  const newUp = merged.up.filter(alias => !oldUp.has(alias));
  const oldEffect = row.effect ? stringify(parse(row.effect,null)) : null;
  const newEffect = body.effect ? stringify(body.effect) : null;

  await db
    .prepare(`update orb_msg set up = ?, "down" = ?, stars = ?, reports = ?, effect = ?, updated_at = ? where id = ?`)
    .bind(
      stringify(merged.up),
      stringify(merged.down),
      stringify(merged.stars),
      stringify(merged.reports),
      effect === null || effect === undefined ? null : String(effect),
      t,
      msgId
    )
    .run();

  const fresh = await db.prepare("select * from orb_msg where id = ?").bind(msgId).first();
  // One persistent notification card per comment. A newer interaction bumps its
  // timestamp; an expired visual effect never clears the last effect caption.
  try {
    const authorId = asText(parse(row.author,{}).id);
    const otherStar = newStars.some(a=>a!==authorId);
    const otherLike = newUp.some(a=>a!==authorId);
    const fx = body.effect;
    const actor = asText(fx?.actor || fx?.from || fx?.by);
    const effectChanged = newEffect && newEffect !== oldEffect && actor && actor !== authorId;
    const effectType = asText(fx?.type);
    const relevantEffect = effectChanged && effectType !== "silence";
    if (otherStar || otherLike || relevantEffect) {
      await recordActivityCard(db,row,{
        stars:merged.stars.length, likes:merged.up.length,
        ...(relevantEffect ? {effectType} : {})
      },t);
    }
  } catch (_) { /* reactions continue if notification storage is unavailable */ }
  return send({ ok: true, message: msgOf(fresh || { ...row, effect, updated_at: t }) });
}

/* Доказать авторство можно только ключом, выданным при публикации. Публичный id автора
   лежит в открытой ленте и ничего не доказывает: с проверкой по нему любой читатель комнаты
   мог удалить чужое сообщение. Для строк, записанных до v0.3.0, ключ в базе отсутствует —
   там остаётся прежняя слабая сверка по автору, и она вымрет сама вместе с этими строками
   через KEEP_DAYS. */
async function remove(db, body) {
  const msgId = asText(body.msgId).slice(0, 64);
  const secret = asText(body.secret);
  const by = asText(body.by).slice(0, 64);
  if (!msgId) return send({ error: "bad_request" }, 400);

  const row = await db.prepare("select author, secret_hash from orb_msg where id = ?").bind(msgId).first();
  if (!row) return send({ ok: true, deleted: msgId }); // уже удалено — идемпотентно

  if (row.secret_hash) {
    if (!secret) return send({ error: "no_ticket" }, 403);
    if ((await digest("SHA-256", secret)) !== row.secret_hash) return send({ error: "not_mine" }, 403);
  } else if (parse(row.author, {}).id !== by) {
    return send({ error: "not_mine" }, 403);
  }

  const t = Date.now();
  await db.prepare("insert or ignore into orb_gone (id, ts) values (?, ?)").bind(msgId, t).run();
  await db.prepare("delete from orb_msg where id = ?").bind(msgId).run();
  return send({ ok: true, deleted: msgId });
}

// Клиент обязан прислать id, уникальный НА ВСЕХ устройствах (алиас + вкладка):
// sender.id в расширениях — это id самого расширения, он у всех одинаковый.
// Комнату новый клиент присылает токеном; старый шлёт url+lang — хэшируем здесь.
async function presence(db, body) {
  const client = asText(body.id).slice(0, 120);
  if (!client) return send({ error: "bad_presence" }, 400);
  let room = asText(body.room);
  if (!room) {
    const pageUrl = asText(body.url).slice(0, 500);
    const lang = asText(body.lang).slice(0, 8);
    if (!pageUrl || !lang) return send({ error: "bad_presence" }, 400);
    room = `${pageUrl}#${lang}`;
  }
  const token = await roomToken(room);
  const t = Date.now();
  await db
    .prepare(
      `insert into orb_pres (client, room, ts) values (?, ?, ?)
       on conflict (client) do update set room = excluded.room, ts = excluded.ts`
    )
    .bind(client, token, t)
    .run();
  // устаревшие строки чистит prune раз в шесть часов — на каждый запрос что-то удалять дорого
  return send({ ok: true, clients: await roomCount(db, token, t), now: t });
}


// Public global rooms use fixed virtual identifiers; arbitrary website URLs are not published.
const GLOBAL_LANGS = ["ru","en","de","fr","es","it","ja","zh"];
const GLOBAL_ROOM = (lang) => `orbita:global:${lang}`;
const GLOBAL_KEY = (lang) => `${GLOBAL_ROOM(lang)}#${lang}`;
async function globalPresence(db, body) {
  const client = asText(body.client).slice(0,80);
  if (!/^u[a-f0-9]{24}$/.test(client)) return send({error:"bad_client"},400);
  const now=Date.now();
  const prev=await db.prepare("select ts from orb_global_pres where client=?").bind(client).first();
  if (!prev || now-prev.ts>=180000) await db.prepare(`insert into orb_global_pres(client,ts) values(?,?) on conflict(client) do update set ts=excluded.ts`).bind(client,now).run();
  const row=await db.prepare("select count(*) as n from orb_global_pres where ts>?").bind(now-300000).first();
  return send({ok:true,online:Number(row?.n||0),now});
}
async function globalStats(db) {
  const now=Date.now();
  const row=await db.prepare("select count(*) as n from orb_global_pres where ts>?").bind(now-300000).first();
  return send({ok:true,online:Number(row?.n||0),now});
}
async function globalRooms(db) {
  const now=Date.now(), rooms={};
  for(const lang of GLOBAL_LANGS) rooms[lang]=await roomCount(db,await roomToken(await roomToken(GLOBAL_KEY(lang))),now);
  return send({ok:true,rooms,now});
}
// Counts unread messages in subscribed conversations from the shared D1 database.
// Only aggregate counts are returned; no subscription list is stored on the server.
async function subscriptionUnread(db, body) {
  const input = Array.isArray(body?.rooms) ? body.rooms.slice(0, 25) : [];
  if (!input.length) return send({ok:true,counts:[]});
  const rooms=[];
  for (const row of input) {
    const url=asText(row?.url).slice(0,2048);
    const lang=asText(row?.lang).toLowerCase();
    const since=Number(row?.since);
    if (!url || !/^[a-z]{2,8}$/.test(lang) || !Number.isFinite(since) || since<0 || since>Date.now()+60000) {
      return send({error:"bad_room"},400);
    }
    rooms.push({url,lang,since:Math.floor(since)});
  }
  // A single indexed aggregate query for up to 25 subscriptions.
  const placeholders=rooms.map(()=>'(?,?,?,?)').join(',');
  const binds=rooms.flatMap((r,i)=>[i,r.url,r.lang,r.since]);
  const sql=`WITH requested(idx,url,lang,since) AS (VALUES ${placeholders})
    SELECT requested.idx AS idx, COUNT(m.id) AS unread
    FROM requested LEFT JOIN orb_msg AS m
      ON m.url=requested.url AND m.lang=requested.lang AND m.ts>requested.since
    GROUP BY requested.idx ORDER BY requested.idx`;
  const result=await db.prepare(sql).bind(...binds).all();
  const counts=Array(rooms.length).fill(0);
  for (const row of result.results||[]) {
    const i=Number(row.idx);
    if (Number.isInteger(i)&&i>=0&&i<counts.length) counts[i]=Number(row.unread||0);
  }
  return send({ok:true,counts,now:Date.now()});
}
async function discoverRooms(db, params) {
  const now=Date.now(), windows={recent:86400000,minute:60000,hour:3600000,day:86400000,week:604800000,month:2592000000,year:31536000000,all:null};
  const period=Object.hasOwn(windows,params.get("period"))?params.get("period"):"day";
  const lang=asText(params.get("lang")).toLowerCase();
  const since=windows[period]===null?0:now-windows[period];
  const rows=[];
  // Include ordinary website conversations. Group by the *exact* page URL + language:
  // the directory links to a real conversation, not to a site's homepage.
  const queryLang=lang&&lang!=="*"?lang:null;
  const result=await db.prepare(`
    SELECT url, lang, COUNT(*) AS messages, MAX(ts) AS latest
    FROM orb_msg
    WHERE ts >= ? AND (? IS NULL OR lang = ?)
    GROUP BY url, lang
    ORDER BY messages DESC, latest DESC
    LIMIT 200
  `).bind(since,queryLang,queryLang).all();
  // Presence is already maintained by /api/presence and pull beats. Fetch it once
  // for all rooms rather than making one D1 query per page in the directory.
  const live = await db.prepare(`
    SELECT room, COUNT(*) AS n FROM orb_pres
    WHERE ts > ? GROUP BY room
  `).bind(now-PRESENCE_TTL_MS).all();
  const presenceMap = new Map((live.results||[]).map(r=>[String(r.room),Number(r.n||0)]));
  const seen=new Set();
  for(const r of result.results||[]){
    const global=PUBLIC_GLOBAL_ID.exec(r.url);
    if(global)continue; // global chats are appended below, exactly once each
    if(!publicSearchUrl(r.url))continue;
    const key=r.url+"#"+r.lang;
    if(seen.has(key))continue;
    seen.add(key);
    let title;
    try{const u=new URL(r.url);title=u.hostname+(u.pathname!=="/"?u.pathname.slice(0,70):"");if(u.hostname.endsWith('youtube.com')&&u.searchParams.get('v')) title=`YouTube · ${u.searchParams.get('v').slice(0,32)}`;}catch{continue;}
    // The extension sends SHA-1 room tokens, and the Worker stores the
    // second hash of that token (same scheme as globalRooms()).
    const token=await roomToken(await roomToken(`${r.url}#${r.lang}`));
    rows.push({url:r.url,lang:r.lang,title,online:presenceMap.get(token)||0,messages:Number(r.messages||0),latest:Number(r.latest||0)});
  }
  // Always list the eight language-wide public chats, including empty ones.
  for(const code of GLOBAL_LANGS.filter(x=>!lang||lang==="*"||lang===x)) {
    const url=GLOBAL_ROOM(code),online=await roomCount(db,await roomToken(await roomToken(GLOBAL_KEY(code))),now);
    const count=await db.prepare("select count(*) as n, max(ts) as latest from orb_msg where url=? and lang=? and ts>=?").bind(url,code,since).first();
    rows.push({url,lang:code,title:`Orbita Global · ${code.toUpperCase()}`,online,messages:Number(count?.n||0),latest:Number(count?.latest||0)});
  }
  // Activity means messages in the selected period; online is displayed but does not
  // allow empty global rooms to outrank busy website conversations.
  rows.sort((a,b)=>b.messages-a.messages||b.online-a.online||b.latest-a.latest);
  return send({ok:true,rooms:rows.slice(0,100),period,now});
}

// Public search only. Do not reveal local, intranet or sensitive-looking page URLs.
function publicSearchUrl(raw){try{const u=new URL(raw);if(!["http:","https:"].includes(u.protocol))return false;const host=u.hostname.toLowerCase();if(host==="localhost"||host.endsWith(".local")||host.endsWith(".internal")||host.endsWith(".invalid")||host.endsWith(".test")||host.endsWith(".localhost")||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)||host.includes(":")||!host.includes("."))return false;if(/\b(login|signin|account|settings|admin|private|inbox|messages|dashboard|billing|checkout|oauth|token|reset-password)\b/i.test(u.pathname))return false;if(u.username||u.password)return false;
  // Query strings can identify legitimate public pages (e.g. YouTube ?v=VIDEO_ID).
  // Suppress credential-bearing and personal URLs from PUBLIC discovery/top.
  const blocked=/^(?:access_?token|id_?token|refresh_?token|token|key|api_?key|auth|authorization|code|state|session|sid|secret|password|passwd|pass|email|e-?mail|phone|user_?id|account_?id|signature|sig|jwt|redirect_uri|callback|return_?url|payment|invoice|order|address)$/i;
  for(const [k,v] of u.searchParams){if(blocked.test(k)||k.length>60||v.length>250||/(?:bearer\s|eyJ[A-Za-z0-9_-]{30,}|@|[\r\n])/i.test(v))return false;}
  if(u.href.length>1000)return false;
  return true;}catch{return false;}}
function searchCount(value){try{const parsed=JSON.parse(value||"[]");return Array.isArray(parsed)?parsed.length:0;}catch{return 0;}}
function searchAuthor(value){try{const a=JSON.parse(value||"{}");return {id:String(a.id||"anon").slice(0,100),name:String(a.name||"").slice(0,80),anon:!!a.anon,avatar:String(a.avatar||"").slice(0,100000)};}catch{return {id:"anon",anon:true};}}
// Global virtual room IDs are explicitly public. Legacy IDs remain readable during rollout.
const PUBLIC_GLOBAL_ID = /^(?:orbita:global:|https:\/\/global\.orbita\.invalid\/)(ru|en|de|fr|es|it|ja|zh)$/;
// Public server-side Top. Only public website and global rooms are exposed.
// Ranking uses the current D1 vote state, not each browser's local cache.
async function publicTop(db,params){
  const periods={hour:3600000,day:86400000,week:604800000,month:2592000000,year:31536000000,all:null};
  const requested=asText(params.get('period')).toLowerCase();
  const period=Object.hasOwn(periods,requested)?requested:'week';
  const lang=asText(params.get('lang')).toLowerCase();
  if(lang&&lang!=='*'&&!/^[a-z]{2,8}$/.test(lang))return send({error:'bad_language'},400);
  const cutoff=periods[period]===null?0:Date.now()-periods[period];
  // JSON arrays are maintained by the existing message patch endpoint. Guard old/invalid rows.
  const n=x=>`CASE WHEN json_valid(${x}) AND json_type(${x})='array' THEN json_array_length(${x}) ELSE 0 END`;
  const up=n('up'),down=n('"down"'),stars=n('stars'),reports=n('reports');
  const score=`(${up}-${down}+2*${stars})`;
  const rows=await db.prepare(`SELECT id,url,lang,ts,body,links,up,"down",stars,reports,${score} AS rank_score
    FROM orb_msg WHERE ts>=? AND (?='*' OR lang=?)
    AND ${reports}<3 AND ${down}<10 AND ${score}>0
    ORDER BY rank_score DESC, ts DESC LIMIT 200`).bind(cutoff,lang||'*',lang||'*').all();
  const result=[];
  for(const r of rows.results||[]){
    const global=PUBLIC_GLOBAL_ID.exec(r.url);
    if(!global&&!publicSearchUrl(r.url))continue;
    result.push({id:r.id,url:global?GLOBAL_ROOM(global[1]):r.url,lang:r.lang,ts:r.ts,
      text:r.body||'',links:parse(r.links,[]).slice(0,3),votes:searchCount(r.up)-searchCount(r.down),
      down:searchCount(r.down),stars:searchCount(r.stars),rank:Number(r.rank_score)||0});
    if(result.length>=100)break;
  }
  return send({ok:true,source:'server',period,rows:result,retentionDays:KEEP_DAYS,now:Date.now()});
}
async function searchPublic(db,params){
  const q=asText(params.get("q")).trim().slice(0,100);
  if(q.length<2)return send({ok:true,results:[]});
  const escaped=q.replace(/[%_]/g, "");
  const rows=await db.prepare(`select id,url,lang,body,author,up,"down",stars,ts from orb_msg where body like ? order by ts desc limit 150`).bind("%"+escaped+"%").all();
  const results=[];
  for(const r of rows.results||[]){
    const global=PUBLIC_GLOBAL_ID.exec(r.url);
    if(!global&&!publicSearchUrl(r.url))continue;
    const resultUrl=global?GLOBAL_ROOM(global[1]):r.url;
    results.push({id:r.id,url:resultUrl,title:global?"Orbita Global · "+global[1].toUpperCase():new URL(r.url).hostname,lang:r.lang,body:r.body,author:searchAuthor(r.author),up:searchCount(r.up),down:searchCount(r.down),stars:searchCount(r.stars),ts:r.ts,message:msgOf(r)});
    if(results.length>=50)break;
  }
  return send({ok:true,results});
}


// Owner authentication: HMAC-signed, 12-hour tokens. Password exists only as Worker Secret.
const ADMIN_TTL = 12 * 60 * 60 * 1000;
async function adminMac(secret, data) {
  const k = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(data)))).map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function adminValid(env, token) {
  if(!env.ORBITA_ADMIN_KEY || !token || typeof token!=='string') return false;
  const m=/^(\d{13})\.([a-f0-9]{64})$/.exec(token);
  if(!m || Number(m[1])<Date.now() || Number(m[1])>Date.now()+ADMIN_TTL) return false;
  const expected=await adminMac(env.ORBITA_ADMIN_KEY,'orbita-admin:'+m[1]);
  let d=0;for(let i=0;i<64;i++)d|=expected.charCodeAt(i)^m[2].charCodeAt(i);
  return d===0;
}
async function adminLogin(env, body) {
  if(!env.ORBITA_ADMIN_KEY) return send({error:'admin_not_configured'},503);
  const supplied=asText(body.key);
  if(!supplied || supplied.length>512) return send({error:'invalid_key'},403);
  // Compare fixed-length hashes instead of the plaintext key.
  const a=await digest('SHA-256',supplied),b=await digest('SHA-256',env.ORBITA_ADMIN_KEY);
  let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);
  if(d) return send({error:'invalid_key'},403);
  const expiry=String(Date.now()+ADMIN_TTL);
  return send({ok:true,token:expiry+'.'+await adminMac(env.ORBITA_ADMIN_KEY,'orbita-admin:'+expiry),expires:Number(expiry)});
}
async function adminAudit(db, action, target, amount) {
  await db.prepare('insert into orb_admin_log (ts,action,target,amount) values (?,?,?,?)').bind(Date.now(),action,target,amount).run();
}
async function adminRemoveOne(db, msgId) {
  const row=await db.prepare('select id from orb_msg where id=?').bind(msgId).first();
  if(!row)return 0;
  const ts=Date.now();
  await db.batch([
    db.prepare('insert or ignore into orb_gone (id,ts) values (?,?)').bind(msgId,ts),
    db.prepare('delete from orb_event_cards where msg_id=?').bind(msgId),
    db.prepare('delete from orb_events where msg_id=?').bind(msgId),
    db.prepare('delete from orb_msg where id=?').bind(msgId)
  ]);
  return 1;
}
/* Admin vote is verified server-side and counts as ten weighted approvals.
   Nine derived slots supplement the admin's ordinary signed-in vote.
   Slots are stable across renewed sessions, and are removed on undo/switch. */
async function adminWeightedVote(db,env,body){
  if(!await adminValid(env,body.token))return send({error:'admin_unauthorized'},403);
  const id=asText(body.msgId).slice(0,64);
  const alias=asText(body.alias).slice(0,200);
  const dir=body.dir==='up'||body.dir==='down'?body.dir:null;
  if(!id||!alias)return send({error:'bad_request'},400);
  const r=await db.prepare('select up, "down" from orb_msg where id=?').bind(id).first();
  if(!r)return send({error:'not_found'},404);
  const stem=await digest('SHA-256',String(env.ORBITA_ADMIN_KEY)+'|admin-vote|'+id);
  const extras=Array.from({length:9},(_,i)=>'admin-weight-'+stem.slice(0,40)+'-'+i);
  const owned=new Set([alias,...extras]);
  const up=asList(parse(r.up,[])).filter(x=>!owned.has(x));
  const down=asList(parse(r.down,[])).filter(x=>!owned.has(x));
  if(dir==='up')up.push(alias,...extras);
  if(dir==='down')down.push(alias,...extras);
  await db.prepare('update orb_msg set up=?,"down"=?,updated_at=? where id=?')
    .bind(stringify(up),stringify(down),Date.now(),id).run();
  await adminAudit(db,'weighted-vote',id,dir==='up'?10:dir==='down'?-10:0);
  return send({ok:true,score:up.length-down.length,myVote:dir});
}

async function adminAction(db,env,path,body) {
  if(path.endsWith('/api/admin/login'))return adminLogin(env,body);
  if(!await adminValid(env,body.token))return send({error:'admin_unauthorized'},403);
  if(path.endsWith('/api/admin/status'))return send({ok:true,admin:true});
  if(path.endsWith('/api/admin/vote'))return await adminWeightedVote(db,env,body);
  if(path.endsWith('/api/admin/delete')) {
    const id=asText(body.msgId).slice(0,64);
    if(!id)return send({error:'bad_request'},400);
    const count=await adminRemoveOne(db,id);
    await adminAudit(db,'delete',id,count);
    return send({ok:true,deleted:id,count});
  }
  const url=asText(body.url),lang=asText(body.lang);
  if(!url || url.length>2048 || !lang || lang.length>8)return send({error:'bad_request'},400);
  const qty=Number(body.quantity), unit=asText(body.unit);
  const multipliers={minutes:60000,hours:3600000,days:86400000};
  const all=body.all===true;
  if(!all && (!Number.isSafeInteger(qty)||qty<1||qty>100000||!multipliers[unit]))return send({error:'bad_period'},400);
  const cutoff=all?0:Date.now()-qty*multipliers[unit];
  if(!Number.isFinite(cutoff)||cutoff<0)return send({error:'bad_period'},400);
  const where='url=? and lang=? and ts>=?';
  if(path.endsWith('/api/admin/preview')) {
    const r=await db.prepare('select count(*) as n from orb_msg where '+where).bind(url,lang,cutoff).first();
    return send({ok:true,count:Number(r?.n||0)});
  }
  if(path.endsWith('/api/admin/clear')) {
    if(body.confirm!=='УДАЛИТЬ')return send({error:'confirmation_required'},400);
    // Chunked deletion: bound each request to avoid Worker CPU and D1 limits.
    const r=await db.prepare('select id from orb_msg where '+where+' order by ts desc limit 100').bind(url,lang,cutoff).all();
    const ids=(r.results||[]).map(x=>x.id);
    for(const id of ids)await adminRemoveOne(db,id);
    await adminAudit(db,'clear',url+'#'+lang,ids.length);
    return send({ok:true,count:ids.length,ids,more:ids.length===100});
  }
  return send({error:'not_found'},404);
}

// CHANNELS: matches the CURRENT manually created Cloudflare D1 schema.
// Canonical category names are Russian; all eight clients can display translated labels.
const CHANNEL_ROOM = id => 'orbita:channel:' + id;
const CHANNEL_LANGS = new Set(['ru','en','de','fr','es','it','ja','zh']);
const cleanChannelLang = (v) => String(v || '').trim().toLowerCase();
const channelLangAllowed = v => CHANNEL_LANGS.has(v);

async function channelCatalog(db, params) {
  const lang = cleanChannelLang(params.get('lang') || '*');
  if (lang !== '*' && !channelLangAllowed(lang)) return send({error:'invalid_language'},400);
  const categories = await db.prepare(`SELECT id, group_name AS grp, name, sort_order AS sort
    FROM orb_channel_categories WHERE enabled=1 ORDER BY sort_order,id LIMIT 200`).all();
  const category = String(params.get('category') || '').slice(0,100);
  if (!category) {
    // One aggregate query for all categories; counts respect the selected language.
    const totals=await db.prepare(`SELECT t.category_id AS id, COUNT(m.id) AS messages
      FROM orb_channel_topics t LEFT JOIN orb_msg m
      ON m.url=('orbita:channel:'||t.id) AND m.lang=t.lang
      WHERE t.enabled=1 AND (?='*' OR t.lang=?)
      GROUP BY t.category_id`).bind(lang,lang).all();
    const counts=new Map((totals.results||[]).map(r=>[String(r.id),Number(r.messages||0)]));
    return send({ok:true,categories:(categories.results||[]).map(c=>({...c,messages:counts.get(String(c.id))||0}))});
  }
  const cat = (categories.results||[]).find(x=>x.id===category);
  if (!cat) return send({error:'category_not_found'},404);
  // One grouped SQL query (rather than a separate COUNT query per topic).
  const topics = await db.prepare(`SELECT t.id,t.title,t.lang,t.created_at,COUNT(m.id) AS messages
    FROM orb_channel_topics t LEFT JOIN orb_msg m
      ON m.url=('orbita:channel:'||t.id) AND m.lang=t.lang
    WHERE t.category_id=? AND t.enabled=1 AND (?='*' OR t.lang=?)
    GROUP BY t.id ORDER BY t.created_at DESC LIMIT 100`).bind(category,lang,lang).all();
  return send({ok:true,category,topics:(topics.results||[]).map(t=>({...t,url:CHANNEL_ROOM(t.id),messages:Number(t.messages||0),online:null}))});
}

async function createChannelTopic(db,req,body) {
  const category=String(body.category||'').slice(0,100);
  const title=String(body.title||'').trim().replace(/\s+/g,' ').slice(0,90);
  const lang=cleanChannelLang(body.lang);
  if (!channelLangAllowed(lang)) return send({error:'invalid_language'},400);
  if (title.length<3 || title.length>90) return send({error:'invalid_topic'},400);
  const cat=await db.prepare('SELECT id FROM orb_channel_categories WHERE id=? AND enabled=1').bind(category).first();
  if(!cat)return send({error:'category_not_found'},404);
  const ip=req.headers.get('cf-connecting-ip')||'unknown';
  const now=Date.now(), bucket='topic|'+(await digest('SHA-256',ip+'|'+Math.floor(now/86400000))).slice(0,24);
  const rate=await db.prepare('SELECT count(*) AS n FROM orb_rate WHERE bucket=? AND ts>?').bind(bucket,now-86400000).first();
  if(Number(rate?.n||0)>=5)return send({error:'topic_limit_daily'},429);
  const dupe=await db.prepare(`SELECT id FROM orb_channel_topics WHERE category_id=? AND lang=? AND lower(title)=lower(?) AND enabled=1 LIMIT 1`).bind(category,lang,title).first();
  if(dupe)return send({error:'topic_exists',id:dupe.id},409);
  const id=crypto.randomUUID().replace(/-/g,'').slice(0,20);
  const who=String(body.created_by||body.creator||'').slice(0,96);
  await db.prepare(`INSERT INTO orb_channel_topics(id,category_id,title,lang,created_by,created_at,updated_at,enabled) VALUES(?,?,?,?,?,?,?,1)`).bind(id,category,title,lang,who,now,now).run();
  await db.prepare('INSERT INTO orb_rate(bucket,ts) VALUES(?,?)').bind(bucket,now).run();
  return send({ok:true,id,url:CHANNEL_ROOM(id),title,category,lang});
}

async function adminChannelCategory(db,env,body) {
  if(!await adminValid(env,body.token))return send({error:'admin_unauthorized'},403);
  if(String(body.action||'')==='list'){
    const categories=await db.prepare(`SELECT id,group_name AS grp,name,sort_order AS sort,enabled
      FROM orb_channel_categories ORDER BY sort_order,id LIMIT 500`).all();
    return send({ok:true,categories:categories.results||[]});
  }
  const action=String(body.action||''),id=String(body.id||'').slice(0,100);
  const name=String(body.name||'').trim().slice(0,80),group=String(body.group||'Тематика').trim().slice(0,80);
  if(action==='add'){
    if(name.length<2)return send({error:'invalid_name'},400);
    const newId='custom-'+crypto.randomUUID().replace(/-/g,'').slice(0,20);
    await db.prepare(`INSERT INTO orb_channel_categories(id,group_name,name,sort_order,enabled,created_at) VALUES(?,?,?,?,1,?)`).bind(newId,group,name,Math.max(0,Math.min(10000,Number(body.sort)||200)),Date.now()).run();
    return send({ok:true,id:newId});
  }
  if(!id)return send({error:'bad_category'},400);
  if(action==='rename'&&name.length>=2){await db.prepare('UPDATE orb_channel_categories SET name=?,group_name=? WHERE id=?').bind(name,group,id).run();return send({ok:true});}
  if(action==='sort'){await db.prepare('UPDATE orb_channel_categories SET sort_order=? WHERE id=?').bind(Math.max(0,Math.min(10000,Number(body.sort)||0)),id).run();return send({ok:true});}
  if(action==='hide'||action==='show'){await db.prepare('UPDATE orb_channel_categories SET enabled=? WHERE id=?').bind(action==='show'?1:0,id).run();return send({ok:true});}
  return send({error:'bad_action'},400);
}

// Administrative topic moderation. Soft-delete preserves messages and stable IDs.
async function adminChannelTopic(db,env,body){
  if(!await adminValid(env,body.token))return send({error:'admin_unauthorized'},403);
  const id=String(body.id||'');
  if(!/^[a-f0-9]{20}$/.test(id))return send({error:'bad_topic'},400);
  const action=String(body.action||'');
  const present=await db.prepare('SELECT id,title FROM orb_channel_topics WHERE id=?').bind(id).first();
  if(!present)return send({error:'topic_not_found'},404);
  if(action==='rename'){
    const title=String(body.title||'').trim().replace(/\s+/g,' ');
    if(title.length<3||title.length>90)return send({error:'invalid_title'},400);
    const dupe=await db.prepare(`SELECT 1 FROM orb_channel_topics a JOIN orb_channel_topics b ON b.id=? WHERE a.category_id=b.category_id AND a.lang=b.lang AND lower(a.title)=lower(?) AND a.enabled=1 AND a.id<>? LIMIT 1`).bind(id,title,id).first();
    if(dupe)return send({error:'topic_exists'},409);
    await db.prepare('UPDATE orb_channel_topics SET title=?,updated_at=? WHERE id=?').bind(title,Date.now(),id).run();
    await adminAudit(db,'topic_rename',id,1);
    return send({ok:true,id,title});
  }
  if(action==='hide'||action==='show'){
    await db.prepare('UPDATE orb_channel_topics SET enabled=?,updated_at=? WHERE id=?').bind(action==='show'?1:0,Date.now(),id).run();
    await adminAudit(db,'topic_'+action,id,1);
    return send({ok:true,id,enabled:action==='show'});
  }
  return send({error:'bad_action'},400);
}

/* Orbita media storage adapter for the EXISTING Cloudflare Worker (KV with 7-day TTL).
 * Hook handleMediaRequest into the live worker's router BEFORE /api/push etc.
 * Workers KV key prefixes: photos/, videos/, music/. Each file expires after 7 days.
 * This module is NOT deployed by the Android APK workflow.
 */
const LIMIT=1048576;
const MIME={
 'image/jpeg':['photos','jpg'],'image/png':['photos','png'],
 'image/webp':['photos','webp'],'video/mp4':['videos','mp4'],
 'video/webm':['videos','webm'],'audio/mpeg':['music','mp3'],
 'audio/ogg':['music','ogg'],'audio/mp4':['music','m4a']
};
const filePath=/^\/api\/media\/(photos|videos|music)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpg|png|webp|mp4|webm|mp3|ogg|m4a)$/i;
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,HEAD,POST,OPTIONS'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const matchMagic=(kind,bytes)=>{
 const b=bytes,ascii=(from,n)=>String.fromCharCode(...b.slice(from,from+n));
 switch(kind){
  case 'image/jpeg':return b[0]===255&&b[1]===216&&b[2]===255;
  case 'image/png':return b[0]===137&&ascii(1,3)==='PNG';
  case 'image/webp':return ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP';
  case 'video/mp4':return ascii(4,4)==='ftyp';
  case 'video/webm':return b[0]===26&&b[1]===69&&b[2]===223&&b[3]===163;
  case 'audio/mpeg':return ascii(0,3)==='ID3'||b[0]===255&&(b[1]&224)===224;
  case 'audio/ogg':return ascii(0,4)==='OggS';
  case 'audio/mp4':return ascii(4,4)==='ftyp';
  default:return false;
 }
};
function decodeBase64(s){
 if(typeof s!=='string'||s.length>1400000||s.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))return null;
 try{const bin=atob(s);if(!bin.length||bin.length>LIMIT)return null;
  const bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);return bytes;
 }catch{return null}
}
async function handleMediaRequest(request,env){
 const path=new URL(request.url).pathname;
 if(!path.startsWith('/api/media'))return null;
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 if(!env.MEDIA || typeof env.MEDIA.getWithMetadata!=='function')return json({error:'media_storage_unconfigured'},503);
 if(path==='/api/media'&&request.method==='POST'){
  // Anonymous upload MUST have abuse controls before being enabled publicly.
  if(!env.DB)return json({error:'media_rate_limit_unconfigured'},503);
  // Enforce anonymous upload quotas using the existing D1 orb_rate table.
  // No additional bindings or database migrations beyond MEDIA are required.
  const now=Date.now();
  const remote=request.headers.get('CF-Connecting-IP')||'unknown';
  const hash=(await digest('SHA-256',remote+'|'+Math.floor(now/86400000)+'|media')).slice(0,32);
  const bucket='media|'+hash;
  const recent=await env.DB.prepare('SELECT count(*) AS n FROM orb_rate WHERE bucket=? AND ts>?').bind(bucket,now-300000).first();
  if(Number(recent?.n||0)>=8)return json({error:'too_many_uploads'},429);
  const daily=await env.DB.prepare('SELECT count(*) AS n FROM orb_rate WHERE bucket=? AND ts>?').bind(bucket,now-86400000).first();
  if(Number(daily?.n||0)>=50)return json({error:'too_many_uploads'},429);
  await env.DB.prepare('INSERT INTO orb_rate(bucket,ts) VALUES(?,?)').bind(bucket,now).run();
  if(Number(request.headers.get('Content-Length')||0)>1408000)return json({error:'file_too_large'},413);
  let body;try{body=await request.json()}catch{return json({error:'invalid_json'},400)}
  const mime=String(body?.mime||'').toLowerCase();
  const spec=MIME[mime];
  if(!spec)return json({error:'unsupported_media_type'},415);
  const bytes=decodeBase64(body?.base64);
  if(!bytes)return json({error:'file_too_large_or_invalid'},413);
  if(!matchMagic(mime,bytes))return json({error:'invalid_media_signature'},415);
  const original=String(body?.name||'attachment').normalize('NFKC').replace(/[^\w.\- ]/g,'_').slice(0,90);
  const key=spec[0]+'/'+crypto.randomUUID()+'.'+spec[1];
  const expiresAt=Date.now()+604800000;
  await env.MEDIA.put(key,bytes.slice().buffer,{expirationTtl:604800,metadata:{mime,name:original,expiresAt}});
  return json({kind:spec[0],key,url:new URL('/api/media/'+key,request.url).href,
    size:bytes.byteLength,mime,name:original,expiresAt});
 }
 const m=filePath.exec(path);
 if(!m||!['GET','HEAD'].includes(request.method))return json({error:'not_found'},404);
 const key=m[1]+'/'+m[2]+'.'+m[3];
 const record=await env.MEDIA.getWithMetadata(key,{type:'arrayBuffer',cacheTtl:30});
 if(!record?.value)return json({error:'media_expired_or_unavailable'},410);
 if(typeof record.metadata?.expiresAt==='number'&&Date.now()>=record.metadata.expiresAt)return json({error:'media_expired_or_unavailable'},410);
 const full=record.value;
 const headers=new Headers(cors);
 headers.set('Content-Type',record.metadata?.mime||'application/octet-stream');
 headers.set('Content-Disposition','inline');
 headers.set('Cache-Control','private, no-store');
 headers.set('Accept-Ranges','bytes');
 headers.set('X-Content-Type-Options','nosniff');
 headers.set('Cross-Origin-Resource-Policy','cross-origin');
 const total=full.byteLength;
 let start=0,end=total-1,status=200;
 const range=request.headers.get('Range');
 if(range){
  const p=/^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if(!p)return new Response(null,{status:416,headers:{...cors,'Content-Range':'bytes */'+total}});
  start=p[1]?Number(p[1]):Math.max(0,total-Number(p[2]||0));
  end=p[1]?(p[2]?Math.min(total-1,Number(p[2])):total-1):total-1;
  if(start>end||start>=total||!Number.isSafeInteger(start)||!Number.isSafeInteger(end))
   return new Response(null,{status:416,headers:{...cors,'Content-Range':'bytes */'+total}});
  status=206;headers.set('Content-Range','bytes '+start+'-'+end+'/'+total);
 }
 headers.set('Content-Length',String(end-start+1));
 return new Response(request.method==='HEAD'?null:full.slice(start,end+1),{status,headers});
}


async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  // Isolated media routing: leave all existing Orbita PC and Android chat API routes unchanged.
  const mediaResponse=await handleMediaRequest(req,env);
  if(mediaResponse)return mediaResponse;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!env || !env.DB) return send({ error: "not_configured" }, 500);

  // раз в 6 часов кто-нибудь из запросов чистит хвосты (бесплатный план cron не вечен)
  const t = Date.now();
  if (t - lastPrune > 6 * 3_600_000) {
    lastPrune = t;
    ctx.waitUntil(prune(env.DB, KEEP_DAYS).catch(() => {}));
  }

  const db = env.DB;

  if (path === "/" || path.endsWith("/")) {
    const h = await health(db, ctx);
    return new Response(`Orbita sync server\nmessages: ${h.messages}\nonline: ${h.clients}\n`, {
      headers: { ...CORS, "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (path.endsWith('/api/channels') && req.method==='GET') return await channelCatalog(db,url.searchParams);
  if (path.endsWith("/api/health")) return send(await health(db, ctx));
  if (path.endsWith("/api/global-stats")) return await globalStats(db);
  if (path.endsWith("/api/global-rooms")) return await globalRooms(db);
  if (path.endsWith("/api/discover")) return await discoverRooms(db,url.searchParams);
  if (path.endsWith("/api/top")) {if(req.method!=="GET")return send({error:"method_not_allowed"},405);return await publicTop(db,url.searchParams);}
  if (path.endsWith("/api/search")) return await searchPublic(db,url.searchParams);
  if (path.endsWith("/api/events")) return await activityEvents(db,url.searchParams);
  if (path.endsWith("/api/subscriptions/unread")) {
    if (req.method !== "POST") return send({error:"method_not_allowed"},405);
    let body;try{body=await req.json();}catch{return send({error:"bad_json"},400);}
    return await subscriptionUnread(db,body);
  }
  if (path.endsWith("/api/pull")) return send(await pull(db, url.searchParams));

  const isWrite = ["/api/channels/topic", "/api/admin/channels/category", "/api/admin/channels/topic", "/api/admin/login", "/api/admin/status", "/api/admin/delete", "/api/admin/vote", "/api/admin/preview", "/api/admin/clear", "/api/global-presence", "/api/presence", "/api/push", "/api/patch", "/api/delete"].some((p) => path.endsWith(p));
  if (!isWrite) return send({ error: "not_found", path }, 404);
  if (req.method !== "POST") return send({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return send({ error: "bad_json" }, 400);
  }
  body = body || {};

  if(path.endsWith('/api/channels/topic'))return await createChannelTopic(db,req,body);
  if(path.endsWith('/api/admin/channels/category'))return await adminChannelCategory(db,env,body);
  if(path.endsWith('/api/admin/channels/topic'))return await adminChannelTopic(db,env,body);
  if(path.includes("/api/admin/"))return await adminAction(db,env,path,body);
  if (path.endsWith("/api/global-presence")) return await globalPresence(db,body);
  if (path.endsWith("/api/presence")) return await presence(db, body);
  if (path.endsWith("/api/push")) return await push(db, req, body);
  if (path.endsWith("/api/patch")) return await patch(db, body);
  return await remove(db, body);
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await handle(req, env, ctx);
    } catch (err) {
      return send({ error: "server_error", detail: String((err && err.message) || err) }, 500);
    }
  },
};