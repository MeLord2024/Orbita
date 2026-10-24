// Cloudflare-бэкенд Orbita прогоняется на node:sqlite как на поддельном D1:
// тот же worker.js, та же schema.sql, только вместо Cloudflare — локальный SQLite.
// Run: node tests/test_cf_worker.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker, { prune } from "../server/cloudflare/worker.js";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../server/cloudflare/schema.sql", import.meta.url), "utf8"));

const norm = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

const env = {
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
const ctx = { waitUntil: (p) => p.catch(() => {}) };

async function call(path, { method = "GET", body, headers } = {}) {
  const res = await worker.fetch(
    new Request(`https://orbita.test${path}`, {
      method,
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx
  );
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* текстовые ответы так и задуманы */ }
  return { status: res.status, json, text, headers: res.headers };
}

const msg = (over = {}) => ({
  id: "m-1", url: "https://example.com/page", lang: "ru", ch: "https://example.com/page#ru",
  ts: Date.now(), author: { id: "devA", name: "Крокодил" }, text: "привет", links: [],
  up: [], down: [], stars: [], reports: [], ...over,
});

let passed = 0;
const ok = async (label, fn) => {
  try { await fn(); passed += 1; console.log(`  ok  ${label}`); }
  catch (err) { console.log(`FAIL  ${label}: ${err.message}`); process.exitCode = 1; }
};

const h0 = await call("/api/health");
await ok("health answers json", async () => {
  assert.equal(h0.status, 200);
  assert.equal(h0.json.ok, true);
  assert.equal(h0.json.messages, 0);
  assert.equal(h0.json.clients, 0);
});

await ok("root page is human readable", async () => {
  const r = await call("/");
  assert.match(r.text, /Orbita sync server/);
  assert.match(r.headers.get("content-type"), /text\/plain/);
});

await ok("OPTIONS preflight carries CORS", async () => {
  const r = await call("/api/push", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

await ok("push stores a message", async () => {
  const r = await call("/api/push", { method: "POST", body: { message: msg() } });
  assert.equal(r.json.ok, true);
  const p = await call("/api/pull?since=0");
  assert.equal(p.json.messages.length, 1);
  assert.equal(p.json.messages[0].text, "привет");
  assert.deepEqual(p.json.messages[0].author, { id: "devA", name: "Крокодил" });
});

await ok("repeated push of the same id does not overwrite the body", async () => {
  await call("/api/push", { method: "POST", body: { message: msg({ text: "переписанное" }) } });
  const p = await call("/api/pull?since=0");
  assert.equal(p.json.messages.length, 1);
  assert.equal(p.json.messages[0].text, "привет");
});

await ok("empty text is rejected", async () => {
  const r = await call("/api/push", { method: "POST", body: { message: msg({ id: "m-2", text: "   " }) } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "bad_message");
});

// голоса: клиент присылает СВОЙ голос, сервер объединяет массивы
await ok("votes from two neighbours merge instead of overwriting", async () => {
  const a = await call("/api/patch", { method: "POST", body: { msgId: "m-1", up: ["devA"] } });
  assert.deepEqual(a.json.message.up, ["devA"]);
  const b = await call("/api/patch", { method: "POST", body: { msgId: "m-1", up: ["devB"] } });
  assert.deepEqual(b.json.message.up.sort(), ["devA", "devB"]);
  const c = await call("/api/patch", { method: "POST", body: { msgId: "m-1", stars: ["devC"] } });
  assert.deepEqual(c.json.message.up.sort(), ["devA", "devB"]);
  assert.deepEqual(c.json.message.stars, ["devC"]);
});

/* v0.3.6: union не умеет снимать — отсутствие алиаса в массиве для сервера ничего не
   значит. Снятие приезжает отдельным списком `rm`, иначе звезда возвращалась с каждого
   pull, а квота 10 в сутки обнулялась. */
await ok("rm withdraws an alias the union would keep forever", async () => {
  const w = await call("/api/patch", { method: "POST", body: { msgId: "m-1", stars: [], rm: { stars: ["devC"] } } });
  assert.deepEqual(w.json.message.stars, []);
  assert.deepEqual(w.json.message.up.sort(), ["devA", "devB"], "rm трогает только своё поле");
  const keep = await call("/api/patch", { method: "POST", body: { msgId: "m-1", stars: ["devC"], rm: { stars: ["devGhost"] } } });
  assert.deepEqual(keep.json.message.stars, ["devC"], "несуществующий алиас в rm — не ошибка");
  const old = await call("/api/patch", { method: "POST", body: { msgId: "m-1", stars: ["devOld"] } });
  assert.deepEqual(old.json.message.stars.sort(), ["devC", "devOld"], "клиент без rm работает по-старому");
});

await ok("patch of unknown message is 404", async () => {
  const r = await call("/api/patch", { method: "POST", body: { msgId: "nope", up: ["x"] } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "not_found");
});

// pull идёт по updated_at, иначе голоса старого сообщения не доехали бы до соседа
await ok("pull by updated_at delivers a vote on an old message", async () => {
  const since = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  await call("/api/patch", { method: "POST", body: { msgId: "m-1", down: ["devD"] } });
  const p = await call(`/api/pull?since=${since}`);
  assert.equal(p.json.messages.length, 1);
  assert.deepEqual(p.json.messages[0].down, ["devD"]);
});

await ok("huge since values are not truncated to 32 bits", async () => {
  const p = await call(`/api/pull?since=${Date.now() + 60_000}`);
  assert.equal(p.json.messages.length, 0);
});

await ok("pull filters by language and channel", async () => {
  await call("/api/push", { method: "POST", body: { message: msg({ id: "m-3", lang: "en", ch: "https://example.com/page#en" }) } });
  assert.equal((await call("/api/pull?since=0&lang=en")).json.messages.length, 1);
  assert.equal((await call("/api/pull?since=0&lang=*")).json.messages.length, 2);
  const byChan = await call("/api/pull?since=0&channel=" + encodeURIComponent("https://example.com/page#ru"));
  assert.deepEqual(byChan.json.messages.map((m) => m.id), ["m-1"]);
});

await ok("presence counts real clients in the room", async () => {
  const one = await call("/api/presence", { method: "POST", body: { id: "devA:tab:1", url: "https://example.com/page", lang: "ru" } });
  assert.equal(one.json.clients, 1);
  const two = await call("/api/presence", { method: "POST", body: { id: "devB:tab:1", url: "https://example.com/page", lang: "ru" } });
  assert.equal(two.json.clients, 2);
  const otherLang = await call("/api/presence", { method: "POST", body: { id: "devC:tab:1", url: "https://example.com/page", lang: "en" } });
  assert.equal(otherLang.json.clients, 1);
  const again = await call("/api/presence", { method: "POST", body: { id: "devA:tab:1", url: "https://example.com/page", lang: "ru" } });
  assert.equal(again.json.clients, 2, "heartbeat того же клиента не удваивает счётчик");
});

await ok("presence without an id is rejected", async () => {
  const r = await call("/api/presence", { method: "POST", body: { url: "https://example.com/page", lang: "ru" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "bad_presence");
});

// long-poll: держим соединение и отвечаем в момент, когда сообщение появляется
await ok("pull with wait wakes as soon as a message lands", async () => {
  const t0 = Date.now();
  const waiting = call(`/api/pull?since=${Date.now()}&wait=6`);
  await new Promise((r) => setTimeout(r, 300));
  await call("/api/push", {
    method: "POST",
    body: { message: msg({ id: "late-1", url: "https://late.test/x", ch: "https://late.test/x#ru", text: "пришло во время hold" }) },
  });
  const r = await waiting;
  const took = Date.now() - t0;
  assert.deepEqual(r.json.messages.map((m) => m.id), ["late-1"]);
  assert.ok(took < 5_000, `проснулся через ${took} мс вместо того, чтобы досидеть 6 с`);
});

await ok("a quiet pull with wait holds the connection and comes back empty", async () => {
  const t0 = Date.now();
  const r = await call(`/api/pull?since=${Date.now() + 60_000}&wait=2`);
  const took = Date.now() - t0;
  assert.equal(r.json.messages.length, 0);
  assert.ok(took >= 1_800, `отпустил слишком рано: ${took} мс`);
});

// присутствие живёт внутри pull: отдельного POST раз в 15 секунд клиент больше не шлёт
await ok("beat inside pull refreshes presence and returns the room count", async () => {
  const beat = `dev=devE:tab:9&beat=${encodeURIComponent("https://example.com/page#en")}`;
  const one = await call(`/api/pull?since=0&${beat}`);
  assert.equal(one.json.clients, 2, "о счётчик добавился к devC:tab:1 из POST-presence");
  const two = await call(`/api/pull?since=0&${beat}`);
  assert.equal(two.json.clients, 2, "повторный бит того же клиента не удваивает счётчик");
  const plain = await call("/api/pull?since=0");
  assert.equal(plain.json.clients, undefined, "без beat поля clients в ответе нет");
});

await ok("health keeps its counter in orb_meta instead of counting every time", async () => {
  const h = await call("/api/health");
  assert.equal(typeof h.json.messages, "number");
  assert.ok(sqlite.prepare("select val from orb_meta where key = 'messages'").all().length, "счётчик сохранён");
});

await ok("delete needs the author", async () => {
  const wrong = await call("/api/delete", { method: "POST", body: { msgId: "m-1", by: "devZ" } });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.error, "not_mine");
  const right = await call("/api/delete", { method: "POST", body: { msgId: "m-1", by: "devA" } });
  assert.equal(right.json.ok, true);
  const again = await call("/api/delete", { method: "POST", body: { msgId: "m-1", by: "devZ" } });
  assert.equal(again.json.ok, true, "повторное удаление идемпотентно");
});

await ok("deleted message reaches peers as a tombstone and stays dead", async () => {
  const p = await call("/api/pull?since=0");
  assert.ok(p.json.deleted.includes("m-1"));
  assert.ok(!p.json.messages.some((m) => m.id === "m-1"));
  const revived = await call("/api/push", { method: "POST", body: { message: msg() } });
  assert.equal(revived.json.ignored, "deleted");
  const patched = await call("/api/patch", { method: "POST", body: { msgId: "m-1", up: ["devA"] } });
  assert.equal(patched.json.error, "deleted");
});

await ok("rate limit is per ip and channel", async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await call("/api/push", { method: "POST", body: { message: msg({ id: `burst-${i}`, url: "https://burst.test/0", ch: "https://burst.test/0#ru" }) } });
    assert.equal(r.json.ok, true, `push ${i} прошёл`);
  }
  const sixth = await call("/api/push", { method: "POST", body: { message: msg({ id: "burst-6", url: "https://burst.test/0", ch: "https://burst.test/0#ru" }) } });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.json.error, "rate_limited");
  const otherRoom = await call("/api/push", { method: "POST", body: { message: msg({ id: "burst-other", url: "https://burst.test/9", ch: "https://burst.test/9#ru" }) } });
  assert.equal(otherRoom.json.ok, true, "другой канал не задет тем же IP");
  const otherIp = await call("/api/push", { method: "POST", body: { message: msg({ id: "burst-ip", url: "https://burst.test/0", ch: "https://burst.test/0#ru" }) }, headers: { "cf-connecting-ip": "198.51.100.4" } });
  assert.equal(otherIp.json.ok, true, "другой IP не задет тем же каналом");
});

await ok("unknown path and bad json answer cleanly", async () => {
  const r = await call("/api/nothing");
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "not_found");
  const bad = await worker.fetch(new Request("https://orbita.test/api/push", { method: "POST", body: "не json" }), env, ctx);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "bad_json");
});

await ok("prune drops messages older than the retention window", async () => {
  sqlite.prepare("insert into orb_msg (id, ch, url, lang, ts, updated_at, body) values (?,?,?,?,?,?,?)")
    .run("ancient", "https://old.test#ru", "https://old.test", "ru", Date.now() - 90 * 86_400_000, Date.now() - 90 * 86_400_000, "привет из прошлого");
  const total = () => sqlite.prepare("select count(*) as c from orb_msg").get().c;
  const before = total();
  await prune(env.DB, 30);
  assert.equal(before - total(), 1);
  assert.ok(!sqlite.prepare("select id from orb_msg where id = 'ancient'").all().length);
});

/* ——— v0.3.0: ключ удаления, токен комнаты, хэш адреса ——— */

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
const roomOf = (v) => (/^[0-9a-f]{32}$/.test(v) ? v : createHash("sha1").update(`${v}@orbita.room`).digest("hex").slice(0, 32));

await ok("push stores only the hash of the delete key", async () => {
  const secret = "a1b2c3d4-0000-4111-8222-abcdefabcdef";
  await call("/api/push", {
    method: "POST",
    body: { message: msg({ id: "own-1", author: { id: "upa", name: "" }, url: "https://secret.test/x", ch: "https://secret.test/x#ru" }), secret },
  });
  const row = sqlite.prepare("select secret_hash from orb_msg where id = 'own-1'").get();
  assert.equal(row.secret_hash, sha256(secret));
  const pulled = await call("/api/pull?since=0");
  const mine = pulled.json.messages.find((m) => m.id === "own-1");
  assert.equal(mine.secret_hash, undefined, "хэш не уезжает в pull");
  assert.equal(JSON.stringify(pulled.json).includes(secret), false, "ключ не мелькает в ответе");
});

await ok("deleting someone else's message needs their key", async () => {
  const noKey = await call("/api/delete", { method: "POST", body: { msgId: "own-1", by: "upa" } });
  assert.equal(noKey.status, 403, "одного публичного id больше не достаточно");
  const wrongKey = await call("/api/delete", { method: "POST", body: { msgId: "own-1", secret: "не тот ключ", by: "upa" } });
  assert.equal(wrongKey.status, 403);
  assert.equal(wrongKey.json.error, "not_mine");
  const rightKey = await call("/api/delete", {
    method: "POST",
    body: { msgId: "own-1", secret: "a1b2c3d4-0000-4111-8222-abcdefabcdef", by: "upa" },
  });
  assert.equal(rightKey.json.ok, true);
});

await ok("presence is stored as a room token, not an address", async () => {
  const token = roomOf("https://token.test/page#ru");
  const byToken = await call("/api/presence", { method: "POST", body: { id: "upA:tab:1", room: token } });
  assert.equal(byToken.json.clients, 1);
  const row = sqlite.prepare("select room from orb_pres where client = 'upA:tab:1'").get();
  assert.equal(row.room, token);
  assert.equal(String(row.room).includes("token.test"), false);
});

await ok("a legacy raw address and a v0.3 token land in the same room", async () => {
  const raw = "https://mixed.test/page#ru";
  const legacy = await call("/api/presence", { method: "POST", body: { id: "old:tab:1", url: raw.split("#")[0], lang: "ru" } });
  assert.equal(legacy.json.clients, 1, "старый клиент посчитан отдельной комнатой");
  const modern = await call("/api/presence", { method: "POST", body: { id: "new:tab:1", room: roomOf(raw) } });
  assert.equal(modern.json.clients, 2, "новый клиент с токеном попал в ту же комнату");
  const beat = await call(`/api/pull?since=0&dev=beat%3A1&beat=${roomOf(raw)}`);
  assert.equal(beat.json.clients, 3, "бит внутри pull считает ту же корзину");
  const legacyBeat = await call(`/api/pull?since=0&dev=beat%3A2&beat=${encodeURIComponent(raw)}`);
  assert.equal(legacyBeat.json.clients, 4, "сырой beat клиента v0.2 не создаёт вторую комнату");
});

await ok("a fresh beat is counted without rewriting the row", async () => {
  const beat = `dev=skip%3A1&beat=${roomOf("https://skip.test/x#ru")}`;
  await call(`/api/pull?since=0&${beat}`);
  const first = sqlite.prepare("select ts from orb_pres where client = 'skip:1'").get();
  await call(`/api/pull?since=0&${beat}`);
  const second = sqlite.prepare("select ts from orb_pres where client = 'skip:1'").get();
  assert.equal(first.ts, second.ts, "второй бит за минуту не должен стоить записи в базу");
});

await ok("the rate table never sees a raw ip", async () => {
  await call("/api/push", { method: "POST", body: { message: msg({ id: "ip-1", url: "https://ip.test/x", ch: "https://ip.test/x#ru" }) } });
  const buckets = sqlite.prepare("select bucket from orb_rate").all().map((r) => String(r.bucket));
  assert.ok(buckets.length, "счётчик ведётся");
  assert.equal(buckets.some((b) => b.includes("203.0.113.7")), false, "адрес в ключе не пишется");
  assert.ok(buckets.some((b) => b.startsWith("d|")), "есть и суточный ведро-ключ");
});

await ok("the daily cap counts posts across all channels", async () => {
  const day = Math.floor(Date.now() / 86_400_000);
  const dayBucket = `d|${sha256(`203.0.113.7|${day}`).slice(0, 32)}`;
  const stmt = sqlite.prepare("insert into orb_rate (bucket, ts) values (?, ?)");
  for (let i = 0; i < 300; i += 1) stmt.run(dayBucket, Date.now() - 1000);
  const r = await call("/api/push", { method: "POST", body: { message: msg({ id: `day-${day}`, url: "https://fresh.test/x", ch: "https://fresh.test/x#ru" }) } });
  assert.equal(r.status, 429, "новый канал не обязан пропускать того, кто уже вылинил суточную норму");
  const otherIp = await call("/api/push", {
    method: "POST",
    body: { message: msg({ id: `day-other-${day}`, url: "https://fresh.test/x", ch: "https://fresh.test/x#ru" }) },
    headers: { "cf-connecting-ip": "198.51.100.9" },
  });
  assert.equal(otherIp.json.ok, true, "чужая суточная норма никого не касается");
  sqlite.prepare("delete from orb_rate where bucket = ?").run(dayBucket);
});

await ok("the answer link survives the round trip", async () => {
  await call("/api/push", {
    method: "POST",
    body: { message: msg({ id: "ans-1", url: "https://ans.test/x", ch: "https://ans.test/x#ru", quote: "привет", replyTo: "m-1" }) },
  });
  const pulled = await call("/api/pull?since=0");
  const row = pulled.json.messages.find((m) => m.id === "ans-1");
  assert.equal(row.replyTo, "m-1", "без этой связи раздел «Ответы» на сервере слеп");
  assert.equal(row.quote, "привет", "текст цитаты едет рядом");
  const other = pulled.json.messages.find((m) => m.id !== "ans-1");
  assert.equal(other.replyTo, "", "старые строки без ответа читаются как пустая связь");
});

console.log(`\n${passed} checks passed${process.exitCode ? " — WITH FAILURES" : ""}`);
