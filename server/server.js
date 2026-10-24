// Orbita sync server — prototype of the dedicated server. Zero npm dependencies.
// Run: node server/server.js  →  http://127.0.0.1:8787
// Then put that URL into Orbita options → "Сервер синхронизации".
//
// Контракт v0.3: /api/push принимает одноразовый ключ удаления (в памяти остаётся только
// его sha256), /api/delete сверяет ключ, а presence считается по токену комнаты. Сообщения,
// записанные клиентами до v0.3, ключа не имеют — для них авторство по-прежнему проверяется
// по публичному id.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, "data");
const DATA_FILE = path.join(DATA_DIR, "orbita.json");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const RATE_WINDOW = 20_000;
const RATE_MAX = 5;
const MAX_MESSAGES = 20_000;
// строка присутствия живёт 5 минут: клиент бьёт раз в 4 минуты, при более коротком окне
// человек просто мигал бы «не в сети» между битами
const PRESENCE_TTL = 300_000;
const SALT_ROOM = "@orbita.room";

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
// клиент v0.3 шлёт готовый токен,v0.2 — сырой «url#lang»: приводим оба к одному значению
const roomToken = (v) => (/^[0-9a-f]{32}$/.test(v) ? v : createHash("sha1").update(v + SALT_ROOM).digest("hex").slice(0, 32));

const state = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
  : { messages: {}, presence: {}, rates: {}, deleted: {}, secrets: {} };
state.deleted = state.deleted || {};
state.secrets = state.secrets || {};

let dirty = false;
setInterval(() => {
  if (!dirty) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state));
  dirty = false;
}, 2000).unref();

function channelKeyOf(message) {
  return `${message.url}#${message.lang}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) {
        reject(new Error("too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(body);
}

function pruneMessages() {
  const ids = Object.keys(state.messages);
  if (ids.length <= MAX_MESSAGES) return;
  const sorted = ids
    .map((id) => state.messages[id])
    .sort((a, b) => a.ts - b.ts)
    .slice(0, ids.length - MAX_MESSAGES);
  for (const msg of sorted) delete state.messages[msg.id];
  dirty = true;
}

function ip(req) {
  return (req.socket.remoteAddress || "unknown").replace(/::ffff:/, "");
}

function allowed(key) {
  const now = Date.now();
  const list = (state.rates[key] || []).filter((ts) => now - ts < RATE_WINDOW);
  if (list.length >= RATE_MAX) {
    state.rates[key] = list;
    return { ok: false, retryInSec: Math.ceil((RATE_WINDOW - (now - list[0])) / 1000) };
  }
  list.push(now);
  state.rates[key] = list;
  dirty = true;
  return { ok: true };
}

// комната клиента: токен из нового контракта либо хэш от url#lang у старого
function presenceRoom(p) {
  return p.room || roomToken(`${p.url || ""}#${p.lang || ""}`);
}

function clientsIn(room) {
  const now = Date.now();
  return Object.values(state.presence).filter((p) => now - p.ts < PRESENCE_TTL && presenceRoom(p) === room).length;
}

function freshPresence() {
  const now = Date.now();
  for (const [id, p] of Object.entries(state.presence)) if (now - p.ts >= PRESENCE_TTL) delete state.presence[id];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  if (url.pathname === "/" ) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `Orbita sync server\nmessages: ${Object.keys(state.messages).length}\nchannels: ${
        new Set(Object.values(state.messages).map(channelKeyOf)).size
      }\nonline: ${Object.keys(state.presence).length}\n`
    );
    return;
  }

  if (url.pathname === "/api/health") {
    const now = Date.now();
    const clients = Object.values(state.presence).filter((p) => now - p.ts < PRESENCE_TTL).length;
    json(res, 200, { ok: true, now, clients, messages: Object.keys(state.messages).length });
    return;
  }

  if (url.pathname === "/api/presence" && req.method === "POST") {
    const body = await readBody(req);
    const room = body.id ? (body.room ? String(body.room) : roomToken(`${body.url || ""}#${body.lang || ""}`)) : "";
    if (body.id) {
      state.presence[String(body.id)] = { room, ts: Date.now() };
      freshPresence();
      dirty = true;
    }
    json(res, 200, { ok: true, clients: room ? clientsIn(room) : 0 });
    return;
  }

  if (url.pathname === "/api/pull") {
    const since = Number(url.searchParams.get("since") || 0);
    const lang = url.searchParams.get("lang");
    const chan = url.searchParams.get("channel");
    let list = Object.values(state.messages).filter((m) => m.ts > since);
    if (lang && lang !== "*") list = list.filter((m) => m.lang === lang);
    if (chan && chan !== "*") list = list.filter((m) => channelKeyOf(m) === chan);
    const gone = Object.entries(state.deleted)
      .filter(([, ts]) => ts > since)
      .map(([id]) => id)
      .slice(0, 500);
    json(res, 200, { now: Date.now(), messages: list.slice(0, 500), deleted: gone });
    return;
  }

  if (url.pathname === "/api/push" && req.method === "POST") {
    const body = await readBody(req);
    const msg = body.message;
    if (!msg || !msg.id || !msg.url || !msg.lang || typeof msg.text !== "string") {
      json(res, 400, { error: "bad_message" });
      return;
    }
    // адрес в ключе лимита хэшируется с текущими сутками: суточный лимит от этого не
    // меняется, а по дампу состояния нельзя связать посты с конкретным ip
    const day = Math.floor(Date.now() / 86_400_000);
    const gate = allowed(`${sha256(`${ip(req)}|${day}`).slice(0, 32)}|${channelKeyOf(msg)}`);
    if (!gate.ok) {
      json(res, 429, { error: "rate_limited", retryInSec: gate.retryInSec });
      return;
    }
    if (state.deleted[msg.id]) {
      json(res, 200, { ok: true, ignored: "deleted" });
      return;
    }
    if (body.secret) state.secrets[msg.id] = sha256(body.secret);
    state.messages[msg.id] = {
      ...msg,
      ts: Number(msg.ts) || Date.now(),
      text: String(msg.text).slice(0, 2000),
      up: Array.isArray(msg.up) ? msg.up.slice(0, 5000) : [],
      down: Array.isArray(msg.down) ? msg.down.slice(0, 5000) : [],
      stars: Array.isArray(msg.stars) ? msg.stars.slice(0, 5000) : [],
      reports: Array.isArray(msg.reports) ? msg.reports.slice(0, 5000) : [],
    };
    dirty = true;
    pruneMessages();
    json(res, 200, { ok: true, now: Date.now() });
    return;
  }

  if (url.pathname === "/api/patch" && req.method === "POST") {
    const body = await readBody(req);
    const msg = state.messages[body.msgId];
    if (!msg) {
      json(res, 404, { error: "not_found" });
      return;
    }
    /* как в worker.js: union не умеет снимать, поэтому снятый alias приходит в body.rm */
    const rm = body.rm && typeof body.rm === "object" ? body.rm : {};
    for (const field of ["up", "down", "stars", "reports"]) {
      if (Array.isArray(body[field])) msg[field] = Array.from(new Set(body[field].concat(msg[field] || []))).slice(0, 5000);
      const drop = new Set((Array.isArray(rm[field]) ? rm[field] : []).filter((x) => typeof x === "string"));
      if (drop.size) msg[field] = (msg[field] || []).filter((a) => !drop.has(a));
    }
    if (body.effect) msg.effect = body.effect;
    dirty = true;
    json(res, 200, { ok: true, message: msg });
    return;
  }

  if (url.pathname === "/api/delete" && req.method === "POST") {
    const body = await readBody(req);
    const id = String(body.msgId || "");
    const msg = state.messages[id];
    if (!msg) {
      json(res, 404, { error: "not_found" });
      return;
    }
    // прототип: раньше здесь не было проверки автора вовсе
    const stored = state.secrets[id];
    if (stored) {
      if (!body.secret || sha256(body.secret) !== stored) {
        json(res, 403, { error: "not_mine" });
        return;
      }
    } else if (msg.author && msg.author.id && body.by !== msg.author.id) {
      json(res, 403, { error: "not_mine" });
      return;
    }
    delete state.messages[id];
    delete state.secrets[id];
    state.deleted[id] = Date.now();
    const ids = Object.keys(state.deleted);
    if (ids.length > 5000) {
      ids.sort((a, b) => state.deleted[a] - state.deleted[b]);
      for (const old of ids.slice(0, ids.length - 5000)) delete state.deleted[old];
    }
    dirty = true;
    json(res, 200, { ok: true, deleted: id });
    return;
  }

  json(res, 404, { error: "not_found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Orbita sync server → http://${HOST}:${PORT}  (данные: ${DATA_FILE})`);
});
