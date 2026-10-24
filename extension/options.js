import { makeT, UI_LANGS } from "./locales.js";
import { langName } from "./flags.js";
import { LANGS, PRIMARY_CODES } from "./langs.js";
import { normalizeUrl } from "./sanitize.js";

const $ = (id) => document.getElementById(id);
const send = (cmd, payload = {}) => chrome.runtime.sendMessage({ cmd, ...payload });

let t = makeT("ru");
let settings = {};
let identity = {};

function openChannel(url, lang) {
  const target = chrome.runtime.getURL(
    `chat.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}`
  );
  chrome.tabs.create({ url: target });
}

function paint() {
  $("title").textContent = t("app.tagline");
  $("secEntry").textContent = t("entry.title");
  $("channel").placeholder = t("entry.placeholder");
  $("go").textContent = t("entry.go");
  $("entryNote").textContent = t("entry.note");
  $("secRecent").textContent = t("entry.recent");
  $("secIdentity").textContent = t("opt.identity");
  $("secSiteNicks").textContent = t("opt.site_nicks");
  $("lblAnon").textContent = t("opt.anon");
  $("lblName").textContent = t("opt.name");
  $("avatarNote").textContent = t("opt.avatar_lock");
  $("nameWarn").textContent = t("opt.name_warn");
  $("secServer").textContent = t("opt.server");
  $("lblSync").textContent = t("opt.sync");
  $("serverHint").textContent = t("opt.server_hint");
  $("secUi").textContent = t("ui.title");
  $("lblUiLang").textContent = t("opt.ui_lang");
  $("lblFilter").textContent = t("opt.filter");
  $("lblShowHidden").textContent = t("msg.show_hidden");
  $("lblEnabled").textContent = t("opt.enabled");
  $("secSites").textContent = t("sites.title");
  $("secData").textContent = t("opt.data");
  $("secHow").textContent = t("opt.rules");
  $("clear").textContent = t("opt.clear");
  $("rules").textContent = t("opt.rules");
  $("howto").replaceChildren(
    ...["howto.1", "howto.2", "howto.3", "howto.4"].map((k) => {
      const li = document.createElement("li");
      li.textContent = t(k);
      return li;
    })
  );
}

function paintForm() {
  $("anon").checked = !!identity.anon;
  $("name").value = identity.name || "";
  $("syncOn").checked = settings.syncOn !== false;
  $("uiLang").value = settings.uiLang || "ru";
  $("filter").checked = settings.filter !== false;
  $("showHidden").checked = !!settings.showHidden;
  $("enabled").checked = settings.enabled !== false;
  const list = $("hiddenList");
  list.replaceChildren();
  const domains = settings.hiddenDomains || [];
  if (!domains.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "—";
    list.appendChild(li);
  }
  domains.forEach((domain) => {
    const li = document.createElement("li");
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = domain;
    const btn = document.createElement("button");
    btn.className = "l";
    btn.type = "button";
    btn.textContent = "✕";
    btn.addEventListener("click", async () => {
      const next = (await currentSettings()).hiddenDomains.filter((d) => d !== domain);
      await send("settings:set", { patch: { hiddenDomains: next } });
      await load();
    });
    li.append(u, btn);
    list.appendChild(li);
  });
  paintNicks();
}

async function currentSettings() {
  const res = await send("settings:get");
  return (res && res.settings) || {};
}

function paintNicks() {
  const list = $("nickList");
  list.replaceChildren();
  const sites = Object.entries(identity.sites || {});
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "—";
    list.appendChild(li);
    return;
  }
  sites.forEach(([host, site]) => {
    const li = document.createElement("li");
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = `${host} — ${site.anon === false ? site.name || "—" : t("composer.anon")}`;
    const btn = document.createElement("button");
    btn.className = "l";
    btn.type = "button";
    btn.textContent = "✕";
    btn.title = t("profile.reset_site");
    btn.addEventListener("click", async () => {
      await send("identity:reset_site", { url: host });
      await load();
    });
    li.append(u, btn);
    list.appendChild(li);
  });
}

function paintRecent(recent) {
  const list = $("recentList");
  list.replaceChildren();
  if (!recent.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = t("msg.empty");
    list.appendChild(li);
    return;
  }
  recent.forEach((row) => {
    const li = document.createElement("li");
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = row.title && row.title !== row.url ? `${row.title} — ${row.url}` : row.url;
    const btn = document.createElement("button");
    btn.className = "l";
    btn.type = "button";
    btn.textContent = row.lang;
    btn.title = t("entry.go");
    btn.addEventListener("click", () => openChannel(row.url, row.lang));
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = new Date(row.lastTs).toLocaleString();
    li.append(u, btn, time);
    list.appendChild(li);
  });
}

async function load() {
  settings = await currentSettings();
  const idRes = await send("identity:get");
  identity = (idRes && idRes.identity) || {};
  const st = await send("stats");
  const chans = await send("channels:list");
  const s = (st && st.stats) || { channels: [], messages: 0 };
  const bytes = await chrome.storage.local.get("orbita.state").then((v) => JSON.stringify(v).length);
  $("dataStats").textContent = `${t("opt.storage_used")}: ${(bytes / 1024).toFixed(1)} KB · ${s.messages} msg · ${s.channels.length} channels`;
  t = makeT(settings.uiLang || "ru");
  paint();
  paintForm();
  paintRecent((chans && chans.recent) || []);
  await checkServer();
}

async function patchSettings(patch) {
  await send("settings:set", { patch });
  settings = await currentSettings();
  t = makeT(settings.uiLang || "ru");
  paint();
}

/* Статус сервера без самого адреса: адрес зашит, и показывать его в интерфейсе незачем. */
async function checkServer() {
  const box = $("serverState");
  const url = (settings.serverUrl || "").replace(/\/+$/, "");
  if (!url) {
    box.textContent = t("opt.server_state_off");
    box.className = "state";
    return;
  }
  box.textContent = "…";
  box.className = "state";
  try {
    const res = await fetch(`${url}/api/health`);
    const data = await res.json();
    box.textContent = `ok · ${data.clients || 0} online`;
    box.className = "state ok";
  } catch (err) {
    box.textContent = `fail: ${err.message}`;
    box.className = "state bad";
  }
}

function bind() {
  const go = () => {
    const raw = $("channel").value.trim();
    if (!raw) return;
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    openChannel(normalizeUrl(url), $("lang").value);
  };
  $("go").addEventListener("click", go);
  $("channel").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      go();
    }
  });
  $("anon").addEventListener("change", async (e) => {
    await send("identity:set", { patch: { anon: e.target.checked } });
    const res = await send("identity:get");
    identity = res.identity;
  });
  $("name").addEventListener("change", async (e) => {
    await send("identity:set", { patch: { name: e.target.value.trim(), anon: false } });
    const res = await send("identity:get");
    identity = res.identity;
    paintForm();
  });
  $("syncOn").addEventListener("change", async (e) => {
    await patchSettings({ syncOn: e.target.checked });
    await checkServer();
  });
  $("uiLang").addEventListener("change", (e) => patchSettings({ uiLang: e.target.value }));
  $("filter").addEventListener("change", (e) => patchSettings({ filter: e.target.checked }));
  $("showHidden").addEventListener("change", (e) => patchSettings({ showHidden: e.target.checked }));
  $("enabled").addEventListener("change", (e) => patchSettings({ enabled: e.target.checked }));
  $("addHidden").addEventListener("click", async () => {
    const domain = $("hiddenInput").value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!domain) return;
    const next = Array.from(new Set([...(settings.hiddenDomains || []), domain]));
    await patchSettings({ hiddenDomains: next });
    $("hiddenInput").value = "";
    paintForm();
  });
  $("testServer").addEventListener("click", async () => {
    await checkServer();
    await send("sync:now");
  });
  $("clear").addEventListener("click", async () => {
    if (!confirm(`${t("opt.clear")}?`)) return;
    await send("data:clear");
    await load();
  });
}

async function init() {
  UI_LANGS.forEach((code) => $("uiLang").add(new Option(langName(code) || code.toUpperCase(), code)));
  [...PRIMARY_CODES, ...LANGS.filter((l) => !PRIMARY_CODES.includes(l.code)).map((l) => l.code)].forEach((code) =>
    $("lang").add(new Option(code, code))
  );
  $("lang").value = (navigator.language || "en").split("-")[0].toLowerCase();
  if (!$("lang").value) $("lang").value = "en";
  await load();
  bind();
}

init();
