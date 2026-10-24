// Транспорт Orbita прогоняется против НАСТОЯЩЕГО воркера: тот же worker.js и та же
// schema.sql на node:sqlite как поддельном D1, плюс настоящий background.js с заглушками
// chrome.*. Так проверяется то, что иначе видно только двумя браузерами и секундомером:
// сообщение уходит на сервер сразу, доезжает до соседа за секунды, а «онлайн» считается
// только по комнате, в которую человек действительно смотрит.
// Run: node tests/test_transport.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SERVER = "https://orbita.test"; // ни одного настоящего запроса: fetch перехвачен

/* ---------- поддельный Cloudflare: worker + D1 ---------- */
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../server/cloudflare/schema.sql", import.meta.url), "utf8"));
const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
const dbEnv = {
  DB: {
    prepare(sql) {
      let args = [];
      const api = {
        bind(...v) { args = v.map(norm); return api; },
        async all() { return { results: sqlite.prepare(sql).all(...args) }; },
        async first() { const rows = sqlite.prepare(sql).all(...args); return rows.length ? rows[0] : null; },
        async run() {
          const r = sqlite.prepare(sql).run(...args);
          return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        },
      };
      return api;
    },
  },
};
const workerCtx = { waitUntil: (p) => p.catch(() => {}) };
const { default: worker } = await import("../server/cloudflare/worker.js");

const requests = [];
let pullAnswersClients = true; // false — «сервер старше»: мгновенный ответ без поля clients
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(input);
  const record = { path: u.pathname + u.search, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
  requests.push(record);
  if (u.origin !== SERVER) throw new Error(`клиент полез наружу: ${u.origin}`);
  if (!record.body && /\/api\/pull/.test(u.pathname) && !pullAnswersClients) {
    return new Response(JSON.stringify({ now: Date.now(), messages: [], deleted: [] }), {
      headers: { "content-type": "application/json" },
    });
  }
  return worker.fetch(new Request(input, init), dbEnv, workerCtx);
};

/* ---------- поддельный Chrome ---------- */
const mem = {};
/* Вкладки: openSite их ищет, создаёт и насылает в них оверлей, а tests прокручивают
   onUpdated вручную. unroutable — страница, которая не принимает скрипт extensions. */
const opened = [];
const createdTabs = [];
const tabUpdated = [];
let fakeTabs = [];
let nextTabId = 500;
let unroutable = false;
globalThis.chrome = {
  storage: {
    local: {
      async get(key) { return key in mem ? { [key]: JSON.parse(JSON.stringify(mem[key])) } : {}; },
      async set(obj) { for (const [k, v] of Object.entries(obj)) mem[k] = JSON.parse(JSON.stringify(v)); },
    },
  },
  runtime: {
    sendMessage: () => Promise.resolve(),
    getURL: (p) => `chrome-extension://orbita-ext/${p}`,
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  action: { setBadgeText() {}, onClicked: { addListener() {} } },
  commands: { onCommand: { addListener() {} } },
  contextMenus: { create() {}, onClicked: { addListener() {} } },
  tabs: {
    query: async () => fakeTabs,
    create: (opts) => {
      opened.push(`create:${opts.url}`);
      const tab = { id: nextTabId++, url: opts.url, status: "loading", windowId: 3 };
      createdTabs.push(tab);
      return Promise.resolve(tab);
    },
    update: async (id, patch) => {
      opened.push(`update:${id}:${JSON.stringify(patch)}`);
      return { id };
    },
    sendMessage: async (id, msg) => {
      if (unroutable) throw new Error("no receiver on this page");
      opened.push(`send:${id}:${msg.type}`);
      return { ok: true, open: msg.type !== "overlay:ping" };
    },
    onRemoved: { addListener() {} },
    onUpdated: { addListener(fn) { tabUpdated.push(fn); } },
    onActivated: { addListener() {} },
  },
  windows: {
    update: async (id, patch) => {
      opened.push(`window:${id}:${JSON.stringify(patch)}`);
      return { id };
    },
  },
  scripting: {
    executeScript: async ({ target }) => {
      if (unroutable) throw new Error("cannot inject here");
      opened.push(`inject:${target.tabId}`);
    },
  },
};

const store = await import("../extension/store.js");
let passed = 0;
const ok = async (label, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${label}`);
  } catch (err) {
    console.log(`FAIL  ${label}: ${err.message}`);
    process.exitCode = 1;
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await wait(50);
  }
  throw new Error(`${label}: не дождались за ${ms} мс`);
}

/* ---------- адрес сервера ---------- */
await ok("the shared server is baked into the build", () => {
  assert.equal(store.SERVER_URL, "https://orbita.thenewimperium.workers.dev");
  assert.equal(store.DEFAULT_SETTINGS.serverUrl, store.SERVER_URL);
});

await ok("with no stored address the built-in server is used", async () => {
  assert.equal((await store.getSettings()).serverUrl, store.SERVER_URL);
});

await ok("a remembered address is cleaned of /api/health and slashes", async () => {
  assert.equal((await store.setSettings({ serverUrl: `${SERVER}/api/health/` })).serverUrl, SERVER);
});

await ok("switching sync off really goes local", async () => {
  assert.equal((await store.setSettings({ syncOn: false })).serverUrl, "");
  await store.setSettings({ syncOn: true, serverUrl: SERVER });
  assert.equal((await store.getSettings()).serverUrl, SERVER);
});

/* ---------- фоновый скрипт ---------- */
const { testOnly } = await import("../extension/background.js");
const ask = (tabId, msg) => testOnly.handle(msg, { id: "orbita-ext", tab: { id: tabId } });
const ROOM = "https://room.test/page";
const room = (over = {}) => ({ url: ROOM, lang: "ru", ch: `${ROOM}#ru`, ...over });

let mineId = "";
await ok("msg:post pushes to the server at once, not on the next timer", async () => {
  const res = await ask(1, { cmd: "msg:post", ...room({ text: "привет из вкладки 1" }) });
  assert.ok(res && res.message, `postMessage вернул ${JSON.stringify(res)}`);
  mineId = res.message.id;
  await until("сообщение не легло на сервер", () =>
    Promise.resolve(sqlite.prepare("select body from orb_msg where id = ?").get(mineId) !== undefined)
  );
  assert.equal(sqlite.prepare("select body from orb_msg where id = ?").get(mineId).body, "привет из вкладки 1");
});

// v0.3: наружу — публичный алиас и одноразовый ключ на удаление. deviceId не должен
// просочиться ни в одно поле ни одного запроса за весь прогон.
await ok("the push carries the public alias and a delete key, not the device id", async () => {
  const ident = await store.getIdentity();
  const push = requests.find((r) => r.method === "POST" && /\/api\/push/.test(r.path));
  assert.ok(push, "ни одного /api/push не было");
  assert.equal(push.body.message.author.id, ident.pub, "автор — публичный алиас");
  assert.match(push.body.secret, /^[0-9a-f]{64}$/, "рядом с телом лежит ключ на удаление");
  assert.ok(!JSON.stringify(requests).includes(ident.deviceId), "deviceId засветился в запросах");
});

await ok("a visible chat beats presence inside the pull", async () => {
  requests.length = 0;
  await ask(1, { cmd: "presence", ...room({ visible: true }) });
  await until("цикл не сделал pull с beat", () =>
    Promise.resolve(requests.some((r) => /\/api\/pull\?/.test(r.path) && /[?&]beat=/.test(r.path) && /[?&]dev=/.test(r.path)))
  );
  assert.ok(sqlite.prepare("select client from orb_pres").all().length, "сервер запомнил клиента");
});

// адрес страницы в счётчике онлайна — это история посещений, поэтому в бите лежит
// 32-символьный токен комнаты, а не ROOM
await ok("the beat names the room by a hash, never by its address", async () => {
  const ident = await store.getIdentity();
  const pull = requests.find((r) => /[?&]beat=/.test(r.path));
  const beat = decodeURIComponent(pull.path.match(/[?&]beat=([^&]+)/)[1]);
  const dev = decodeURIComponent(pull.path.match(/[?&]dev=([^&]+)/)[1]);
  assert.match(beat, /^[0-9a-f]{32}$/, `бит поехал не токеном: ${beat}`);
  assert.ok(!pull.path.includes("room.test"), "адрес комнаты утек в query");
  assert.ok(dev.startsWith(`${ident.pub}:`), `клиент должен начинаться с алиаса: ${dev}`);
  assert.equal(sqlite.prepare("select room from orb_pres").get().room, beat, "сервер хранит тот же токен");
});

await ok("the same room is not beaten twice a minute", async () => {
  assert.equal(await testOnly.beatQuery(), null, "бит должен быть заблокирован по времени");
});

await ok("delivery to a neighbour holding long-poll takes seconds, not half a minute", async () => {
  const held = ask(1, { cmd: "sync:now", wait: 40 });
  await wait(300);
  // «незнакомец» с другого устройства: про минуем клиент, пишем прямо в воркер
  await fetch(`${SERVER}/api/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { id: "t-2", url: ROOM, lang: "ru", ch: `${ROOM}#ru`, ts: Date.now(), text: "привет от незнакомца", author: { id: "devZ", anon: true } } }),
  });
  const t0 = Date.now();
  const r = await held;
  const took = Date.now() - t0;
  assert.equal(r.online, true);
  assert.ok(r.pulled >= 1, `должен был принести 1 сообщение, принёс ${r.pulled}`);
  assert.ok(took < 6000, `ожидание ${took} мс — long-poll не работает`);
  assert.equal(await store.tx((st) => (st.messages["t-2"] || {}).text, true), "привет от незнакомца");
});

await ok("the feed shows the tail of the channel under «последние»", async () => {
  for (let i = 0; i < 120; i += 1) {
    sqlite.prepare(
      "insert or ignore into orb_msg (id, ch, url, lang, ts, updated_at, author, body) values (?,?,?,?,?,?,?,?)"
    ).run(`bulk-${i}`, `${ROOM}#ru`, ROOM, "ru", Date.now() - i, Date.now() - i, '{"id":"devZ"}', `номер ${i}`);
  }
  await store.mergeRemote(
    (await (await fetch(`${SERVER}/api/pull?since=0`)).json()).messages
  );
  const recent = await store.feed({ url: ROOM, lang: "ru", view: "all", period: "recent" });
  const all = await store.feed({ url: ROOM, lang: "ru", view: "all", period: "all" });
  assert.equal(recent.length, 100, "`последние` = 100 самых свежих");
  assert.ok(all.length > recent.length, "«за всё» длиннее, чем «последние»");
  assert.ok(recent[recent.length - 1].ts >= recent[0].ts, "порядок — по времени");
});

// модерация чужими руками: соседи ставят минусы через /api/patch, а скрывает их клиент
await ok("ten downvotes from neighbours hide the comment but keep the counter", async () => {
  await fetch(`${SERVER}/api/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { id: "down-1", url: ROOM, lang: "ru", ch: `${ROOM}#ru`, ts: Date.now(), text: "десять минусов", author: { id: "devQ", anon: true } },
    }),
  });
  let last = null;
  for (let i = 0; i < 10; i += 1) {
    last = await (await fetch(`${SERVER}/api/patch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgId: "down-1", down: [`dev${i}`] }),
    })).json();
  }
  assert.equal(last.message.down.length, 10, "воркер должен был сложить все минусы");
  await store.mergeRemote([last.message]);
  const row = (await store.feed({ url: ROOM, lang: "ru", view: "all", period: "all" })).find((m) => m.id === "down-1");
  assert.equal(row.hidden, "votes", "десять минусов прячут комментарий");
  assert.equal(row.down.length, 10, "счётчик минусов обязан остаться видимым");
});

/* Снятие звёзды/жалобы — v0.3.6: звёздный лимит 10 в сутки можно было обнулять кликом,
   потому что сервер массивы только складывал. Проверяем сквозняком: клик → сервер → pull. */
await ok("a withdrawn star really leaves the server", async () => {
  const ident = await store.getIdentity();
  // в базу пишем напрямую: /api/push тратит общий на комнату окно 5 сообщений за 20 с
  sqlite
    .prepare('insert or ignore into orb_msg (id, ch, url, lang, ts, updated_at, author, body, up, "down", stars, reports) values (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run("star-1", `${ROOM}#ru`, ROOM, "ru", Date.now(), Date.now(), '{"id":"devZ","anon":true}', "кандидат в важное", "[]", "[]", "[]", "[]");
  await store.mergeRemote([
    { id: "star-1", url: ROOM, lang: "ru", ch: `${ROOM}#ru`, ts: Date.now(), text: "кандидат в важное", links: [], up: [], down: [], stars: [], reports: [], author: { id: "devZ", anon: true } },
  ]);
  const row = () => JSON.parse(sqlite.prepare("select stars from orb_msg where id = ?").get("star-1").stars);
  const on = await ask(1, { cmd: "star", msgId: "star-1" });
  assert.equal(on.starred, true);
  assert.equal(on.quota.left, 9, "звёздный день должен укоротиться на одну");
  await until("звезда не уехала на сервер", () => Promise.resolve(row().length === 1));
  const off = await ask(1, { cmd: "star", msgId: "star-1" });
  assert.equal(off.starred, false);
  assert.equal(off.quota.left, 10, "снятие возвращает ровно одну звезду, не больше");
  await until("снятие не доехало до сервера", () => Promise.resolve(row().length === 0));
  await ask(1, { cmd: "sync:now" });
  assert.deepEqual(await store.tx((st) => st.messages["star-1"].stars, true), [], "pull принёл снятую звезду обратно");

  /* Живой воркер сегодня — это v0.2, который `rm` не понимает и вернёт алиас. Клиент
     обязан не поддакивать: чужие алиасы складываются, свои остаются местными. */
  await store.mergeRemote([
    { id: "star-1", url: ROOM, lang: "ru", ch: `${ROOM}#ru`, ts: Date.now(), text: "кандидат в важное", links: [], up: [], down: [], stars: [ident.pub, "peer-7"], reports: [], author: { id: "devZ", anon: true } },
  ]);
  assert.deepEqual(await store.tx((st) => st.messages["star-1"].stars, true), ["peer-7"]);
  assert.equal((await store.starQuota()).left, 10, "призрак с сервера не должен есть квоту");
});

/* Раздел «Ответы» живёт на связи replyTo: она обязана доехать до сервера и обратно
   целой, иначе клиент никогда не узнает, что ему ответили в другой комнате. */
await ok("an answer from a neighbour travels through the server", async () => {
  const mine = await ask(1, { cmd: "msg:post", ...room({ text: "моё сообщение под ответ" }) });
  assert.ok(mine && mine.message, `post не прошёл: ${JSON.stringify(mine)}`);
  await fetch(`${SERVER}/api/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        id: "rep-1", url: ROOM, lang: "ru", ch: `${ROOM}#ru`, ts: Date.now(),
        text: "отвечаю вам", quote: "моё сообщение под ответ", replyTo: mine.message.id,
        author: { id: "devW", anon: true },
      },
    }),
  });
  assert.equal(
    sqlite.prepare("select reply_to from orb_msg where id = 'rep-1'").get().reply_to,
    mine.message.id,
    "воркер обязан хранить id сообщения, на которое ответили"
  );
  const synced = await ask(1, { cmd: "sync:now" });
  assert.ok(synced.pulled >= 1, `pull не принёс ответ (${synced.pulled})`);
  const list = await store.answers({ lang: "*" });
  const row = list.rows.find((r) => r.id === "rep-1");
  assert.ok(row, "ответ не попал в раздел «Ответы»");
  assert.equal(row.parent.id, mine.message.id, "строка обязана ссылаться на моё сообщение");
  assert.equal(row.unread, true, "по нему ещё не кликали");
  await store.readAnswer("rep-1");
  assert.equal((await store.answers({ lang: "*" })).rows.find((r) => r.id === "rep-1").unread, false);
});

await ok("a backgrounded tab stops being online", async () => {
  testOnly.resetBeat();
  await ask(1, { cmd: "presence", ...room({ visible: false }) });
  assert.equal(await testOnly.beatQuery(), null, "для невидимой комнаты бита не бывает");
});

await ok("an old server without beat/clients falls back to POST presence", async () => {
  await ask(1, { cmd: "presence", ...room({ visible: true }) });
  testOnly.setServerBeats(false); // так клиент сам себя ведёт после первого pull без clients
  testOnly.resetBeat();
  requests.length = 0;
  const r = await ask(1, { cmd: "sync:now" });
  assert.equal(r.online, true, "синхронизация не должна сломаться");
  assert.ok(requests.some((x) => x.method === "POST" && /\/api\/presence/.test(x.path)), "онлайн поехал старым способом");
  assert.ok(!requests.some((x) => /[?&]beat=/.test(x.path)), "бит больше не просится в pull");
  const pres = requests.find((x) => x.method === "POST" && /\/api\/presence/.test(x.path));
  assert.ok(pres.body.url && pres.body.lang, "старому серверу нужен сырой адрес комнаты: " + JSON.stringify(pres.body));
  assert.ok(pres.body.id.startsWith(`${(await store.getIdentity()).pub}:`), pres.body.id);
  pullAnswersClients = true;
});

await ok("a delete only leaves through its author", async () => {
  await ask(1, { cmd: "msg:delete", msgId: mineId });
  await until("удаление не дошло до сервера", () =>
    Promise.resolve(sqlite.prepare("select id from orb_gone where id = ?").get(mineId) !== undefined)
  );
  assert.equal(sqlite.prepare("select id from orb_msg where id = ?").all(mineId).length, 0);
});

// ключ сервер видел один раз — при публикации; для удаления клиент выводит его заново
await ok("the delete request carries the derived key", async () => {
  const del = requests.find((r) => r.method === "POST" && /\/api\/delete/.test(r.path));
  assert.ok(del, "удаление не уехало на сервер");
  assert.equal(del.body.msgId, mineId);
  assert.equal(del.body.by, (await store.getIdentity()).pub, "старым строкам всё ещё нужен алиас автора");
  assert.match(del.body.secret, /^[0-9a-f]{64}$/);
  assert.equal(del.body.secret, await store.deleteTicket(mineId), "ключ должен выводиться, а не храниться");
});

/* ---------- site:open: панель ведёт на сам сайт, а не на пустую вкладку чата ---------- */
const drain = async (tab, status = "complete") => {
  tabUpdated.forEach((fn) => fn(tab.id, { status, url: tab.url }, tab));
  await wait(60);
};

await ok("a site link opens the page itself and asks that page for the overlay", async () => {
  opened.length = 0;
  createdTabs.length = 0;
  fakeTabs = [];
  const r = await ask(1, { cmd: "site:open", url: "https://new.site/page", lang: "de", msg: "m42" });
  assert.equal(r.mode, "new");
  assert.ok(opened.includes("create:https://new.site/page"), opened.join("|"));
  assert.ok(!opened.some((x) => x.startsWith("create:chrome-extension://")), "сразу вкладка чата — старый баг");
  await drain(createdTabs[0]);
  assert.ok(opened.includes(`send:${createdTabs[0].id}:overlay:open`), opened.join("|"));
});

await ok("an already open page is focused instead of duplicated", async () => {
  opened.length = 0;
  fakeTabs = [{ id: 7, windowId: 4, url: "https://new.site/page", status: "complete" }];
  const r = await ask(1, { cmd: "site:open", url: "https://new.site/page?utm=x", lang: "de", msg: "m1" });
  assert.equal(r.mode, "reuse");
  assert.ok(opened.includes('update:7:{"active":true}'), opened.join("|"));
  assert.ok(opened.includes('window:4:{"focused":true}'), opened.join("|"));
  assert.ok(opened.includes("send:7:overlay:open"), opened.join("|"));
  fakeTabs = [];
});

await ok("a non-web address still opens the chat page, carrying the comment id", async () => {
  opened.length = 0;
  createdTabs.length = 0;
  const r = await ask(1, { cmd: "site:open", url: "file:///C:/x/y.html", lang: "ru", msg: "m9" });
  assert.equal(r.mode, "chat");
  const chat = opened.find((x) => x.startsWith("create:chrome-extension://"));
  assert.ok(chat && /msg=m9/.test(chat) && /lang=ru/.test(chat), String(chat));
});

await ok("a hidden domain is not opened as a site tab", async () => {
  await store.setSettings({ hiddenDomains: ["blocked.site"] });
  opened.length = 0;
  const r = await ask(1, { cmd: "site:open", url: "https://blocked.site/x", lang: "ru" });
  assert.equal(r.mode, "chat");
  assert.ok(!opened.includes("create:https://blocked.site/x"), opened.join("|"));
  await store.setSettings({ hiddenDomains: [] });
});

await ok("a page that refuses the overlay falls back to the chat tab", async () => {
  opened.length = 0;
  createdTabs.length = 0;
  unroutable = true;
  const r = await ask(1, { cmd: "site:open", url: "https://stubborn.site/feed", lang: "en", msg: "m3" });
  assert.equal(r.mode, "new");
  await drain(createdTabs[0]);
  const chat = opened.find((x) => x.startsWith("create:chrome-extension://"));
  assert.ok(chat && /url=https%3A%2F%2Fstubborn.site%2Ffeed/.test(chat), String(chat));
  unroutable = false;
});

// последнее слово по приватности: за весь прогон ни один запрос не должен знать deviceId
await ok("no request leaked the device id", async () => {
  assert.ok(!JSON.stringify(requests).includes((await store.getIdentity()).deviceId), "deviceId уехал на сервер");
});

console.log(`\n${passed} checks passed${process.exitCode ? " — WITH FAILURES" : ""}`);
process.exit(process.exitCode || 0); // setInterval в фоновом скрипте сам по себе процесс не заканчивает
