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
const WAIT_STEP_MS = 2_000;
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
  const probeSql = `select id from orb_msg where ${where.join(" and ")} union all select id from orb_gone where ts > ?`;
  const deadline = Date.now() + waitMs(params);
  while (!data.messages.length && !data.deleted.length && Date.now() < deadline) {
    await sleep(Math.min(WAIT_STEP_MS, deadline - Date.now()));
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

/* Global presence is deliberately separate from room presence.
   No page URL, room, browsing history or raw device ID is stored here. */
async function globalPresence(db, body) {
  const client = asText(body.client).slice(0, 80);
  if (!/^u[a-f0-9]{24}$/.test(client)) return send({ error: "bad_client" }, 400);
  const now = Date.now();
  await db.prepare(`insert into orb_global_pres (client, ts) values (?, ?)
    on conflict(client) do update set ts = excluded.ts`).bind(client, now).run();
  const row = await db.prepare("select count(*) as total from orb_global_pres where ts > ?")
    .bind(now - 300000).first();
  return send({ ok: true, online: Number(row?.total || 0), now });
}

async function globalStats(db) {
  const now = Date.now();
  const row = await db.prepare("select count(*) as total from orb_global_pres where ts > ?")
    .bind(now - 300000).first();
  return send({ ok: true, online: Number(row?.total || 0), now });
}

/* Fixed virtual URLs: these are room identifiers, not navigable external websites. */
const GLOBAL_LANGS = ["ru", "en", "de", "fr", "es", "it", "ja", "zh"];
async function globalRooms(db) {
  const now = Date.now();
  const out = {};
  for (const lang of GLOBAL_LANGS) {
    const room = `https://global.orbita.invalid/${lang}#${lang}`;
    out[lang] = await roomCount(db, await roomToken(await roomToken(room)), now);
  }
  return send({ ok: true, rooms: out, now });
}

async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;

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
  if (path.endsWith("/api/health")) return send(await health(db, ctx));
  if (path.endsWith("/api/global-stats")) return await globalStats(db);
  if (path.endsWith("/api/global-rooms")) return await globalRooms(db);
  if (path.endsWith("/api/pull")) return send(await pull(db, url.searchParams));

  const isWrite = ["/api/global-presence", "/api/presence", "/api/push", "/api/patch", "/api/delete"].some((p) => path.endsWith(p));
  if (!isWrite) return send({ error: "not_found", path }, 404);
  if (req.method !== "POST") return send({ error: "method_not_allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return send({ error: "bad_json" }, 400);
  }
  body = body || {};

  if (path.endsWith("/api/global-presence")) return await globalPresence(db, body);
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
