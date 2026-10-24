import { channelKey, normalizeUrl, extractLinks, censored, safeText } from "./sanitize.js";

const KEY = "orbita.state";
export const PERIODS = { recent: Infinity, day: 864e5, week: 7 * 864e5, month: 30 * 864e5, year: 365 * 864e5, all: Infinity };
const MAX_PER_CHANNEL = 800;
const MAX_TOTAL = 4000;
const LENTA_MAX = 30;
const RECENT_FEED = 100;
const RATE_WINDOW = 20e3;
const RATE_MAX = 5;
const STAR_WINDOW = 864e5;
const STAR_MAX = 10;
const FX_WINDOW = 864e5;
/* Заряды на сутки, на устройство: огня много не бывает, но и не бесконечно,
   а щит — редкий ответ на него, иначе «защитить» можно было бы весь чат. */
export const FX_QUOTA = { flame: 3, shield: 1 };
export const REPORT_HIDE_AT = 3;
// сообщество само решает, что не стоит читать: 10 минусов прячут комментарий
export const DOWNVOTE_HIDE_AT = 10;

/* deviceId никогда не уезжает наружу. Пока он стоял в author.id, любой читатель комнаты
   получал ключ к удалению чужих сообщений (`/api/delete` сверял именно его). Наружу идёт
   детерминированный псевдоним: один и тот же человек в одной комнате выглядит одинаково
   для всех, но по этому значению нельзя ни удалить его пост, ни проследить его по другим сайтам. */
const SALT_PUB = "@orbita.pub";
const SALT_ROOM = "@orbita.room";
const SALT_DEL = "@orbita.del";

async function digest(algorithm, text) {
  const buf = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function publicAlias(deviceId) {
  return "u" + (await digest("SHA-1", deviceId + SALT_PUB)).slice(0, 24);
}

/* Токен комнаты для presence: сервер считает «онлайн» по хэшу, живой адрес страницы
   на сервер не летит — иначе по таблице присутствия читалась бы история посещений. */
export async function roomToken(ch) {
  return (await digest("SHA-1", String(ch) + SALT_ROOM)).slice(0, 32);
}

export async function secretHash(secret) {
  return digest("SHA-256", String(secret || ""));
}

/* Общий сервер зашит в код и не редактируется в настройках. Поле адреса в интерфейсе
   означало, что любой, кто откроет настройки, мог вписать свой сервер и собрать все
   комнаты к себе; адрес не секрет, но он должен меняться только вместе с релизом.
   Новый адрес = одна строка здесь, и он приезжает к людям в архиве. */
export const SERVER_URL = "https://orbita.thenewimperium.workers.dev";

export const DEFAULT_SETTINGS = {
  serverUrl: SERVER_URL,
  syncOn: true,
  enabled: true,
  uiLang: "ru",
  filter: true,
  opacity: 0.9,
  mode: "overlay",
  hiddenDomains: [],
  showHidden: false,
  // звук оповещения: синтезированные сигналы или свой mp3, загруженный в панели 🎨
  sound: { on: true, tone: "chime", volume: 0.6 },
};

/* Пользовательский mp3 живёт в отдельном ключе: data-URL весит сотни килобайт, и
   тащить его в каждый read/write основного состояния означало бы перечитывать
   базу на каждом сообщении. Хранилище с unlimitedStorage, так что лимит только
   наш собственный — 3 MB, чтобы один «свой звук» не сожрал всё место под историю. */
const SOUND_KEY = "orbita.sound";
export const SOUND_MAX_BYTES = 3 * 1024 * 1024;

export async function getCustomSound() {
  try {
    const raw = await chrome.storage.local.get(SOUND_KEY);
    return raw[SOUND_KEY] || "";
  } catch {
    return "";
  }
}

export async function setCustomSound(dataUrl) {
  if (!dataUrl) {
    await chrome.storage.local.remove(SOUND_KEY);
    return { ok: true, cleared: true };
  }
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:audio")) {
    return { error: "not_audio" };
  }
  if (dataUrl.length > SOUND_MAX_BYTES) return { error: "too_big", maxBytes: SOUND_MAX_BYTES };
  await chrome.storage.local.set({ [SOUND_KEY]: dataUrl });
  return { ok: true, bytes: dataUrl.length };
}

function blank() {
  return {
    v: 1,
    messages: {},
    channels: {},
    prefs: null,
    identity: null,
    rates: {},
    stars: {},
    fx: {},
    deleted: {},
    recent: [],
    mirrors: {},
    reads: {},
  };
}

/* Mirrors: `st.mirrors` maps every joined address to the address that owns the shared
   channel, so joyreactor.cc and old.reactor.cc read and write one and the same room.
   Each message keeps the url of the page it was written on — that is what lets a
   detached address take its own comments back. */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function canonical(st, url) {
  const u = normalizeUrl(url);
  return (st.mirrors && st.mirrors[u]) || u;
}

function groupOf(st, home) {
  const urls = Object.keys(st.mirrors || {}).filter((k) => st.mirrors[k] === home);
  return { home, urls: urls.length ? urls : [home] };
}

// move a whole channel (all languages) to another address
function moveChannel(st, from, to) {
  for (const key of Object.keys(st.channels)) {
    if (!key.startsWith(`${from}#`)) continue;
    const lang = key.slice(from.length + 1);
    const target = `${to}#${lang}`;
    const chan = st.channels[key];
    chan.msgIds = chan.msgIds.filter((id) => st.messages[id]);
    for (const id of chan.msgIds) {
      st.messages[id].ch = target;
    }
    if (st.channels[target]) {
      const own = st.channels[target];
      own.msgIds = own.msgIds.filter((id) => !chan.msgIds.includes(id));
      own.msgIds.push(...chan.msgIds);
      own.updatedAt = Math.max(own.updatedAt || 0, chan.updatedAt || 0);
      delete st.channels[key];
    } else {
      chan.url = to;
      st.channels[target] = chan;
      delete st.channels[key];
    }
  }
  for (const row of st.recent || []) if (row.url === from) row.url = to;
}

// only the messages written from `from` go back to a channel of their own
function splitChannel(st, home, from) {
  for (const lang of new Set(Object.values(st.messages).filter((m) => m.url === from).map((m) => m.lang))) {
    const key = `${home}#${lang}`;
    const chan = st.channels[key];
    if (!chan) continue;
    const take = chan.msgIds.filter((id) => st.messages[id] && st.messages[id].url === from);
    if (!take.length) continue;
    chan.msgIds = chan.msgIds.filter((id) => !take.includes(id));
    const own = `${from}#${lang}`;
    const target = st.channels[own] || (st.channels[own] = { url: from, title: chan.title || "", lang, msgIds: [], updatedAt: chan.updatedAt });
    for (const id of take) {
      st.messages[id].ch = own;
      if (!target.msgIds.includes(id)) target.msgIds.push(id);
    }
    if (!chan.msgIds.length) delete st.channels[key];
  }
}

async function readState() {
  const got = await chrome.storage.local.get(KEY);
  const s = got[KEY];
  return s && s.v === 1 ? s : blank();
}

function prune(s) {
  for (const key of Object.keys(s.channels)) {
    const ids = s.channels[key].msgIds;
    if (ids.length > MAX_PER_CHANNEL) {
      for (const id of ids.splice(0, ids.length - MAX_PER_CHANNEL)) delete s.messages[id];
    }
  }
  const all = Object.values(s.messages);
  if (all.length > MAX_TOTAL) {
    const keepScore = (m) => (m.stars.length ? 1e6 : 0) + score(m) * 100 + m.ts / 1e10;
    all.sort((a, b) => keepScore(a) - keepScore(b));
    for (const m of all.slice(0, all.length - MAX_TOTAL)) {
      delete s.messages[m.id];
      const ch = s.channels[m.ch];
      if (ch) ch.msgIds = ch.msgIds.filter((id) => id !== m.id);
    }
  }
  // в сборках до v0.3.0 здесь лежали секреты на удаление; теперь они выводятся из deviceId
  delete s.secrets;
  Object.keys(s.rates).forEach((id) => {
    s.rates[id] = s.rates[id].filter((ts) => Date.now() - ts < 60e5);
    if (!s.rates[id].length) delete s.rates[id];
  });
  Object.keys(s.stars).forEach((id) => {
    s.stars[id] = starLedger(s.stars[id]);
    if (!Object.keys(s.stars[id]).length) delete s.stars[id];
  });
  s.fx = s.fx || {};
  Object.keys(s.fx).forEach((id) => {
    const byType = {};
    for (const [type, list] of Object.entries(s.fx[id] || {})) {
      const fresh = (list || []).filter((ts) => Date.now() - ts < FX_WINDOW);
      if (fresh.length) byType[type] = fresh;
    }
    if (Object.keys(byType).length) s.fx[id] = byType;
    else delete s.fx[id];
  });
  return s;
}

let queue = Promise.resolve();
export function tx(fn, readOnly = false) {
  const run = queue.then(async () => {
    const state = await readState();
    const result = await fn(state);
    if (!readOnly) await chrome.storage.local.set({ [KEY]: prune(state) });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

export function score(msg) {
  return (msg.up ? msg.up.length : 0) - (msg.down ? msg.down.length : 0);
}

/* Адрес на руках у пользователя был в старых сборках, и инструкция толкала дописывать к нему
   /api/health. Нормализуем: хвост со слэшами и /api/health отрезаем, пустое значение = зашитый
   сервер, выключенная синхронизация = локальный режим (ни одного запроса наружу). */
function serverOf(prefs) {
  if (prefs.syncOn === false) return "";
  const raw = typeof prefs.serverUrl === "string" ? prefs.serverUrl.trim() : "";
  if (!raw) return SERVER_URL;
  return raw.replace(/\/+$/, "").replace(/\/api\/health$/, "");
}

export async function getSettings() {
  const stored = await tx((st) => st.prefs, true);
  const prefs = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  // звук живёт вложенным объектом: у сохранённых настроек старых версий его может не быть
  prefs.sound = { ...DEFAULT_SETTINGS.sound, ...((stored || {}).sound || {}) };
  return { ...prefs, serverUrl: serverOf(prefs) };
}

export async function setSettings(patch) {
  const stored = await tx((st) => {
    const prev = { ...DEFAULT_SETTINGS, ...(st.prefs || {}) };
    st.prefs = { ...prev, ...patch };
    st.prefs.sound = { ...prev.sound, ...(patch.sound || {}) };
    return st.prefs;
  });
  return { ...stored, serverUrl: serverOf(stored) };
}

export const NAME_MAX = 67;

// A nickname can be global (the default for sites you have not visited) or per site:
// "крокодил" on vk.com must not follow you to another domain.
function withSite(id, host) {
  const site = host && id.sites ? id.sites[host] : null;
  if (!site) return id;
  return { ...id, name: site.name || "", anon: site.anon !== false };
}

export async function getIdentity(url) {
  return tx(async (st) => {
    if (!st.identity) {
      st.identity = {
        deviceId: "d" + crypto.randomUUID().replace(/-/g, ""),
        pub: "",
        name: "",
        anon: true,
        avatar: "",
        userId: null,
        sites: {},
      };
    }
    // у сборок до v0.3.0 псевдонима нет: выводим его один раз из сохранённого deviceId
    if (!st.identity.pub) st.identity.pub = await publicAlias(st.identity.deviceId);
    return withSite({ ...st.identity }, url ? hostOf(url) : "");
  });
}

export async function setIdentity(patch, url) {
  return tx((st) => {
    const next = { ...(st.identity || {}) };
    if ("name" in patch) patch = { ...patch, name: String(patch.name || "").slice(0, NAME_MAX) };
    // picture avatars belong to registered accounts; everyone else gets a glass gradient
    if ("avatar" in patch && !next.userId) patch = { ...patch, avatar: "" };
    if (patch.avatar && !String(patch.avatar).startsWith("data:image/")) patch = { ...patch, avatar: "" };
    const host = url ? hostOf(url) : "";
    if (host && ("name" in patch || "anon" in patch)) {
      const sites = { ...(next.sites || {}) };
      const site = { name: next.name || "", anon: next.anon !== false, ...(sites[host] || {}) };
      if ("name" in patch) site.name = patch.name;
      if ("anon" in patch) site.anon = !!patch.anon;
      sites[host] = site;
      next.sites = sites;
    } else {
      Object.assign(next, patch);
      next.sites = next.sites || {};
    }
    st.identity = next;
    return withSite({ ...st.identity }, host);
  });
}

// drop the override so the site falls back to the default nickname again
export async function resetSiteIdentity(url) {
  // the settings page only knows the bare host, the chat passes a full address
  const host = hostOf(url) || String(url || "").toLowerCase();
  return tx((st) => {
    const next = { ...(st.identity || {}) };
    next.sites = { ...(next.sites || {}) };
    delete next.sites[host];
    st.identity = next;
    return { ...st.identity };
  });
}

/* Журнал квоты звёзд: карта «сообщение → когда». До v0.3.6 это был просто список отметок,
   и снятие звезды вычёркивало последнюю по времени — то есть возвращало квоту за другой
   комментарий. Старое значение переезжает в карту без потерь, синтетическими ключами. */
function starLedger(raw) {
  const now = Date.now();
  const entries = Array.isArray(raw)
    ? raw.map((ts, i) => [`legacy-${i}`, ts])
    : Object.entries(raw || {});
  const out = {};
  for (const [msgId, ts] of entries) if (now - Number(ts) < STAR_WINDOW) out[msgId] = ts;
  return out;
}

export function currentStarQuota(st, deviceId) {
  const raw = st.stars[deviceId];
  const used = (Array.isArray(raw) ? raw : Object.values(raw || {})).filter((ts) => Date.now() - ts < STAR_WINDOW).length;
  return { used, left: Math.max(0, STAR_MAX - used), windowMs: STAR_WINDOW };
}

export async function starQuota() {
  const id = await getIdentity();
  return tx((st) => currentStarQuota(st, id.deviceId));
}

export function currentFxQuota(st, deviceId) {
  const now = Date.now();
  const mine = (st.fx && st.fx[deviceId]) || {};
  const out = { windowMs: FX_WINDOW };
  for (const [type, max] of Object.entries(FX_QUOTA)) {
    const used = (mine[type] || []).filter((ts) => now - ts < FX_WINDOW).length;
    out[type] = { used, left: Math.max(0, max - used), max };
  }
  return out;
}

export async function fxQuota() {
  const id = await getIdentity();
  return tx((st) => currentFxQuota(st, id.deviceId));
}

export async function postMessage({ url, title, lang, text, quote, replyTo }) {
  const id = await getIdentity(url);
  const body = safeText(text);
  if (!body.trim()) return { error: "empty" };
  return tx((st) => {
    const now = Date.now();
    const history = (st.rates[id.deviceId] || []).filter((ts) => now - ts < RATE_WINDOW);
    if (history.length >= RATE_MAX) {
      st.rates[id.deviceId] = history;
      const wait = Math.ceil((RATE_WINDOW - (now - history[0])) / 1000);
      return { error: "rate_limited", retryInSec: wait };
    }
    history.push(now);
    st.rates[id.deviceId] = history;
    const page = normalizeUrl(url);
    const ch = channelKey(canonical(st, url), lang);
    const chan = st.channels[ch] || (st.channels[ch] = { url: ch.slice(0, ch.lastIndexOf("#")), title: title || "", lang, msgIds: [], updatedAt: now });
    chan.title = title || chan.title;
    chan.updatedAt = now;
    const msgId = now.toString(36) + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    // ↩ обязан оставить не только текст цитаты, но и id: без него «мне ответили» неоткуда вычислить
    const parentId = typeof replyTo === "string" ? replyTo.slice(0, 64) : "";
    const msg = {
      id: msgId,
      ch,
      url: page,
      lang,
      ts: now,
      author: {
        // псевдоним, а не deviceId: id лежит в публичном потоке и не должен быть ключом к удалению
        id: id.pub,
        name: id.anon ? "" : id.name || "",
        anon: !!id.anon,
        avatar: id.userId && !id.anon ? id.avatar || "" : "",
        userId: id.userId || null,
      },
      text: body,
      links: extractLinks(body),
      up: [],
      down: [],
      stars: [],
      reports: [],
      effect: null,
      quote: safeText(quote || ""),
      replyTo: st.messages[parentId] ? parentId : "",
      source: "local",
    };
    chan.msgIds.push(msgId);
    st.messages[msgId] = msg;
    st.recent = [
      { url: chan.url, title: chan.title, lang, lastTs: now },
      ...(st.recent || []).filter((r) => !(r.url === chan.url && r.lang === lang)),
    ].slice(0, 24);
    return { message: msg, channel: chan };
  });
}

/* Голос, звезда и жалоба — записи вида «alias проголосовал». Сервер их объединяет,
   поэтому ОТСУТСТВИЕ alias'а в присланном массиве для сервера ничего не значит: снятую
   запись он помнит и на следующем pull возвращает обратно. Отсюда и бесконечные звёзды
   (квоту снятие вернуло, а звезда прилетела с сервера), и неснимаемый красный ⚑.
   Потому снятие теперь уезжает явно: `withdrawn = { поле: [alias] }`, сервер по этому
   списку вычёркивает запись, а клиент не даёт ей вернуться (см. mergeRemote). */
export async function vote(msgId, dir) {
  const id = await getIdentity();
  return tx((st) => {
    const msg = st.messages[msgId];
    if (!msg) return null;
    const opposite = dir === "up" ? msg.down : msg.up;
    const target = dir === "up" ? msg.up : msg.down;
    const withdrawn = {};
    const back = (field, list) => {
      const at = list.indexOf(id.pub);
      if (at < 0) return false;
      list.splice(at, 1);
      withdrawn[field] = [id.pub];
      return true;
    };
    back(dir === "up" ? "down" : "up", opposite);
    const had = back(dir, target);
    if (!had) target.push(id.pub);
    return { message: msg, myVote: had ? null : dir, withdrawn, score: score(msg) };
  });
}

export async function toggleStar(msgId) {
  const id = await getIdentity();
  return tx((st) => {
    const msg = st.messages[msgId];
    if (!msg) return { error: "not_found" };
    const ledger = starLedger(st.stars[id.deviceId]);
    const mine = msg.stars.indexOf(id.pub);
    if (mine >= 0) {
      msg.stars.splice(mine, 1);
      // возвращается ровно та отметка, которая была потрачена на это сообщение
      delete ledger[msgId];
      st.stars[id.deviceId] = ledger;
      return { starred: false, withdrawn: { stars: [id.pub] }, quota: currentStarQuota(st, id.deviceId) };
    }
    const quota = currentStarQuota(st, id.deviceId);
    if (quota.left <= 0) return { error: "quota", quota };
    msg.stars.push(id.pub);
    ledger[msgId] = Date.now();
    st.stars[id.deviceId] = ledger;
    return { starred: true, withdrawn: {}, quota: currentStarQuota(st, id.deviceId) };
  });
}

/* ⚑ — переключатель, а не кнопка «один раз и навсегда»: жалоба, снятая до того, как
   комната успела спрятать комментарий, не должна гореть красным вечно. */
export async function report(msgId) {
  const id = await getIdentity();
  return tx((st) => {
    const msg = st.messages[msgId];
    if (!msg) return null;
    const mine = msg.reports.indexOf(id.pub);
    const withdrawn = {};
    if (mine >= 0) {
      msg.reports.splice(mine, 1);
      withdrawn.reports = [id.pub];
    } else msg.reports.push(id.pub);
    return {
      reported: mine < 0,
      withdrawn,
      reports: msg.reports.length,
      hidden: hideReason(msg) !== null,
      reason: hideReason(msg),
      down: msg.down.length,
    };
  });
}

/* Анимация накладывается на сообщение целиком: горит и аватар, и пузырь.
   Заряд списывается только когда что-то реально изменилось — нельзя сжечь щит
   «в никуда» или поджечь то, что уже пылает. Сообщение под щитом огня не боится:
   защитник тушит пожар и сразу закрывает комментарий, поэтому второй огнеметчик
   сюда уже не пройдёт. Эффект живой и не сгорает сам: его снимает только щит. */
export async function applyEffect(msgId, type) {
  if (!Object.prototype.hasOwnProperty.call(FX_QUOTA, type)) return { error: "bad_effect" };
  const id = await getIdentity();
  return tx((st) => {
    const msg = st.messages[msgId];
    if (!msg) return { error: "not_found" };
    const now = Date.now();
    const quota = () => currentFxQuota(st, id.deviceId);
    const prev = msg.effect ? msg.effect.type : null;
    if (type === "flame") {
      if (prev === "flame") return { error: "busy_flame", quota: quota() };
      if (prev === "shield") return { error: "protected", quota: quota() };
    } else if (prev === "shield") {
      return { error: "busy_shield", quota: quota() };
    }
    st.fx = st.fx || {};
    const used = ((st.fx[id.deviceId] || {})[type] || []).filter((ts) => now - ts < FX_WINDOW);
    if (used.length >= FX_QUOTA[type]) return { error: "quota", quota: quota() };
    used.push(now);
    st.fx[id.deviceId] = { ...(st.fx[id.deviceId] || {}), [type]: used };
    msg.effect = { type, by: id.anon ? "anon" : id.name || "anon", ts: now };
    return { message: msg, quenched: prev === "flame", quota: quota() };
  });
}

// Deleting is for the author only. The id stays in `deleted` as a tombstone, so a
// sync server that still holds the message cannot resurrect it on the next pull.
export async function deleteMessage(msgId) {
  const id = await getIdentity();
  return tx((st) => {
    const msg = st.messages[msgId];
    if (!msg) return { error: "not_found" };
    if (!msg.author || !mineIds(id).includes(msg.author.id)) return { error: "not_mine" };
    const chan = st.channels[msg.ch];
    if (chan) {
      chan.msgIds = chan.msgIds.filter((x) => x !== msgId);
      if (!chan.msgIds.length) delete st.channels[msg.ch];
    }
    delete st.messages[msgId];
    st.deleted = st.deleted || {};
    st.deleted[msgId] = Date.now();
    const keys = Object.keys(st.deleted);
    if (keys.length > 5000) {
      keys.sort((a, b) => st.deleted[a] - st.deleted[b]);
      for (const k of keys.slice(0, keys.length - 5000)) delete st.deleted[k];
    }
    // сервер сверяет deleteTicket, а не `by`: публичный id автора виден в ленте каждому.
    // `by` остаётся только для строк до v0.3.0 — у них ключа в базе нет, и автор там подписан deviceId
    return { deleted: msgId, url: msg.url, lang: msg.lang, by: msg.author.id };
  });
}

/* Ключ на удаление не хранится в базе расширения, а выводится из deviceId и id сообщения.
   Так его умеет восстановить любое окно этого устройства: сообщение, прилетевшее со сервера
   во вторую вкладку, всё ещё удаляется. deviceId наружу не уезжает, значит угадать ключ
   со стороны нельзя; сервер хранит только его sha256. */
export async function deleteTicket(msgId) {
  const id = await getIdentity();
  return digest("SHA-256", `${id.deviceId}#${msgId}${SALT_DEL}`);
}

function inPeriod(msg, period) {
  const span = PERIODS[period] ?? PERIODS.day;
  return span === Infinity || Date.now() - msg.ts <= span;
}

/* Причина, по которой комментарий прячется: ⚑ жалобы соседей или ▼ решение сообщества.
   Спрятанное сообщение не исчезает из ленты совсем — оно сворачивается в полоску, где
   видно счётчик, поэтому человек может сам решить, читать ли дальше. */
export function hideReason(msg) {
  if ((msg.reports || []).length >= REPORT_HIDE_AT) return "reports";
  if ((msg.down || []).length >= DOWNVOTE_HIDE_AT) return "votes";
  return null;
}

export function isHidden(msg) {
  return hideReason(msg) !== null;
}

/* Сообщения, написанные до v0.3.0, подписаны самим deviceId, а не алиасом. Без этого списка
   после обновления свои комментарии стали бы чужими: без кнопки 🗑 и вне «Моих сообщений».
   deviceId тех строк уже уехал на сервер в составе author.id, так что вернуть его туда же —
   не новая утечка. */
export const mineIds = (id) => [id.pub, id.deviceId];

export async function feed({ url, lang, view = "all", period = "recent", sort = "new", filter = true }) {
  const id = await getIdentity();
  return tx((st) => {
    const ch = channelKey(canonical(st, url), lang);
    const chan = st.channels[ch];
    let list = chan ? chan.msgIds.map((mId) => st.messages[mId]).filter(Boolean) : [];
    if (view === "important") list = list.filter((m) => m.stars.length > 0);
    if (view === "mine") list = list.filter((m) => mineIds(id).includes(m.author.id));
    list = list.filter((m) => inPeriod(m, period));
    list.sort((a, b) => a.ts - b.ts);
    // «последние» = хвост канала по времени, а не весь архив: окну чата не нужно
    // рисовать восемьсот строк, а старый конкретный комментарий открывают «за всё»
    if (period === "recent") list = list.slice(-RECENT_FEED);
    if (view === "important") list.sort((a, b) => b.stars.length - a.stars.length || score(b) - score(a) || b.ts - a.ts);
    else if (view === "top" || sort === "score") list.sort((a, b) => score(b) - score(a) || b.stars.length - a.stars.length || b.ts - a.ts);
    // скрытые сообщения остаются в списке: рисовать их полоской или текстом решает интерфейс
    // значок «↩ N» и оповещение об ответе считаются по replyTo; на сервере v0.2 его нет,
    // поэтому там родителя добираем по тексту цитаты — индекс строим только по этой комнате
    const byQuote = list.some((m) => !m.replyTo && m.quote)
      ? quoteIndex(st, id, new Set(list.map((m) => m.ch)))
      : null;
    return list.map((m) => {
      const parent = (m.replyTo && st.messages[m.replyTo]) || (byQuote ? byQuote(m) : null);
      return {
        ...m,
        text: censored(m.text, filter),
        hidden: hideReason(m),
        replyTo: parent ? parent.id : m.replyTo || "",
      };
    });
  }, true);
}

/* «Общая лента» — топ комментариев со всех комнат, а не список ссылок: комментарий без
   ссылки интересен не меньше, чем ссылка. Ссылки, если они в тексте были, едут
   маленькими чипами внутри той же строки. Строка имеет ровно тот же формат, что и
   «Мои сообщения», поэтому панель рисует оба таба одним рендерером. */
export async function lenta({ url, lang, period = "week", filter = true }) {
  return tx((st) => {
    let list = Object.values(st.messages);
    list = list.filter((m) => inPeriod(m, period));
    list = list.filter((m) => (lang === "*" ? true : m.lang === lang));
    if (url !== "*") list = list.filter((m) => m.url === normalizeUrl(url));
    // скрытое сообществом решение в топ не попадает: рейтинг — это и есть его вердикт
    list = list.filter((m) => !isHidden(m) && score(m) > 0);
    list.sort((a, b) => (period === "recent" ? b.ts - a.ts : score(b) - score(a) || b.ts - a.ts));
    return list.slice(0, LENTA_MAX).map((m) => panelRow(st, m, filter));
  }, true);
}

// the right drawer's second tab: my own messages across every channel, newest first
export async function myPosts({ lang, period = "recent", filter = true }) {
  const id = await getIdentity();
  return tx((st) => {
    let list = Object.values(st.messages).filter((m) => m.author && mineIds(id).includes(m.author.id));
    list = list.filter((m) => inPeriod(m, period));
    list = list.filter((m) => (lang === "*" ? true : m.lang === lang));
    list.sort((a, b) => b.ts - a.ts);
    return list.slice(0, LENTA_MAX).map((m) => panelRow(st, m, filter));
  }, true);
}

const LENTA_LINKS = 3;

/* Ключ строки для поиска родителя по цитате: пробелы в один, регистр не важен. */
const answerKey = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 220);

/* Ответ обязан найти своего родителя даже тогда, когда сервер связь не вернул: живой
   воркер v0.2 колонки `reply_to` не знает и отдаёт только текст цитаты. Индекс строится
   по СВОИМ сообщениям нужных комнат и по двум формам текста — исходному и цензурированному,
   потому что в `quote` лежит ровно то, что человек видел на экране (стоп-слова заглушены).
   Совпадение обязано быть точным и не позже самого ответа; коротких («ок», «+1») не берём —
   на них слишком много ложных родителей. */
function quoteIndex(st, id, chans) {
  const byKey = new Map();
  const put = (key, p) => {
    if (key.length < 4) return;
    const bucket = byKey.get(key) || [];
    bucket.push(p);
    byKey.set(key, bucket);
  };
  for (const p of Object.values(st.messages)) {
    if (!chans.has(p.ch) || !mineIds(id).includes(p.author.id)) continue;
    put(`${p.ch}\u0000${answerKey(p.text)}`, p);
    put(`${p.ch}\u0000${answerKey(censored(p.text, true))}`, p);
  }
  byKey.forEach((bucket) => bucket.sort((a, b) => a.ts - b.ts));
  return (m) => {
    let best = null;
    for (const p of byKey.get(`${m.ch}\u0000${answerKey(m.quote)}`) || []) {
      if (p.id !== m.id && p.ts <= m.ts) best = p;
    }
    return best;
  };
}

/* Третий раздел правой панели: чужие ответы на МОИ сообщения по всем комнатам сразу.
   Кнопка ↩ до v0.3.1 сохраняла только текст цитаты, поэтому связь «кто мне ответил»
   было неоткуда взять — её держит поле replyTo. Родительское сообщение обязано
   существовать и быть нашим: чужой replyTo на чужой пост в этот список не попадает.
   Непрочитанным считается ответ, по которому ещё не кликнули: список разбирают по
   строке, и общий водопад «всё до этого момента» здесь означал бы, что часть ответов
   человек пропустил, но счётчик уже молчит. */
export async function answers({ lang, period = "week", filter = true }) {
  const id = await getIdentity();
  return tx((st) => {
    const read = new Set((st.reads && st.reads.answered) || []);
    // сначала отбираем кандидатов, чтобы индекс по цитатам строить только по нужным комнатам
    const candidates = Object.values(st.messages).filter(
      (m) => (m.replyTo || m.quote) && !isHidden(m) && !mineIds(id).includes(m.author.id) && (lang === "*" || m.lang === lang) && inPeriod(m, period)
    );
    const byQuote = quoteIndex(st, id, new Set(candidates.map((m) => m.ch)));
    const rows = [];
    for (const m of candidates) {
      const parent = (m.replyTo && st.messages[m.replyTo]) || byQuote(m);
      if (!parent || !mineIds(id).includes(parent.author.id)) continue;
      rows.push({
        id: m.id,
        url: m.url,
        lang: m.lang,
        ts: m.ts,
        text: censored(m.text, filter),
        votes: score(m),
        name: m.author.anon ? "" : m.author.name || "",
        unread: !read.has(m.id),
        parent: { id: parent.id, text: censored(parent.text, filter), ts: parent.ts },
        links: (m.links || []).slice(0, LENTA_LINKS),
      });
    }
    rows.sort((a, b) => b.ts - a.ts);
    return { rows: rows.slice(0, LENTA_MAX), unread: rows.reduce((n, r) => n + (r.unread ? 1 : 0), 0) };
  }, true);
}

// клик по строке «Ответы» снимает счётчик с этой строки
const ANSWERED_MAX = 200;

export async function readAnswer(msgId) {
  const id = String((msgId && msgId.id) || msgId || "").slice(0, 64);
  if (!id) return { ok: false };
  return tx((st) => {
    const prev = (st.reads && st.reads.answered) || [];
    if (prev.includes(id)) return { ok: true };
    st.reads = { ...(st.reads || {}), answered: [id, ...prev].slice(0, ANSWERED_MAX) };
    return { ok: true };
  });
}

function panelRow(st, m, filter) {
  return {
    id: m.id,
    url: m.url,
    lang: m.lang,
    ts: m.ts,
    title: (st.channels[m.ch] && st.channels[m.ch].title) || "",
    text: censored(m.text, filter),
    votes: score(m),
    down: (m.down || []).length,
    stars: (m.stars || []).length,
    hidden: hideReason(m),
    links: (m.links || []).slice(0, LENTA_LINKS),
  };
}

export async function recentChannels() {
  return tx((st) => (st.recent || []).slice(0, 24), true);
}

export function canonicalUrl(url) {
  return tx((st) => canonical(st, url), true);
}

export function mirrorsFor(url) {
  return tx((st) => groupOf(st, canonical(st, url)), true);
}

export function addMirror({ base, url }) {
  const member = normalizeUrl(url || "");
  if (!/^https?:\/\//.test(member)) return Promise.resolve({ error: "bad_url" });
  return tx((st) => {
    st.mirrors = st.mirrors || {};
    const home = canonical(st, base);
    if (member === home) return { ok: true, group: groupOf(st, home) };
    const theirHome = st.mirrors[member] || member;
    if (theirHome === home) return { ok: true, group: groupOf(st, home) };
    if (theirHome !== member) {
      // the address already runs a room of its own: that room now belongs to this one
      for (const k of Object.keys(st.mirrors)) if (st.mirrors[k] === theirHome) st.mirrors[k] = home;
    }
    st.mirrors[home] = home;
    st.mirrors[member] = home;
    // its posts have to move in, otherwise they would stay hidden behind the old address
    moveChannel(st, theirHome, home);
    return { ok: true, group: groupOf(st, home) };
  });
}

export function removeMirror({ url }) {
  const member = normalizeUrl(url || "");
  return tx((st) => {
    st.mirrors = st.mirrors || {};
    const home = canonical(st, member);
    if (member === home) {
      const others = Object.keys(st.mirrors).filter((k) => st.mirrors[k] === home);
      for (const k of others) delete st.mirrors[k];
      for (const other of others) if (other !== home) splitChannel(st, home, other);
      return { ok: true, removed: home, group: { home, urls: [home] } };
    }
    delete st.mirrors[member];
    splitChannel(st, home, member);
    const left = Object.keys(st.mirrors).filter((k) => st.mirrors[k] === home);
    if (left.length <= 1) for (const k of left) delete st.mirrors[k];
    return { ok: true, removed: member, group: groupOf(st, home) };
  });
}

export async function stats() {
  return tx(
    (st) => {
      const channels = Object.values(st.channels).map((c) => ({
        url: c.url,
        title: c.title,
        lang: c.lang,
        count: c.msgIds.filter((id) => st.messages[id]).length,
        updatedAt: c.updatedAt,
      }));
      return { channels, messages: Object.keys(st.messages).length };
    },
    true
  );
}

export async function applyRemoteDeletes(ids) {
  if (!Array.isArray(ids) || !ids.length) return { removed: 0 };
  return tx((st) => {
    let removed = 0;
    for (const id of ids) {
      const msg = st.messages[id];
      if (msg) {
        const chan = st.channels[msg.ch];
        if (chan) chan.msgIds = chan.msgIds.filter((x) => x !== id);
        delete st.messages[id];
        removed += 1;
      }
      st.deleted = st.deleted || {};
      st.deleted[id] = Date.now();
    }
    return { removed };
  });
}

export async function mergeRemote(messages) {
  const id = await getIdentity();
  return tx((st) => {
    // чужие alias'ы сервер знает лучше нас, свои — знаем лучше сервера: снятую звезду или
    // жалобу pull иначе приносит обратно, и счётчик звёзд перестаёт быть расходом
    const mineSet = new Set(mineIds(id));
    const mergeList = (local, remote) =>
      Array.from(new Set([...(local || []), ...(remote || []).filter((a) => !mineSet.has(a))]));
    let added = 0;
    for (const remote of messages || []) {
      if (!remote || !remote.id) continue;
      if (st.deleted && st.deleted[remote.id]) continue;
      const own = st.messages[remote.id];
      // раз сообщение пришло с сервера, оно там уже есть: повторный push не нужен
      if (own) {
        own.pushedAt = own.pushedAt || Date.now();
        own.up = mergeList(own.up, remote.up);
        own.down = mergeList(own.down, remote.down);
        own.stars = mergeList(own.stars, remote.stars);
        own.reports = mergeList(own.reports, remote.reports);
        if (remote.effect && (!own.effect || remote.effect.ts > own.effect.ts)) own.effect = remote.effect;
        continue;
      }
      // a peer may push an address we joined as a mirror: file it under our own room
      const ch = channelKey(canonical(st, remote.url), remote.lang);
      st.messages[remote.id] = { ...remote, ch, url: normalizeUrl(remote.url), pushedAt: Date.now() };
      const chan = st.channels[ch] || (st.channels[ch] = { url: ch.slice(0, ch.lastIndexOf("#")), title: remote.title || "", lang: remote.lang, msgIds: [], updatedAt: remote.ts });
      if (!chan.msgIds.includes(remote.id)) chan.msgIds.push(remote.id);
      chan.updatedAt = Math.max(chan.updatedAt || 0, remote.ts);
      added += 1;
    }
    return { added };
  });
}

export async function clearAll() {
  return tx((st) => {
    const identity = st.identity;
    const prefs = st.prefs;
    const deleted = st.deleted;
    const mirrors = st.mirrors;
    const fresh = blank();
    fresh.identity = identity;
    fresh.prefs = prefs;
    fresh.deleted = deleted || {};
    fresh.mirrors = mirrors || {};
    Object.keys(st).forEach((k) => delete st[k]);
    Object.assign(st, fresh);
    return true;
  });
}
