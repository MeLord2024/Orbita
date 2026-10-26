import * as store from "./store.js";
import { channelKey } from "./sanitize.js";
import { makeT, UI_LANGS } from "./locales.js";

const presence = new Map();
// сколько клиентов в комнате по мнению сервера: `${url}#${lang}` → число
const remoteCounts = new Map();
const tabUrls = new Map();
let badgeTimer = null;

/* Транспорт. Раньше всё жило на таймерах: pull раз в 30 секунд и POST присутствия раз в
   15 — отсюда и «сообщение идёт полминуты», и ~480 запросов в час на один открытый чат.
   Теперь один цикл: long-poll держит соединение и отвечает в момент, когда сосед что-то
   написал (доставка за секунды), онлайн едет внутри того же запроса, и запросов выходит
   ~90 в час. Chrome убивает service worker без событий, поэтому будильник раз в 30 с
   остаётся — он не опрашивает сервер, а не даёт циклу уснуть навсегда. */
const WAIT_SEC = 40; // сколько сервер держит соединение
/* Каждый бит — это одна запись в базу, а на бесплатном D1 записей 100 000 в сутки на весь
   аккаунт (с осени 2026-го сверх лимита запросы падают ошибкой, а не тормозят). Сервер держит
   строку живой 5 минут, поэтому бить раз в 90 с означало write втрое чаще, чем нужно. */
const BEAT_MS = 240_000; // как часто обновляем онлайн; сервер считает его живым 5 минут
const FALLBACK_MS = 30_000; // сервер не умеет wait (Supabase, server/server.js) — шаг своего опроса
const IDLE_MS = 60_000; // ни один чат не виден: столько ждём между выгрузками
const ROOM_MS = 120_000; // вкладка считается открытой, если маяк приходил за последние 2 минуты

let liveRunning = false;
let wakeSleep = null;
let lastBeat = 0;
let beatRoom = ""; // комната последнего бита: переключились на другую — счётчик нужен сразу
let serverBeats = true; // сервер отвечает clients на beat; старый — нет, тогда откат на POST

const sleep = (ms) =>
  new Promise((res) => {
    const timer = setTimeout(res, ms);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      res();
    };
  });

function wakeLive() {
  if (wakeSleep) wakeSleep();
}

function guessLang() {
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en";
  const code = nav.split("-")[0].toLowerCase();
  return ["en", "ru", "de", "es"].includes(code) ? code : code || "en";
}

function localKeyOf(sender) {
  return sender.tab && sender.tab.id != null ? `tab:${sender.tab.id}` : `view:${sender.id || "popup"}`;
}

function bumpPresence(key, sender, visible = true) {
  presence.set(localKeyOf(sender), { key, ts: Date.now(), visible });
  scheduleBadge();
}

function dropPresence(sender) {
  presence.delete(localKeyOf(sender));
  scheduleBadge();
}

async function roomKey(url, lang) {
  return channelKey(await store.canonicalUrl(url), lang);
}

setInterval(() => {
  const cutoff = Date.now() - ROOM_MS;
  let changed = false;
  for (const [k, v] of presence) {
    if (v.ts < cutoff) {
      presence.delete(k);
      changed = true;
    }
  }
  if (changed) scheduleBadge();
}, 30e3);

async function clientsForUrl(url, lang) {
  // mirrors share one room, so the badge counts everyone in the merged channel
  const norm = await store.canonicalUrl(url);
  const prefix = `${norm}#`;
  const prefs = await store.getSettings();
  if (prefs.serverUrl) {
    // на сервере онлайн считается по комнате: своих вкладок для счётчика мало
    if (lang) return remoteCounts.get(prefix + lang) || 0;
    let sum = 0;
    for (const [k, v] of remoteCounts) if (k.startsWith(prefix)) sum += v;
    return sum;
  }
  let n = 0;
  for (const v of presence.values()) if (v.key.startsWith(prefix)) n += 1;
  return n;
}

// на сервере различают по публичному алиасу + локальный ключ вкладки. deviceId наружу не
// уезжает никогда: по нему нельзя было бы найти человека, но и удалить чужое сообщение
// тоже нельзя было, а это единственное, чем сервер до сих пор проверял авторство.
async function pingPresence() {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl) return;
  const identity = await store.getIdentity();
  const cutoff = Date.now() - ROOM_MS;
  for (const [client, v] of [...presence]) {
    if (v.ts < cutoff) continue;
    const cut = v.key.lastIndexOf("#");
    try {
      const res = await remote("/api/presence", {
        url: v.key.slice(0, cut),
        lang: v.key.slice(cut + 1),
        id: `${identity.pub}:${client}`,
      });
      if (res && typeof res.clients === "number") remoteCounts.set(v.key, res.clients);
    } catch {
      /* сервер молчит — оставляем последний известный счётчик */
    }
  }
}

/* «Онлайн» на сервере = комната, в которую человек смотрит прямо сейчас. Скрытая вкладка
   не шлёт битов, и через пять минут сервер перестаёт считать её человеком: это честнее,
   чем вечно висеть «онлайн» из фоновой вкладки, и заодно снимает главный источник
   запросов. Исключение — старые серверы без beat: там маяки шлются POST-ом по всем
   свежим вкладкам, как и раньше. */
function activeRoom() {
  let best = null;
  for (const [client, v] of presence) {
    if (!v.visible) continue;
    if (!best || v.ts > best.ts) best = { client, key: v.key, ts: v.ts };
  }
  return best;
}

/* Строка запроса для presence-бита и комната, к которой относится ответный счётчик.
   На сервер уходит не адрес страницы, а необратимый токен комнаты: воркер по нему считает
   людей в комнате, но не видит, где именно человек сидит. Ответы старых клиентов (бит с
   сырым адресом) воркер хэширует сам, так что обе схемы попадают в одну корзину.
   Здесь же исправлена опечатка: encodeURIComponent не существует, и вызов падал ещё до
   запроса — из-за этого цикл синхронизации обрывался на первом же бите. */
async function beatQuery() {
  if (!serverBeats || Date.now() - lastBeat < BEAT_MS) return null;
  const room = activeRoom();
  if (!room) return null;
  const identity = await store.getIdentity();
  return {
    room: room.key,
    q: `&dev=${encodeURIComponent(`${identity.pub}:${room.client}`)}&beat=${encodeURIComponent(await store.roomToken(room.key))}`,
  };
}

async function scheduleBadge() {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(refreshBadges, 250);
}

/* Global online counts active installations, not tabs or opened rooms.
   MV3 alarms wake the service worker; no permanent background loop is assumed. */
let globalOnline = null;
let globalUpdatedAt = 0;
let globalHeartbeatAt = 0;
let globalHeartbeatBusy = false;
const GLOBAL_HEARTBEAT_MS = 240000;

function formatGlobalBadge(count) {
  if (!Number.isFinite(count) || count < 1) return "";
  if (count < 1000) return String(count);
  if (count < 10000) return Math.floor(count / 1000) + "K+";
  if (count < 1000000) return Math.floor(count / 1000) + "K";
  return Math.floor(count / 1000000) + "M+";
}

async function globalHeartbeat(force = false) {
  if (globalHeartbeatBusy || (!force && Date.now() - globalHeartbeatAt < GLOBAL_HEARTBEAT_MS)) return;
  const prefs = await store.getSettings();
  if (!prefs.serverUrl || prefs.syncOn === false) {
    globalOnline = null;
    await refreshBadges();
    return;
  }
  globalHeartbeatBusy = true;
  try {
    const identity = await store.getIdentity();
    const res = await remote("/api/global-presence", { client: identity.pub });
    if (!res || !res.ok || !Number.isFinite(Number(res.online))) throw Error("global presence unavailable");
    globalOnline = Math.max(0, Number(res.online));
    globalUpdatedAt = Date.now();
    globalHeartbeatAt = Date.now();
    await refreshBadges();
  } catch {
    if (Date.now() - globalUpdatedAt > 300000) globalOnline = null;
    await refreshBadges();
  } finally {
    globalHeartbeatBusy = false;
  }
}

async function globalRooms() {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl || prefs.syncOn === false) return {};
  try {
    const res = await fetch(prefs.serverUrl.replace(/\\/+$/, "") + "/api/global-rooms");
    if (!res.ok) return {};
    const data = await res.json();
    return data && data.ok && data.rooms ? data.rooms : {};
  } catch { return {}; }
}

async function refreshBadges() {
  // A single global badge is shared by every tab. Per-tab badges would override it.
  const count = Date.now() - globalUpdatedAt <= 300000 ? globalOnline : null;
  try {
    await chrome.action.setBadgeText({ text: formatGlobalBadge(count) });
    await chrome.action.setTitle({ title: count == null
      ? "Orbita · global online unavailable"
      : `Orbita · ${count.toLocaleString()} users online` });
    // Clear old per-tab badges left by earlier versions of Orbita.
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter(t => t.id != null).map(t => chrome.action.setBadgeText({ tabId: t.id, text: formatGlobalBadge(count) }).catch(() => {})));
  } catch { /* browser shutting down */ }
}

function broadcast(event, payload) {
  chrome.runtime.sendMessage({ type: "orbita:event", event, payload }).catch(() => {});
}

async function remote(path, body) {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl) return null;
  const base = prefs.serverUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    // content-type только у POST: GET с этим заголовком перестаёт быть «простым»
    // запросом, и браузер перед каждым pull шлёл бы ещё и OPTIONS
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`server ${res.status}`);
  return res.json();
}

async function pushPatch(msgId, patch) {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl) return;
  try {
    await remote("/api/patch", { msgId, ...patch });
  } catch {
    /* offline: local state stays authoritative, sync:now retries */
  }
}

/* Удаление подтверждается одноразовым ключом, который сервер видел ровно один раз — при
   публикации сообщения. `by` (публичный алиас) остался только для старых строк в базе,
   где ключа нет; подделать его теперь нельзя, потому что deviceId наружу не уезжает. */
async function pushDelete(msgId, by) {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl) return;
  try {
    await remote("/api/delete", { msgId, secret: await store.deleteTicket(msgId), by });
  } catch {
    /* offline: the local tombstone already keeps it out of the feed */
  }
}

// своё сообщение уходит на сервер сразу, не дожидаясь ближайшего шага цикла
async function pushNow(msg) {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl) return;
  try {
    await remote("/api/push", { message: msg, secret: await store.deleteTicket(msg.id) });
    await store.tx((st) => {
      if (st.messages[msg.id]) st.messages[msg.id].pushedAt = Date.now();
    });
  } catch {
    /* офлайн: список nepushнутых сообщений повторит на следующем круге */
  }
}

async function syncOnce(opts = {}) {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl) return { mode: "local" };
  const wait = Math.max(0, Math.min(45, Number(opts.wait) || 0));
  const beat = await beatQuery();
  const started = Date.now();
  try {
    const since = await store.tx((st) => (st.sync && st.sync.lastPull) || 0, true);
    const pending = await store.tx(
      (st) => Object.values(st.messages).filter((m) => m.source === "local" && !m.pushedAt).slice(0, 50),
      true
    );
    // сначала раскидать своё, потом ждать чужого: иначе своё уедет только после hold
    for (const msg of pending) await pushNow(msg);
    const data = await remote(`/api/pull?since=${since}${beat ? beat.q : ""}${wait ? `&wait=${wait}` : ""}`);
    if (data && data.messages) await store.mergeRemote(data.messages);
    if (data && data.deleted && data.deleted.length) {
      await store.applyRemoteDeletes(data.deleted);
      broadcast("sync:deleted", { ids: data.deleted });
    }
    if (beat) {
      if (data && typeof data.clients === "number") {
        serverBeats = true;
        lastBeat = Date.now();
        beatRoom = beat.room;
        remoteCounts.set(beat.room, data.clients);
      } else {
        // сервер старше и про beat ничего не знает: откат на прежние POST-маяки
        serverBeats = false;
        await pingPresence();
      }
    } else if (!serverBeats && Date.now() - lastBeat >= BEAT_MS) {
      // старый сервер: бит в pull не принимается, онлайн догоняем отдельным POST по расписанию
      lastBeat = Date.now();
      await pingPresence();
    }
    const pulled = data && data.messages ? data.messages.length : 0;
    await store.tx((st) => {
      st.sync = { lastPull: (data && data.now) || Date.now(), online: true };
    });
    broadcast("sync", { online: true, pulled });
    return { mode: "remote", online: true, pulled, held: Date.now() - started };
  } catch (err) {
    await store.tx((st) => {
      st.sync = { ...(st.sync || {}), online: false, error: String(err.message || err) };
    });
    broadcast("sync", { online: false, error: String(err.message || err) });
    return { mode: "remote", online: false, pulled: 0, held: Date.now() - started };
  }
}

/* Единственный цикл, который держит канал живым. Шаг задаёт видимость: смотрим в чат —
   long-poll; ничего не видим — редкая выгрузка раз в минуту. Chrome убивает service
   worker без событий, поэтому будильник раз в 30 с остался: сам он сервер не трогает,
   он лишь перезапускает цикл, если воркер уснул вместе с hold-запросом. */
async function liveLoop() {
  if (liveRunning) return;
  liveRunning = true;
  try {
    for (;;) {
      const prefs = await store.getSettings();
      if (!prefs.serverUrl) return; // локальный режим: ни одного запроса наружу
      const visible = !!activeRoom();
      const r = await syncOnce({ wait: visible ? WAIT_SEC : 0 });
      if (r.mode === "local") return;
      if (!visible) {
        await sleep(IDLE_MS);
        continue;
      }
      if (!r.online) {
        await sleep(FALLBACK_MS);
        continue;
      }
      // держал почти всё отпущенное время или принёс новости — канал горячий, идём дальше;
      // ответил пустым досрочно — сервер не умеет wait, шагаем сами
      if (r.pulled === 0 && r.held < WAIT_SEC * 1000 - 2000) await sleep(Math.max(2000, FALLBACK_MS - r.held));
    }
  } finally {
    liveRunning = false;
  }
}

function liveTick() {
  liveLoop().catch(() => {});
}

// счётчик комнаты нужен прямо сейчас (чат только что открыли или переключились на вкладку) —
// один POST вместо ожидания ближайшего бита
async function beatOnce() {
  const prefs = await store.getSettings();
  if (!prefs.serverUrl) return;
  const room = activeRoom();
  if (!room || room.key === beatRoom || Date.now() - lastBeat < 10_000) return;
  const identity = await store.getIdentity();
  const cut = room.key.lastIndexOf("#");
  try {
    /* Новый воркер считает онлайн по токену комнаты, и адрес страницы ему не показывает.
       Старый сервер (Supabase, server/server.js) токена не знает — ему по-прежнему нужен
       сырой url#lang, иначе счётчик комнаты вовсе перестанет сходиться. */
    const body = serverBeats
      ? { id: `${identity.pub}:${room.client}`, room: await store.roomToken(room.key) }
      : {
          id: `${identity.pub}:${room.client}`,
          url: room.key.slice(0, cut),
          lang: room.key.slice(cut + 1),
        };
    const res = await remote("/api/presence", body);
    if (res && typeof res.clients === "number") {
      remoteCounts.set(room.key, res.clients);
      lastBeat = Date.now();
      beatRoom = room.key;
    }
  } catch {
    /* сервер офлайн: оставляем последний известный счётчик */
  }
}

chrome.alarms.create("orbita-sync", { periodInMinutes: 0.5 });
chrome.alarms.create("orbita-badge", { periodInMinutes: 0.5 });
chrome.alarms.create("orbita-global", { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "orbita-sync") liveTick();
  if (alarm.name === "orbita-badge") scheduleBadge();
  if (alarm.name === "orbita-global") globalHeartbeat();
});
liveTick();
globalHeartbeat(true);

async function ensureContent(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "overlay:ping" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return true;
    } catch {
      return false;
    }
  }
}

function openStandalone(tab, url) {
  openChatTab(url, tab.title || url, guessLang());
}

// A page that failed to load (typo, dead or made-up domain) shows Chrome's own error
// screen, which is neither http(s) nor injectable — so the address the user typed is
// taken from what we remembered for this tab and the chat opens on that channel.
function webUrl(tab) {
  const u = tab.url || tab.pendingUrl || "";
  if (/^https?:/.test(u)) {
    if (tab.id != null) tabUrls.set(tab.id, u);
    return u;
  }
  if (/^chrome-error:/.test(u) && tab.id != null) return tabUrls.get(tab.id) || u;
  return u;
}

async function toggleForTab(tab) {
  const self = chrome.runtime.getURL("chat.html");
  if ((tab.url || "").startsWith(self)) {
    if (tab.id != null) chrome.tabs.remove(tab.id);
    return;
  }
  const url = webUrl(tab);
  if (!/^https?:/.test(url)) {
    openStandalone(tab, url);
    return;
  }
  const ok = await ensureContent(tab);
  if (!ok) {
    openStandalone(tab, url);
    return;
  }
  chrome.tabs
    .sendMessage(tab.id, { type: "overlay:toggle", url, title: tab.title || url })
    .catch(() => {});
}
chrome.action.onClicked.addListener((tab) => toggleForTab(tab));
chrome.commands.onCommand.addListener(async (command, maybeTab) => {
  if (command !== "toggle-overlay" && command !== "toggle-overlay-alt") return;
  const tab = maybeTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (tab) toggleForTab(tab);
});

/* Строка «Моего сообщения» и кнопка «войти» ведут на сам сайт, а не на служебную
   вкладку чата: сначала открывается страница, а оверлей навешивается когда она
   догрузилась. Прежний chat.html остаётся запасным путём — для chrome://, скрытых
   доменов и сайтов, которые скрипт extensions не принимают. */
const pendingOverlay = new Map();

async function openChatTab(url, title, lang, msg) {
  const base = chrome.runtime.getURL("chat.html");
  /* Та же комната уже открыта вкладкой — переключаемся на неё: иначе каждое
     нажатие иконки на «мёртвом» сайте плодило ещё одну вкладку чата. */
  try {
    const tabs = await chrome.tabs.query({ url: `${base}*` });
    for (const t of tabs) {
      let q;
      try {
        q = new URL(t.url).searchParams;
      } catch {
        continue;
      }
      if (q.get("url") !== url) continue;
      if (msg && q.get("msg") !== msg) continue;
      await chrome.tabs.update(t.id, { active: true });
      if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      return t.id;
    }
  } catch {
    /* без доступа к вкладкам просто создадим новую */
  }
  const q = new URLSearchParams({ url, title: title || "", lang: lang || guessLang() });
  if (msg) q.set("msg", msg);
  const created = await chrome.tabs.create({ url: `${base}?${q}` });
  return created && created.id;
}

async function attachOverlay(tabId, info) {
  const ok = await ensureContent({ id: tabId });
  if (!ok) {
    openChatTab(info.url, "", info.lang, info.msg);
    return false;
  }
  chrome.tabs
    .sendMessage(tabId, {
      type: "overlay:open",
      url: info.url,
      lang: info.lang,
      msg: info.msg || "",
    })
    .catch(() => {});
  return true;
}

/* Вкладка считается той же страницей, когда совпадают хост и путь: адрес из ленты
   мог приехать с utm-хвостом или якорем, а открывать второй экземп той же страницы
   нельзя. */
function pageKey(u) {
  try {
    const x = new URL(u);
    return `${x.host.toLowerCase().replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "/")}`;
  } catch {
    return String(u || "");
  }
}

async function openSite(msg) {
  const url = msg.url || "";
  const info = { url, lang: msg.lang || guessLang(), msg: msg.msg || "" };
  if (!/^https?:/.test(url) || (await isHiddenDomain(url))) {
    openChatTab(url, "", info.lang, info.msg);
    return { ok: true, mode: "chat" };
  }
  const tabs = await chrome.tabs.query({});
  const live = tabs.find((t) => pageKey(t.url || "") === pageKey(url));
  if (live) {
    await chrome.tabs.update(live.id, { active: true });
    if (live.windowId != null) await chrome.windows.update(live.windowId, { focused: true });
    await attachOverlay(live.id, info);
    return { ok: true, mode: "reuse" };
  }
  const created = await chrome.tabs.create({ url });
  if (created.id == null) return { ok: true, mode: "new" };
  if (created.status === "complete") {
    pendingOverlay.delete(created.id);
    await attachOverlay(created.id, info);
  } else {
    pendingOverlay.set(created.id, info);
  }
  return { ok: true, mode: "new" };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  presence.delete(`tab:${tabId}`);
  tabUrls.delete(tabId);
  pendingOverlay.delete(tabId);
  scheduleBadge();
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const u = info.url || tab.url;
  // remember every address as early as "loading": a navigation that then fails
  // (DNS error, refused connection) leaves only chrome-error:// on the tab
  if (/^https?:/.test(u || "")) tabUrls.set(tabId, u);
  if (info.status === "complete") {
    scheduleBadge();
    const pend = pendingOverlay.get(tabId);
    // страница догрузилась (или не догрузилась — тогда ведём в служебную вкладку)
    if (pend) {
      pendingOverlay.delete(tabId);
      attachOverlay(tabId, pend);
    }
  }
});
chrome.tabs.onActivated.addListener(() => scheduleBadge());

async function handle(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.cmd) {
    case "global:stats": return { ok: true, online: globalOnline, rooms: await globalRooms() };
    case "global:open": {
      const lang = String(msg.lang || "en").toLowerCase();
      if (!["ru","en","de","fr","es","it","ja","zh"].includes(lang)) return { ok: false };
      const roomUrl = `https://global.orbita.invalid/${lang}`;
      const tabUrl = chrome.runtime.getURL("chat.html") + `?url=${encodeURIComponent(roomUrl)}&title=${encodeURIComponent("Orbita Global · " + lang.toUpperCase())}&lang=${lang}`;
      await chrome.tabs.create({ url: tabUrl });
      return { ok: true };
    }
    case "page:register": {
      if (tabId != null) tabUrls.set(tabId, msg.url);
      return { ok: true, hidden: await isHiddenDomain(msg.url) };
    }
    case "channel:open": {
      bumpPresence(await roomKey(msg.url, msg.lang), sender, msg.visible !== false);
      liveTick();
      await beatOnce();
      return { ok: true, clients: await clientsForUrl(msg.url, msg.lang) };
    }
    case "channel:close": {
      dropPresence(sender);
      return { ok: true };
    }
    case "mirror:list":
      return { ok: true, group: await store.mirrorsFor(msg.url) };
    case "mirror:add": {
      const res = await store.addMirror(msg);
      if (res && res.ok) broadcast("mirror", { url: msg.base });
      return res;
    }
    case "mirror:remove": {
      const res = await store.removeMirror(msg);
      if (res && res.ok) broadcast("mirror", { url: msg.url });
      return res;
    }
    case "overlay:fallback": {
      openChatTab(msg.url, msg.title, msg.lang, msg.msg);
      return { ok: true };
    }
    case "presence": {
      // маяк открытого чата: держит локальную карту вкладок живой (даже после сна SW)
      // и будит цикл. Сам на сервер он не ходит — онлайн теперь едет внутри pull
      if (msg.lang) {
        bumpPresence(await roomKey(msg.url, msg.lang), sender, msg.visible !== false);
        wakeLive();
        liveTick();
        await beatOnce();
      }
      return {
        ok: true,
        clients: await clientsForUrl(msg.url, msg.lang),
        lang: msg.lang,
        group: await store.mirrorsFor(msg.url),
      };
    }
    case "msg:post": {
      const res = await store.postMessage(msg);
      if (res && res.message) {
        broadcast("message", { message: res.message });
        if (tabId != null) bumpPresence(await roomKey(msg.url, msg.lang), sender);
        // на сервер уходит сразу: сосед держит long-poll и получит сообщение за секунду,
        // а не после ближайшего шага опроса
        pushNow(res.message);
      }
      return res;
    }
    case "msg:delete": {
      const res = await store.deleteMessage(msg.msgId);
      if (res && res.deleted) {
        pushDelete(res.deleted, res.by);
        broadcast("msg:deleted", { msgId: res.deleted });
      }
      return res;
    }
    case "feed:get":
      return { ok: true, messages: await store.feed(msg) };
    case "lenta:get":
      return { ok: true, rows: await store.lenta(msg) };
    case "mine:get":
      return { ok: true, rows: await store.myPosts(msg) };
    case "answers:get": {
      const res = await store.answers(msg);
      return { ok: true, rows: res.rows, unread: res.unread };
    }
    case "answers:read":
      return await store.readAnswer(msg.id);
    case "vote": {
      const res = await store.vote(msg.msgId, msg.dir);
      if (res) {
        const msg2 = await store.tx((st) => st.messages[msg.msgId], true);
        // rm — явное «вычеркни этот alias»: пустой массив серверunion'ит, а не читает как снятие
        if (msg2) pushPatch(msg.msgId, { up: msg2.up, down: msg2.down, rm: res.withdrawn || {} });
        broadcast("vote", { msgId: msg.msgId, score: res.score, myVote: res.myVote });
      }
      return res;
    }
    case "star": {
      const res = await store.toggleStar(msg.msgId);
      if (res && res.quota) broadcast("quota", res.quota);
      if (res && !res.error) {
        const msg2 = await store.tx((st) => st.messages[msg.msgId], true);
        if (msg2) pushPatch(msg.msgId, { stars: msg2.stars, rm: res.withdrawn || {} });
        broadcast("star", { msgId: msg.msgId, starred: res.starred });
      }
      return res;
    }
    case "report": {
      const res = await store.report(msg.msgId);
      if (res) {
        const msg2 = await store.tx((st) => st.messages[msg.msgId], true);
        if (msg2) pushPatch(msg.msgId, { reports: msg2.reports, rm: res.withdrawn || {} });
        broadcast("report", { msgId: msg.msgId, ...res });
      }
      return res;
    }
    case "effect": {
      const res = await store.applyEffect(msg.msgId, msg.type);
      if (res && res.message) {
        pushPatch(msg.msgId, { effect: res.message.effect });
        broadcast("effect", { msgId: msg.msgId, effect: res.message.effect });
      }
      return res;
    }
    case "quota:get":
      return { ok: true, quota: await store.starQuota(), fx: await store.fxQuota() };
    case "identity:get":
      return { ok: true, identity: await store.getIdentity(msg.url) };
    case "identity:set":
      return { ok: true, identity: await store.setIdentity(msg.patch, msg.url) };
    case "identity:reset_site":
      return { ok: true, identity: await store.resetSiteIdentity(msg.url) };
    case "settings:get":
      return { ok: true, settings: await store.getSettings() };
    case "settings:set":
      return { ok: true, settings: await store.setSettings(msg.patch) };
    case "sound:get":
      return { ok: true, dataUrl: await store.getCustomSound() };
    case "sound:set": {
      const res = await store.setCustomSound(msg.dataUrl);
      if (res && res.ok) broadcast("sound", {});
      return res;
    }
    case "channels:list":
      return { ok: true, recent: await store.recentChannels() };
    case "stats":
      return { ok: true, stats: await store.stats() };
    case "sync:now":
      return await syncOnce({ wait: msg.wait });
    case "data:clear":
      await store.clearAll();
      broadcast("cleared", {});
      return { ok: true };
    case "site:open":
      return await openSite(msg);
    case "site:hide": {
      const prefs = await store.getSettings();
      const list = new Set(prefs.hiddenDomains || []);
      list.add(msg.domain);
      await store.setSettings({ hiddenDomains: Array.from(list) });
      broadcast("settings", {});
      return { ok: true };
    }
    default:
      return { error: "unknown_cmd", cmd: msg.cmd };
  }
}

async function isHiddenDomain(url) {
  const prefs = await store.getSettings();
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return (prefs.hiddenDomains || []).some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (!msg.cmd && msg.type !== "overlay:toggle" && msg.type !== "chat:close")) return;
  if (msg.type === "overlay:toggle") {
    toggleForTab(sender.tab || { id: sender.tabId, url: msg.url, title: msg.title });
    sendResponse({ ok: true });
    return;
  }
  /* Отдельная вкладка чата: у неё нет родительского окна, поэтому «✕» просит
     фон закрыть вкладку — иначе кнопка не делала ничего. */
  if (msg.type === "chat:close") {
    /* sender.tab у страницы расширения есть не всегда — тогда закрываем активную
       вкладку, если это действительно наш чат. */
    (async () => {
      let id = sender.tab ? sender.tab.id : null;
      if (id == null) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        const base = chrome.runtime.getURL("chat.html");
        if (active && (active.url || "").startsWith(base)) id = active.id;
      }
      if (id != null) await chrome.tabs.remove(id);
    })().then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
  handle(msg, sender).then(
    (result) => sendResponse(result),
    (err) => sendResponse({ error: String(err && err.message ? err.message : err) })
  );
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  store.getSettings().then((prefs) => {
    const guessed = (navigator.language || "en").split("-")[0].toLowerCase();
    const uiLang = prefs.uiLang || (UI_LANGS.includes(guessed) ? guessed : "en");
    if (!prefs.uiLang) store.setSettings({ uiLang });
    chrome.contextMenus?.create?.({
      id: "orbita-open",
      title: `Orbita: ${makeT(uiLang)("lenta.channel")}`,
      contexts: ["page"],
    });
  });
  scheduleBadge();
});
chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId === "orbita-open" && tab) toggleForTab(tab);
});

/* Окно для tests/test_transport.mjs: тот же фон подделками chrome.*, но без real browser.
   Расширению экспорт не мешает — MV3 воркер его просто игнорирует. */
export const testOnly = {
  handle,
  beatQuery,
  liveLoop,
  wakeLive,
  resetBeat() {
    lastBeat = 0;
    beatRoom = "";
  },
  setServerBeats(v) {
    serverBeats = v;
  },
};
