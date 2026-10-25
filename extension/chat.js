import { PRIMARY_CODES, searchLangs } from "./langs.js";
import { makeT, UI_LANGS } from "./locales.js";
import { LANG_META, flagSvg, langName } from "./flags.js";
import { SKINS, SPECIAL_SKINS, DEFAULT_THEME, skinById, applyTheme, normalizeTheme, avatarArt } from "./themes.js";
import { normalizeUrl } from "./sanitize.js";
import { createScene } from "./scene.js";
import { play as playSound, unlock as unlockSound, SOUND_TONES } from "./sound.js";

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const send = (cmd, payload = {}) => chrome.runtime.sendMessage({ cmd, ...payload });

const THEME_KEY = "orbita.theme";
const COLLAPSED_KEY = "orbita.collapsed";
const GEOM_KEY = "orbita.geom";
const NAME_MAX = 67;
const BG_FITS = ["cover", "contain", "tile", "center", "repeat-x", "repeat-y"];
const BG_MAX_PX = 1400;
const EMBEDDED = window.parent !== window;
/* Inside the overlay the iframe width is not the screen width: the host tells us
   its own viewport size, so the drawers only float on a genuinely small screen. */
let hostVw = Number(params.get("vw")) || 0;
const screenWidth = () => (EMBEDDED && hostVw ? hostVw : window.innerWidth);
const applyDrawerMode = () => {
  document.documentElement.classList.toggle("drawers-float", screenWidth() <= 900);
};
const toHost = (action, payload = {}) => {
  if (EMBEDDED) parent.postMessage({ source: "orbita-chat", action, ...payload }, "*");
};
// registered at module level: the host answers our "ready" before init() finishes
addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || d.source !== "orbita-host") return;
  if (d.action === "viewport") {
    const vw = Number(d.vw) || 0;
    if (vw === hostVw) return;
    hostVw = vw;
    applyDrawerMode();
    if (EMBEDDED) syncPanels("rebind");
    return;
  }
  // оверлей этого сайта был открыт заранее — хост просит только прокрутить к комменту
  if (d.action === "goto" && d.msg) jumpToMessage(String(d.msg));
});

/* Два рабочих значка тянутся мышкой на сообщение; остальные — витрина «скоро».
   max совпадает с FX_QUOTA в store.js: карточка показывает остаток заряда. */
const EFFECTS = [
  { id: "flame", art: "flame", name: "fx.flame", desc: "fx.flame.desc", max: 3, locked: false },
  { id: "shield", art: "shield", name: "fx.shield", desc: "fx.shield.desc", max: 1, locked: false },
  { id: "meteor", emo: "☄️", name: "fx.meteor", desc: "fx.locked", locked: true },
  { id: "storm", emo: "⛈️", name: "fx.storm", desc: "fx.locked", locked: true },
  { id: "void", emo: "🕳️", name: "fx.void", desc: "fx.locked", locked: true },
  { id: "crown", emo: "👑", name: "fx.crown", desc: "fx.locked", locked: true },
];
const fxById = (id) => EFFECTS.find((fx) => fx.id === id) || null;/* старый бэкенд мог оставить эффект «dragon» — он тот же огонь */
const fxType = (effect) => (effect ? (effect.type === "dragon" ? "flame" : effect.type) : null);

/* «последние» стоит первым и там, и там: это не окно по времени, а весь разговор
   по порядку времени — когда человек только что зашёл, ему нужна лента целиком. */
const PERIODS = ["recent", "day", "week", "month", "year", "all"];
const VIEWS = ["all", "important", "mine", "top"];

const state = {
  url: params.get("url") || "",
  title: params.get("title") || "",
  lang: params.get("lang") || "en",
  view: "all",
  period: "recent",
  lentaTab: "global",
  lentaPeriod: "day",
  lentaLang: "*",
  jumpTo: params.get("msg") || "",
  q: "",
  identity: null,
  settings: null,
  quota: { used: 0, left: 10 },
  fx: null,
  clients: 0,
  group: { home: "", urls: [] },
  // значок можно взвести кликом и нанести кликом по аватару, а можно перетащить мышкой
  armed: null,
  // разовая вспышка удара: живёт ~1.5 с и переживает перерисовку ленты
  hit: null,
  quote: null,
  messages: [],
  rows: [],
  // чужие ответы на мои сообщения: строки правой панели и их счётчик
  answers: [],
  answersUnread: 0,
  // чужие ответы на мои сообщения: id родителя → сколько раз ответили
  answered: new Map(),
  theme: normalizeTheme(null),
  collapsed: {},
  // решение сообщества спрятало комментарий — 👁 открывает его на это окно просмотра
  revealed: {},
  // звук: свои сообщения молчат, поэтому помним, что уже показали
  seen: new Set(),
  soundReady: false,
  soundFloor: 0,
  customSound: "",
};

/* Живой фон на canvas. Сцена включается только у стеклянного скина; ползунки
   «Пузыри» и «Солнце» задают, что рисовать, а скорость — максимум из них. */
const scene = createScene(document.getElementById("bgScene"));
scene.load("bg/aero.jpg");

function paintScene() {
  const skin = skinById(state.theme.skin);
  const live = state.theme.live || {};
  scene.configure({
    active: !!skin.glass,
    bubbles: Number(live.bubbles) || 0,
    sun: Number(live.sun) || 0,
  });
}

const DEFAULT_SOUND = { on: true, tone: "chime", volume: 0.6 };
// тот же потолок, что в store.js: 3 MB исходника в base64 весят ~4 MB
const SOUND_MAX_BYTES = 3 * 1024 * 1024;

let t = makeT("ru");
let myId = "";
/* До v0.3.0 автором и голосующим был сам deviceId. Строки с ним никуда не делись из
   локальной базы, поэтому «моё» — это и алиас, и старый deviceId: иначе после обновления
   свои комментарии стали бы чужими (без 🗑), а собственные голоса — пропавшими. */
let myIds = [];
const isMine = (authorId) => !!authorId && myIds.includes(authorId);
const among = (list) => (list || []).some((x) => myIds.includes(x));

function storeGet(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => resolve(res ? res[key] : undefined));
    } catch {
      resolve(undefined);
    }
  });
}

function storeSet(key, value) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

/* orbita.geom keeps a per-host entry, and older builds stored the size flat on the
   root — the flat shape is what a fresh install falls back to. */
function geomFor(raw, host) {
  if (!raw || typeof raw !== "object") return {};
  const base = raw.default && typeof raw.default === "object" ? raw.default : raw;
  const site = raw.sites && raw.sites[host] ? raw.sites[host] : null;
  return { ...base, ...(site || {}) };
}

function applyStandSize(g) {
  if (EMBEDDED) return;
  const style = document.documentElement.style;
  if (g.w) style.setProperty("--stand-w", `${g.w}px`);
  if (g.h) style.setProperty("--stand-h", `${g.h}px`);
}

/* Сайт не открылся — чат живёт отдельной вкладкой. Chrome не пускает скрипты на свою
   страницу ошибки, поэтому оверлея поверх неё не будет; зато окно чата здесь ведёт
   себя как настоящий оверлей: таскается за шапку, тянется за угол, запоминает место
   в том же orbita.geom, что и оверлей на живом сайте. */
const STAND_MIN = { w: 460, h: 420 };

function initStandaloneWindow(raw, geom) {
  const wrap = document.querySelector(".wrap");
  if (!wrap) return;
  const host = siteHost();
  const store = raw && typeof raw === "object" ? structuredClone(raw) : {};
  if (!store.default || typeof store.default !== "object") store.default = {};
  if (!store.sites || typeof store.sites !== "object") store.sites = {};

  let w = Math.max(STAND_MIN.w, Number(geom.w) || 1240);
  let h = Math.max(STAND_MIN.h, Number(geom.h) || 700);
  let x = Number.isFinite(Number(geom.x)) ? Number(geom.x) : Math.round((innerWidth - w) / 2);
  let y = Number.isFinite(Number(geom.y)) ? Number(geom.y) : Math.round((innerHeight - h) / 2);

  const clamp = () => {
    w = Math.min(Math.max(STAND_MIN.w, w), Math.max(STAND_MIN.w, innerWidth - 16));
    h = Math.min(Math.max(STAND_MIN.h, h), Math.max(STAND_MIN.h, innerHeight - 16));
    x = Math.min(Math.max(8, x), Math.max(8, innerWidth - w - 8));
    y = Math.min(Math.max(8, y), Math.max(8, innerHeight - h - 8));
  };

  const paint = () => {
    clamp();
    wrap.style.position = "fixed";
    wrap.style.left = `${Math.round(x)}px`;
    wrap.style.top = `${Math.round(y)}px`;
    wrap.style.width = `${Math.round(w)}px`;
    wrap.style.height = `${Math.round(h)}px`;
  };

  let saveTimer = 0;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const box = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
      Object.assign(store.default, box);
      store.sites[host] = { ...(store.sites[host] || {}), ...box };
      storeSet(GEOM_KEY, store);
    }, 250);
  };

  paint();

  // тянем за шапку, но не за кнопки, поле поиска и селекты
  const top = document.querySelector(".top");
  top.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 || ev.target.closest("button, input, select, label, .search")) return;
    const sx = ev.clientX;
    const sy = ev.clientY;
    const ox = x;
    const oy = y;
    const move = (e) => {
      x = ox + (e.clientX - sx);
      y = oy + (e.clientY - sy);
      paint();
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      save();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
    ev.preventDefault();
  });

  // уголок в правом нижнем углу — размер
  const grip = document.createElement("div");
  grip.className = "stand-grip";
  wrap.appendChild(grip);
  grip.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const sx = ev.clientX;
    const sy = ev.clientY;
    const ow = w;
    const oh = h;
    const move = (e) => {
      w = ow + (e.clientX - sx);
      h = oh + (e.clientY - sy);
      paint();
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      save();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
    ev.preventDefault();
  });

  window.addEventListener("resize", paint);
}

/* ---------- locale ---------- */

function applyLocale() {
  t = makeT(state.settings ? state.settings.uiLang : "ru");
  document.documentElement.lang = state.settings ? state.settings.uiLang : "ru";
  $("fxTitle").textContent = t("fx.title");
  $("fxHint").textContent = t("fx.hint");
  $("fxSoon").textContent = t("fx.soon");
  $("lentaTabs").setAttribute("aria-label", t("lenta.title"));
  $("lentaHint").textContent = t("lenta.hint");
  $("lblTop").textContent = t("view.top");
  $("lblHot").textContent = "Hot";
  $("text").placeholder = t("composer.placeholder");
  $("send").textContent = "➤";
  $("composerHint").textContent = t("composer.rules");
  $("optIdentity").textContent = t("opt.identity");
  $("who").title = t("opt.identity");
  $("optAnon").textContent = t("opt.anon");
  $("optName").textContent = t("opt.name");
  $("optAvatar").textContent = t("opt.avatar");
  $("avatarLock").textContent = t("opt.avatar_lock");
  $("optFilter").textContent = t("opt.filter");
  $("optShowHidden").textContent = t("msg.show_hidden");
  $("optUiLang").textContent = t("opt.ui_lang");
  $("rulesLink").textContent = t("opt.rules");
  $("optionsLink").textContent = t("opt.settings");
  $("nameWarn").textContent = t("opt.name_warn");
  $("closeBtn").title = t("header.close");
  $("fxToggle").title = t("fx.title");
  $("lentaToggle").title = t("lenta.title");
  $("themeBtn").title = t("theme.title");
  $("q").placeholder = t("search.placeholder");
  $("themeTitle").textContent = t("theme.title");
  $("lblSkins").textContent = t("theme.skins");
  $("lblSpecial").textContent = t("theme.special");
  $("lblOpacity").textContent = t("theme.opacity");
  $("lblBlur").textContent = t("theme.blur");
  $("lblPanel").textContent = t("theme.panel");
  $("lblLive").textContent = t("theme.live");
  $("lblBubbles").textContent = t("theme.live.bubbles");
  $("lblSun").textContent = t("theme.live.sun");
  $("lblPlants").textContent = t("theme.live.plants");
  $("lblSphere").textContent = t("theme.sphere");
  $("lblGrad").textContent = t("theme.gradient");
  $("lblAngle").textContent = t("theme.angle");
  $("lblGradAlpha").textContent = t("theme.alpha");
  $("lblBg").textContent = t("theme.background");
  $("lblBgFit").textContent = t("theme.fit");
  $("lblBgAlpha").textContent = t("theme.alpha");
  $("bgClear").textContent = "✕";
  $("bgClear").title = t("theme.bg_clear");
  $("themeReset").textContent = t("theme.reset");
  $("lblSound").textContent = t("sound.title");
  $("lblSoundOn").textContent = t("sound.on");
  $("lblSoundFile").textContent = t("sound.file");
  $("soundClear").textContent = "✕";
  $("soundClear").title = t("sound.clear");
  $("profileBtn").title = t("opt.identity");
  $("uiLangBtn").title = t("opt.ui_lang");
  $("uiLangTitle").textContent = t("opt.ui_lang");
  $("mirrorBtn").title = t("mirror.btn");
  $("mirrorTitle").textContent = t("mirror.title");
  $("mirrorHint").textContent = t("mirror.hint");
  $("mirrorAdd").title = t("mirror.add");
  paintProfileSite();
  paintNameCount();
  renderMirror();
  $("bgFit").replaceChildren();
  BG_FITS.forEach((f) => $("bgFit").add(new Option(t(`fit.${f}`), f)));
  renderHeader();
  renderFx();
  renderComposer();
  renderSkins();
  renderSound();
}

function renderHeader() {
  const periodSel = $("period");
  const lentaSel = $("lentaPeriod");
  if (!periodSel.options.length) {
    PERIODS.forEach((p) => periodSel.add(new Option(t(`period.${p}`), p)));
    PERIODS.forEach((p) => lentaSel.add(new Option(t(`period.${p}`), p)));
  } else {
    Array.from(periodSel.options).forEach((o, i) => (o.textContent = t(`period.${PERIODS[i]}`)));
    Array.from(lentaSel.options).forEach((o, i) => (o.textContent = t(`period.${PERIODS[i]}`)));
  }
  periodSel.value = state.period;
  lentaSel.value = state.lentaPeriod;
  const tabs = [
    ["lentaTabGlobal", "global", "lenta.tab_global"],
    ["lentaTabMine", "mine", "lenta.tab_mine"],
    ["lentaTabAnswers", "answers", "lenta.tab_answers"],
  ];
  tabs.forEach(([id, tab, key]) => {
    const btn = $(id);
    btn.replaceChildren(el("span", null, t(key)));
    // счётчик висит на самом табе: «мне ответили» видно, даже когда раздел закрыт
    if (tab === "answers" && state.answersUnread) {
      btn.appendChild(el("span", "tab-count", state.answersUnread > 99 ? "99+" : String(state.answersUnread)));
    }
    btn.setAttribute("aria-pressed", String(state.lentaTab === tab));
  });
  $("lblHot").textContent = state.lentaTab === "global" ? "Hot" : t("lenta.new");
  $("lentaHint").textContent = t(
    state.lentaTab === "answers"
      ? "lenta.hint_answers"
      : state.lentaTab === "mine"
        ? "lenta.hint_mine"
        : "lenta.hint"
  );
  const langBtn = $("langBtn");
  langBtn.replaceChildren(el("b", null, state.lang));
  langBtn.title = t("header.lang");
  const lentaLangBtn = $("lentaLangBtn");
  lentaLangBtn.replaceChildren(
    el("b", null, state.lentaLang === "*" ? t("lang.all") : state.lentaLang)
  );
  lentaLangBtn.title = t("header.lang");
  const uiLang = (state.settings && state.settings.uiLang) || "ru";
  const flagBtn = $("uiLangBtn");
  flagBtn.innerHTML = flagSvg(uiLang);
  flagBtn.appendChild(el("b", null, uiLang.toUpperCase()));
  flagBtn.setAttribute("aria-pressed", String(!$("uiLangPop").hidden));
  /* Кнопки «Все/Важные/Мои/Топ» строим один раз и дальше только переключаем
     aria-pressed: пересборка replaceChildren() создавала новые элементы, и
     CSS-переход цвета не успевал начаться — кнопка «щёлкала» цветом. */
  const views = $("views");
  const built = [...views.querySelectorAll("button[data-view]")];
  const sameSet = built.length === VIEWS.length && VIEWS.every((v, i) => built[i].dataset.view === v);
  if (!sameSet) {
    views.replaceChildren();
    VIEWS.forEach((v) => {
      const b = el("button", null, t(`view.${v}`));
      b.type = "button";
      b.dataset.view = v;
      b.addEventListener("click", () => {
        state.view = v;
        refresh();
      });
      views.appendChild(b);
    });
  }
  [...views.children].forEach((b) => {
    b.setAttribute("aria-pressed", String(state.view === b.dataset.view));
  });
  const clients = $("clients");
  clients.replaceChildren(el("b", null, String(state.clients)), el("span", null, ` ${t("header.clients")}`));
  $("fxToggle").setAttribute("aria-pressed", String(!$("fx").hidden));
  $("lentaToggle").setAttribute("aria-pressed", String(!$("lenta").hidden));
  $("themeBtn").setAttribute("aria-pressed", String(!$("themePop").hidden));
  // the mirror button lights up while this room is merged with other addresses
  $("mirrorBtn").setAttribute(
    "aria-pressed",
    String(!$("mirrorPop").hidden || state.group.urls.length > 1)
  );
  // a room without a real page address (an extension page opened bare) has nothing to merge
  $("mirrorBtn").disabled = !/^https?:\/\//.test(state.url || "");
}

function fxLeft(fx) {
  const box = state.fx && state.fx[fx.id];
  return box ? box.left : fx.max;
}

function renderFx() {
  const grid = $("fxGrid");
  // карточки пересобираются после каждого нанесения — фокус вернём на тот же значок
  const wasFocused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fx : "";
  grid.replaceChildren();
  EFFECTS.forEach((fx) => {
    const card = el("div", `fx-card${fx.locked ? " locked" : ""}`);
    card.dataset.fx = fx.id;
    /* Медальон рисует CSS по data-fx (PNG из extension/icons): старый вектор и
       эмодзи внутри больше не нужны ни одному скину. */
    const box = el("span", "emo");
    card.append(box, el("span", "nm", t(fx.name)), el("span", "ds", t(fx.desc)));
    if (fx.locked) {
      card.title = t("fx.locked");
    } else {
      const left = fxLeft(fx);
      card.appendChild(el("span", "fx-left", `${left}/${fx.max}`));
      if (left <= 0) card.classList.add("spent");
      card.title = `${t("fx.hint")} · ${t("fx.per_day")}: ${fx.max}`;
      card.setAttribute("aria-pressed", String(state.armed === fx.id));
      bindFxCard(card, fx);
    }
    grid.appendChild(card);
  });
  if (wasFocused) {
    const again = grid.querySelector(`.fx-card[data-fx="${wasFocused}"]`);
    if (again) again.focus();
  }
}

function armFx(id) {
  state.armed = state.armed === id ? null : id;
  renderFx();
  renderFeed();
}

/* Перетаскивание живёт целиком внутри кадра чата: «призрак» приклеен position:fixed
   к этому кадру, а кадр во время перетаскивания никуда не уезжает, поэтому здесь
   достаточно clientX/clientY — экранная геометрия нужна только шапке, которая
   двигает всё окно. */
function startFxDrag(ev, card, fx) {
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  const root = document.documentElement;
  const x0 = ev.clientX;
  const y0 = ev.clientY;
  let moved = false;
  let hot = null;
  let ghost = null;

  const setHot = (row) => {
    if (hot === row) return;
    if (hot) hot.classList.remove("fx-target");
    hot = row;
    if (hot) hot.classList.add("fx-target");
  };
  const place = (x, y) => {
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    const node = document.elementFromPoint(x, y);
    setHot(node && node.closest ? node.closest(".msg") : null);
  };
  const begin = (x, y) => {
    moved = true;
    root.classList.add("fx-dragging", `fx-drag-${fx.id}`);
    ghost = el("div", `fx-ghost fx-ghost-${fx.id}`);
    ghost.dataset.fx = fx.id;
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    document.body.appendChild(ghost);
  };
  const finish = () => {
    setHot(null);
    if (ghost) ghost.remove();
    root.classList.remove("fx-dragging", `fx-drag-${fx.id}`);
  };
  /* здесь без requestAnimationFrame: призрак ничего не двигает, кроме себя,
     так что гонка «окно догоняет курсор» не возникает, а в фоновом кадре rAF
     вообще засыпает и перетаскивание вставало */
  const onMove = (e) => {
    if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
    if (!moved) begin(e.clientX, e.clientY);
    place(e.clientX, e.clientY);
  };
  const detach = () => {
    removeEventListener("pointermove", onMove);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointercancel", onCancel);
  };
  const onUp = () => {
    const row = hot;
    finish();
    detach();
    try {
      card.releasePointerCapture(ev.pointerId);
    } catch {
      /* уже отпущен */
    }
    // короткое нажатие без движения остаётся «взводом»: сработает обычный click
    if (moved && row) applyFx(fx.id, row.dataset.id);
  };
  const onCancel = () => {
    finish();
    detach();
  };
  /* слушатели на окне, а не на карточке: без this capture курсор, ушедший на ленту,
     перестал бы нас слушать. setPointerCapture добавлен сверху — он ещё и ловит
     отпускание за пределами кадра. */
  try {
    card.setPointerCapture(ev.pointerId);
  } catch {
    /* синтетическое событие в тесте: window-слушатели справятся сами */
  }
  addEventListener("pointermove", onMove);
  addEventListener("pointerup", onUp);
  addEventListener("pointercancel", onCancel);
}

function bindFxCard(card, fx) {
  card.tabIndex = 0;
  card.addEventListener("pointerdown", (ev) => {
    if (fxLeft(fx) <= 0) {
      flash(t("fx.err_quota"), true);
      return;
    }
    startFxDrag(ev, card, fx);
  });
  /* С клавиатуры карточку по-прежнему можно «взять»: мышью анимации работают
     только перетаскиванием, клик ничего не оставляет включённым. */
  card.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (fxLeft(fx) > 0) armFx(fx.id);
  });
}

const FX_ERRORS = {
  quota: "fx.err_quota",
  busy_flame: "fx.busy_flame",
  busy_shield: "fx.busy_shield",
  protected: "fx.protected",
  not_found: "msg.not_found",
};

async function applyFx(type, msgId) {
  const res = await send("effect", { msgId, type });
  if (!res) return;
  if (res.quota) state.fx = res.quota;
  state.armed = null;
  if (res.error) {
    flash(t(FX_ERRORS[res.error] || "fx.err_quota"), true);
    renderFx();
    if (res.error === "not_found") refresh();
    return;
  }
  state.hit = { msgId, type, quenched: !!res.quenched, at: Date.now() };
  setTimeout(() => {
    if (state.hit && state.hit.msgId === msgId) state.hit = null;
  }, 1600);
  flash(t(type === "shield" ? "fx.guarded" : "fx.flamed"));
  await refresh();
  renderFx();
}

function timeAgo(ts) {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 6e4) return t("time.now");
  if (diff < 36e5) return `${Math.floor(diff / 6e4)} ${t("time.min")}`;
  if (diff < 864e5) return `${Math.floor(diff / 36e5)} ${t("time.hour")}`;
  const day = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  /* старше года — добавляем год перед датой: в ленте за «всё время» иначе
     невозможно отличить прошлогодний тред от вчерашнего */
  return diff > 365 * 864e5 ? `${d.getFullYear()} ${day}` : day;
}

/* Стеклянный человечек: цвет выбирается хэшем id, поэтому человек выглядит
   одинаково во всех комнатах и не меняется между перерисовками ленты.
   Загруженная картинка (только у зарегистрированных) перекрывает человечка. */
function paintAvatar(node, author) {
  node.style.backgroundImage = avatarArt(author.id || "anon");
  node.style.backgroundSize = "100% 100%";
  node.style.backgroundRepeat = "no-repeat";
  const pic = String(author.avatar || "");
  if (pic.startsWith("data:image/")) {
    const img = el("img");
    img.src = pic;
    img.alt = "";
    node.appendChild(img);
  }
}

function renderComposer() {
  const idn = state.identity || { anon: true, name: "", avatar: "" };
  $("whoAva").replaceChildren();
  paintAvatar($("whoAva"), {
    id: myId,
    name: idn.anon ? "" : idn.name,
    avatar: idn.anon ? "" : idn.avatar,
  });
  $("whoName").textContent = idn.anon ? t("composer.anon") : idn.name || t("composer.anon");
  $("quota").textContent = `★ ${state.quota.left}/10`;
  $("quota").title = state.quota.left ? t("msg.star") : t("msg.star_none");
  const q = $("quoteLine");
  if (state.quote) {
    q.hidden = false;
    q.textContent = `↩ ${state.quote.text.slice(0, 90)}`;
    q.title = "✕";
  } else {
    q.hidden = true;
    q.textContent = "";
  }
}

/* ---------- messages: hide to a strip ---------- */

async function toggleCollapsed(msgId) {
  if (state.collapsed[msgId]) delete state.collapsed[msgId];
  else state.collapsed[msgId] = 1;
  await storeSet(COLLAPSED_KEY, state.collapsed);
  renderFeed();
}

function starButton(msg, starred) {
  const total = (msg.stars || []).length;
  /* Счётчик живёт внутри кнопки: нажали — круглая кнопка вытягивается в овал
     и показывает «★ N», звёздочка горит золотым. Убрали свою звезду, а других
     не осталось — кнопка снова круг с одной звёздочкой. */
  const star = el("button", `vbtn star${total ? " has" : ""}`, "★");
  if (total) star.appendChild(el("span", "star-num", String(total)));
  star.type = "button";
  star.title = total ? `${total} ${t("msg.stars")}` : t("msg.star");
  star.setAttribute("aria-pressed", String(starred));
  star.addEventListener("click", async () => {
    const res = await send("star", { msgId: msg.id });
    if (res && res.error === "quota") flash(t("msg.star_none"), true);
    if (res && res.quota) {
      state.quota = res.quota;
      renderComposer();
    }
    refresh();
  });
  return star;
}

/* two-step delete: first click arms the button, second removes the message
   for everyone (author only, the store enforces it and keeps a tombstone) */
function deleteButton(msg) {
  const btn = el("button", "vbtn del", "🗑");
  btn.type = "button";
  btn.title = t("msg.delete");
  let timer = null;
  const reset = () => {
    btn.setAttribute("aria-pressed", "false");
    btn.textContent = "🗑";
    btn.title = t("msg.delete");
  };
  btn.addEventListener("click", async () => {
    if (btn.getAttribute("aria-pressed") !== "true") {
      btn.setAttribute("aria-pressed", "true");
      btn.textContent = "✓";
      btn.title = t("msg.delete_confirm");
      timer = setTimeout(reset, 4000);
      return;
    }
    clearTimeout(timer);
    const res = await send("msg:delete", { msgId: msg.id });
    if (res && res.error === "not_mine") {
      flash(t("msg.cannot_delete"), true);
      return;
    }
    if (res && res.error) {
      flash(String(res.error), true);
      return;
    }
    flash(t("msg.deleted"));
    refresh();
  });
  return btn;
}

function reportButton(msg, reported) {
  const rep = el("button", "vbtn report", "⚑");
  rep.type = "button";
  rep.title = `${t("msg.report")}${msg.reports && msg.reports.length ? ` (${msg.reports.length})` : ""}`;
  rep.setAttribute("aria-pressed", String(reported));
  rep.addEventListener("click", async () => {
    await send("report", { msgId: msg.id });
    refresh();
  });
  return rep;
}

/* Голоса: обе кнопки ведут себя как «важное» — пока счётчик нулевой, это круг,
   появилось число — овал с цифрой. Большое поле суммы остаётся между ними. */
function voteRow(msg, mine) {
  const frag = document.createDocumentFragment();
  const upCount = (msg.up || []).length;
  const downCount = (msg.down || []).length;
  const up = el("button", `vbtn up${upCount ? " has" : ""}`, "👍");
  up.type = "button";
  up.title = "+1";
  up.setAttribute("aria-pressed", String(mine === "up"));
  if (upCount) up.appendChild(el("span", "vote-num", String(upCount)));
  up.addEventListener("click", () => send("vote", { msgId: msg.id, dir: "up" }));
  const down = el("button", `vbtn down${downCount ? " has" : ""}`, "👎");
  down.type = "button";
  down.title = "-1";
  down.setAttribute("aria-pressed", String(mine === "down"));
  if (downCount) down.appendChild(el("span", "vote-num", String(downCount)));
  down.addEventListener("click", () => send("vote", { msgId: msg.id, dir: "down" }));
  frag.append(up, down);
  return frag;
}

function replyButton(msg) {
  const reply = el("button", "vbtn reply", "↩");
  reply.type = "button";
  reply.title = t("msg.reply");
  reply.addEventListener("click", () => {
    // id родителя обязателен: без него ответ не найдётся в разделе «Ответы»
    state.quote = { text: msg.text, id: msg.id };
    renderComposer();
    $("text").focus();
  });
  return reply;
}

function avatarBox(msg) {
  const etype = fxType(msg.effect);
  const ava = el("div", `ava${etype === "shield" ? " fx-shield" : ""}`);
  paintAvatar(ava, msg.author);
  ava.title = msg.author.anon ? t("composer.anon") : msg.author.name || t("composer.anon");
  if (etype) {
    const meta = fxById(etype);
    const tag = el("i", `fx-tag fx-tag-${etype}`);
    tag.dataset.fx = etype;
    tag.title = `${msg.effect.by} · ${meta ? t(meta.name) : etype}`;
    ava.appendChild(tag);
  }
  return ava;
}

function textBubble(msg) {
  const bubble = el("div", "bubble");
  const head = el("div", "head");
  head.append(
    el("span", "nm", msg.author.anon ? t("composer.anon") : msg.author.name || t("composer.anon")),
    el("span", null, timeAgo(msg.ts)),
    el("span", null, `· ${msg.lang}`)
  );
  // mirrors share one room, so say which site a merged message came from
  if (hostOf(msg.url) && hostOf(msg.url) !== hostOf(state.url)) {
    head.appendChild(el("span", "src", `@ ${hostOf(msg.url)}`));
  }
  // ↩ на своём сообщении: ответ пришёл, и видно это не только в разделе «Ответы»
  const answers = state.answered.get(msg.id) || 0;
  if (answers) head.appendChild(el("span", "ans", `↩ ${answers}`));
  bubble.appendChild(head);
  /* Цитата идёт первой, ответ — под ней, как на форумах: читают сверху вниз, и последним
     должен стоять тот текст, ради которого человек зашёл в тред. */
  if (msg.quote) bubble.appendChild(el("p", "quote", `↩ ${msg.quote}`));
  bubble.appendChild(el("p", "txt", msg.text));
  if ((msg.links || []).length) {
    const chips = el("div", "chips");
    msg.links.forEach((l) => {
      const a = el("a", "chip", l.host);
      a.href = l.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      chips.appendChild(a);
    });
    bubble.appendChild(chips);
  }
  return bubble;
}

/* Комментарий, спрятанный решением комнаты: ⚑ жалобы или ▼ минус. Текст не удаляется, а
   сворачивается в заглушку со счётчиками — человек видит, за что его спрятали, и может
   раскрыть сам. Пороги считает store.js, здесь только вывод. */
function hiddenBubble(msg, reason) {
  const bubble = el("div", "bubble hidden-bubble");
  const note = el("p", "txt", reason === "votes" ? t("msg.hidden_votes") : t("msg.hidden"));
  bubble.appendChild(note);
  const marks = el("div", "hid-marks");
  const down = (msg.down || []).length;
  const reports = (msg.reports || []).length;
  if (down) marks.appendChild(el("span", "hid-num neg", `▼ ${down}`));
  if (reports) marks.appendChild(el("span", "hid-num warn", `⚑ ${reports}`));
  const reveal = el("button", "vbtn reveal", t("msg.reveal"));
  reveal.type = "button";
  reveal.title = t("msg.reveal");
  reveal.addEventListener("click", () => toggleRevealed(msg.id));
  marks.appendChild(reveal);
  bubble.appendChild(marks);
  return bubble;
}

function toggleRevealed(msgId) {
  if (state.revealed[msgId]) delete state.revealed[msgId];
  else state.revealed[msgId] = 1;
  renderFeed();
}

function messageNode(msg) {
  const collapsed = !!state.collapsed[msg.id];
  const mine = among(msg.up) ? "up" : among(msg.down) ? "down" : null;
  const starred = among(msg.stars);
  const reported = among(msg.reports);
  const reason = msg.hidden || null;
  // ползунок «показывать скрытые» снимает заглушку со всех сразу, 👁 — с одного
  const hidden = !!reason && !state.revealed[msg.id] && !(state.settings && state.settings.showHidden);

  const row = el("article", `msg${hidden ? " hidden-msg" : ""}${collapsed ? " collapsed" : ""}`);
  row.dataset.id = msg.id;

  const ava = avatarBox(msg);
  if (state.armed && !collapsed) {
    ava.style.cursor = "crosshair";
    ava.addEventListener("click", () => applyFx(state.armed, msg.id));
  }
  row.appendChild(ava);

  const star = starButton(msg, starred);
  const reply = replyButton(msg);

  if (collapsed) {
    const strip = el("div", "strip");
    strip.dataset.label = `${t("msg.hidden_by_user")} · ${msg.author.anon ? t("composer.anon") : msg.author.name || t("composer.anon")} · ${timeAgo(msg.ts)}`;
    strip.title = t("msg.expand");
    strip.addEventListener("click", () => toggleCollapsed(msg.id));
    row.appendChild(strip);
  } else if (hidden) {
    row.appendChild(hiddenBubble(msg, reason));
  } else {
    /* «Важное» живёт в правом верхнем углу самого сообщения, «ответить» — в правом
       нижнем: панель справа больше не обрастает иконками и держит только голоса. */
    const bubble = textBubble(msg);
    const head = bubble.querySelector(".head");
    if (head) head.appendChild(star);
    const foot = el("div", "bubble-foot");
    foot.appendChild(reply);
    bubble.appendChild(foot);
    row.appendChild(bubble);
  }

  /* Панель голосов: 👍 и ⚑ в одной строке, под ними сумма, ниже 👎 и ⊟.
     Раскладку задают grid-области в chat.css, порядок вставки — только для чтения с экрана. */
  const votes = el("div", "votes");
  votes.append(voteRow(msg, mine));
  votes.append(reportButton(msg, reported));
  if (msg.author && isMine(msg.author.id)) votes.appendChild(deleteButton(msg));
  const toggle = el("button", "vbtn hide", collapsed ? "⊡" : "⊟");
  toggle.type = "button";
  toggle.title = collapsed ? t("msg.expand") : t("msg.hide");
  toggle.addEventListener("click", () => toggleCollapsed(msg.id));
  votes.appendChild(toggle);
  row.appendChild(votes);

  /* Состояние эффекта рисуется классом, а не разовым анимационным триггером:
     лента пересобирается при каждой синхронизации, и огонь должен продолжать
     гореть после перерисовки, а не вспыхивать заново на пару секунд. */
  const etype = fxType(msg.effect);
  if (etype) row.classList.add(etype === "flame" ? "fx-flame" : "fx-shield");
  if (state.hit && state.hit.msgId === msg.id && Date.now() - state.hit.at < 1500) {
    row.classList.add("fx-hit", state.hit.type === "flame" ? "fx-hit-flame" : "fx-hit-shield");
    if (state.hit.quenched) row.classList.add("fx-quench");
  }
  return row;
}

function flash(text, isError) {
  const notice = $("notice");
  notice.hidden = !text;
  notice.textContent = text || "";
  if (text) {
    notice.classList.toggle("err", !!isError);
    setTimeout(() => {
      notice.hidden = true;
      notice.textContent = "";
    }, 4200);
  }
}

/* ---------- theme ---------- */

/* Ползунки градиента и фона отдают значение на каждый пиксель мыши, а запись в
   chrome.storage — это сериализация всей темы (вместе с data-URL картинки). Пишем
   позже: заявка на сохранение откладывается, пока человек крутит, и успевает выйти
   одна итоговая запись. */
let themeSaveTimer = 0;
async function saveTheme() {
  clearTimeout(themeSaveTimer);
  const snapshot = structuredClone(state.theme);
  await new Promise((res) => {
    themeSaveTimer = setTimeout(res, 350);
  });
  await storeSet(THEME_KEY, snapshot);
}

function useTheme(next) {
  /* тема приходит кусками (скин меняет градиент, фон — свою половину), а blur живёт
     на верхнем уровне: без подмешивания старого значения галка «Стекло» сбрасывалась
     бы при каждом выборе скина */
  state.theme = normalizeTheme({ ...(state.theme || {}), ...next });
  applyTheme(document.documentElement, state.theme);
  paintScene();
  paintThemeControls();
  saveTheme();
}

function paintThemeControls() {
  const g = state.theme.gradient;
  $("gradA").style.background = g.from;
  $("gradB").style.background = g.to;
  $("gradAngle").value = String(g.angle);
  $("gradAlpha").value = String(Math.round((g.alpha ?? 0.2) * 100));
  $("bgFit").value = state.theme.background.fit;
  $("bgAlpha").value = String(Math.round(state.theme.background.alpha * 100));
  $("glassBlur").checked = state.theme.blur !== false;
  $("glassBlur").closest(".row").hidden = !skinById(state.theme.skin).glass;
  // ползунки живого фона и плотности панелей — только у стеклянного скина
  const glassy = skinById(state.theme.skin).glass;
  ["panelAlpha", "liveBubbles", "liveSun", "livePlants", "sphereSpeed"].forEach((id) => {
    $(id).closest(".row").hidden = !glassy;
  });
  $("lblLive").hidden = !glassy;
  $("panelAlpha").value = String(state.theme.panelAlpha ?? 10);
  $("liveBubbles").value = String(state.theme.live?.bubbles ?? 60);
  $("liveSun").value = String(state.theme.live?.sun ?? 60);
  $("livePlants").value = String(state.theme.live?.plants ?? 60);
  $("sphereSpeed").value = String(state.theme.sphereSpeed ?? 60);
  renderSkins();
}

function skinCard(skin) {
  const card = el("div", "skin-card");
  card.setAttribute("aria-pressed", String(state.theme.skin === skin.id));
  card.title = skin.name;
  const sw = el("span", "sw");
  sw.style.background = `linear-gradient(135deg, ${skin.preview[0]}, ${skin.preview[1]})`;
  card.append(sw, el("span", "sn", skin.name));
  card.addEventListener("click", () => {
    useTheme({
      skin: skin.id,
      gradient: { ...skin.gradient, custom: false },
      background: state.theme.background,
    });
  });
  return card;
}

function renderSkins() {
  const grid = $("skinGrid");
  if (!grid) return;
  grid.replaceChildren();
  SKINS.forEach((skin) => grid.appendChild(skinCard(skin)));
  const special = $("specialGrid");
  special.replaceChildren();
  SPECIAL_SKINS.forEach((skin) => special.appendChild(skinCard(skin)));
}

/* colour wheel (hue = angle, saturation = radius, lightness = slider) */

const picker = { target: "from", h: 140, s: 0.8, l: 0.55 };

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))));
  };
  return [f(0), f(8), f(4)];
}

function hslToHex(h, s, l) {
  const [r, g, b] = hslToRgb(h, s, l);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function hexToHsl(hex) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  const num = parseInt(full, 16);
  if (!Number.isFinite(num)) return null;
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return { h: hue / 360, s: d / (1 - Math.abs(2 * l - 1)), l };
}

function drawWheel() {
  const canvas = $("wheel");
  const ctx = canvas.getContext("2d");
  const size = canvas.width;
  const radius = size / 2;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - radius + 0.5;
      const dy = y - radius + 0.5;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) {
        img.data[i + 3] = 0;
        continue;
      }
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const [r, g, b] = hslToRgb(hue / 360, Math.min(1, dist / radius), picker.l);
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const angle = picker.h * Math.PI;
  const px = radius + Math.cos(angle) * picker.s * radius;
  const py = radius + Math.sin(angle) * picker.s * radius;
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.strokeStyle = "rgba(0,0,0,.55)";
  ctx.beginPath();
  ctx.arc(px, py, 7, 0, Math.PI * 2);
  ctx.stroke();
}

function openPicker(target) {
  picker.target = target;
  const current = hexToHsl(state.theme.gradient[target === "b" ? "to" : "from"]) || { h: 0.4, s: 0.8, l: 0.55 };
  picker.h = current.h;
  picker.s = current.s;
  picker.l = current.l;
  $("lightness").value = String(Math.round(picker.l * 100));
  $("picker").hidden = false;
  drawWheel();
  applyPickedColor();
}

function applyPickedColor() {
  const hex = hslToHex(picker.h, picker.s, picker.l);
  $("hex").value = hex;
  const g = { ...state.theme.gradient, custom: true };
  if (picker.target === "b") g.to = hex;
  else g.from = hex;
  state.theme.gradient = g;
  applyTheme(document.documentElement, state.theme);
  paintScene();
  paintSwatches();
  saveTheme();
}

function paintSwatches() {
  $("gradA").style.background = state.theme.gradient.from;
  $("gradB").style.background = state.theme.gradient.to;
}

function pickFromEvent(ev) {
  const canvas = $("wheel");
  const rect = canvas.getBoundingClientRect();
  const x = ((ev.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((ev.clientY - rect.top) / rect.height) * canvas.height;
  const radius = canvas.width / 2;
  const dx = x - radius;
  const dy = y - radius;
  picker.h = (((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360) / 360;
  picker.s = Math.min(1, Math.hypot(dx, dy) / radius);
  drawWheel();
  applyPickedColor();
}

async function readBackground(file) {
  if (!file) return;
  let dataUrl;
  try {
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  } catch {
    flash(t("theme.bg_error"), true);
    return;
  }
  let out = dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("decode"));
      image.src = dataUrl;
    });
    const scale = Math.min(1, BG_MAX_PX / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    out = canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    /* keep the raw data url if decoding fails */
  }
  useTheme({
    skin: state.theme.skin,
    gradient: state.theme.gradient,
    background: { ...state.theme.background, data: out },
  });
  flash(t("theme.bg_loaded"), false);
}

/* ---------- sound ---------- */

const soundPrefs = () => ({ ...DEFAULT_SOUND, ...((state.settings || {}).sound || {}) });

async function patchSound(patch) {
  const res = await send("settings:set", { patch: { sound: { ...soundPrefs(), ...patch } } });
  if (res && res.settings) state.settings = res.settings;
  renderSound();
}

function renderSound() {
  if (!$("soundOn")) return;
  const p = soundPrefs();
  const pct = Math.round(p.volume * 100);
  $("soundOn").checked = p.on !== false;
  $("volume").value = String(pct);
  $("lblVolume").textContent = `${t("sound.volume")} · ${pct}%`;
  $("soundTest").textContent = t("sound.test");
  $("soundNote").textContent = t(state.customSound ? "sound.custom_on" : "sound.custom_hint");
  $("soundClear").hidden = !state.customSound;
  const row = $("toneRow");
  row.replaceChildren();
  /* Кнопка сигнала — он же выбор, он же предпрослушивание: нажал и сразу слышно,
     каким станет оповещение. Если выбран свой mp3, подсветка уходит с готовых сигналов. */
  SOUND_TONES.forEach((name) => {
    const btn = el("button", "mini tone", t(`sound.${name}`));
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(!state.customSound && p.tone === name));
    btn.addEventListener("click", () => {
      patchSound({ tone: name });
      playSound(name, { volume: p.volume });
    });
    row.appendChild(btn);
  });
}

function ringNewMessages() {
  const p = soundPrefs();
  const foreign = state.messages
    .filter((m) => !m.author || !isMine(m.author.id))
    .filter((m) => !state.seen.has(m.id));
  state.messages.forEach((m) => state.seen.add(m.id));
  /* Звучит только написанное после входа в комнату: сообщения, которые уже лежали в
     ленте, и старые комменты, подтянутые из длинного периода, должны молчать. */
  const newest = state.messages.reduce((acc, m) => Math.max(acc, m.ts || 0), state.soundFloor);
  const fresh = p.on === false ? [] : foreign.filter((m) => (m.ts || 0) > state.soundFloor);
  state.soundFloor = newest;
  // первая загрузка только запоминает
  if (!state.soundReady) {
    state.soundReady = true;
    return;
  }
  if (!fresh.length) return;
  playSound(p.tone, { volume: p.volume, custom: state.customSound });
  /* Ответ на моё сообщение замечать важнее, чем просто новую строку в ленте:
     полоса снизу говорит об этом прямо, а счётчик на табе «Ответы» виден всегда. */
  const mineSet = new Set(state.messages.filter((m) => isMine(m.author && m.author.id)).map((m) => m.id));
  const aboutMe = fresh.filter((m) => m.replyTo && mineSet.has(m.replyTo));
  if (aboutMe.length) flash(t(aboutMe.length > 1 ? "notice.answers" : "notice.answer"));
}

async function readSound(file) {
  if (!file) return;
  if (file.size > SOUND_MAX_BYTES) {
    flash(t("sound.too_big"), true);
    $("soundFile").value = "";
    return;
  }
  let dataUrl;
  try {
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  } catch {
    flash(t("sound.bad"), true);
    return;
  }
  const res = await send("sound:set", { dataUrl });
  $("soundFile").value = "";
  if (!res || !res.ok) {
    flash(t(res && res.error === "too_big" ? "sound.too_big" : "sound.bad"), true);
    return;
  }
  state.customSound = dataUrl;
  renderSound();
  playSound(soundPrefs().tone, { volume: soundPrefs().volume, custom: dataUrl });
  flash(t("sound.loaded"), false);
}

function paintIdentityLock() {
  const registered = !!(state.identity && state.identity.userId);
  $("avatarFile").disabled = !registered;
  $("avatarLock").hidden = registered;
}

/* Nicks and window geometry are remembered per host, so the profile always says
   which site it is editing. */
const siteHost = () => hostOf(state.url);

function paintProfileSite() {
  const site = $("profileSite");
  site.replaceChildren(el("span", null, `${t("profile.site")} `), el("b", null, siteHost()));
  $("siteReset").hidden = !(state.identity && state.identity.sites && state.identity.sites[siteHost()]);
}

function paintNameCount() {
  const len = ($("nameInput").value || "").length;
  $("nameCount").textContent = `${len}/${NAME_MAX}`;
}

/* ---------- mirrors: several addresses, one room ---------- */

function renderMirror() {
  const list = $("mirrorList");
  const home = state.group.home || normalizeUrl(state.url);
  const urls = state.group.urls.length ? state.group.urls : [normalizeUrl(state.url)];
  const site = $("mirrorHome");
  site.replaceChildren(el("span", null, `${t("mirror.home")}: `), el("b", null, home));
  list.replaceChildren();
  urls.forEach((u) => {
    const li = el("li", u === home ? "home" : "");
    const isThis = hostOf(u) === hostOf(state.url);
    li.append(
      el("span", "addr", u),
      el("span", "tag", isThis ? t("mirror.this") : u === home ? t("mirror.home") : "")
    );
    if (u !== home) {
      const btn = el("button", "vbtn", "✂");
      btn.type = "button";
      btn.title = `${t("mirror.remove")} · ${hostOf(u)}`;
      btn.addEventListener("click", async () => {
        const res = await send("mirror:remove", { url: u });
        if (res && res.ok) {
          setGroup(res.group);
          flash(t("mirror.left"), false);
          refresh();
        }
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  });
  renderHeader();
}

function setGroup(group) {
  state.group = group && group.home ? { home: group.home, urls: group.urls || [group.home] } : state.group;
}

async function addMirror() {
  const raw = $("mirrorInput").value.trim();
  if (!raw) return;
  const res = await send("mirror:add", { base: state.url, url: raw });
  if (!res || !res.ok) {
    const err = $("mirrorErr");
    err.textContent = t("mirror.bad_url");
    err.hidden = false;
    return;
  }
  $("mirrorErr").hidden = true;
  $("mirrorInput").value = "";
  setGroup(res.group);
  flash(`${t("mirror.joined")} ${hostOf(raw)}`, false);
  refresh();
}

async function readAvatar(file) {
  if (!file || !state.identity || !state.identity.userId) return;
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  }).catch(() => null);
  if (!dataUrl) {
    flash(t("theme.bg_error"), true);
    return;
  }
  let out = dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("decode"));
      image.src = dataUrl;
    });
    const side = 128;
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    const k = Math.max(side / img.width, side / img.height);
    ctx.drawImage(img, (side - img.width * k) / 2, (side - img.height * k) / 2, img.width * k, img.height * k);
    out = canvas.toDataURL("image/png");
  } catch {
    /* keep the raw data url */
  }
  await send("identity:set", { patch: { avatar: out } });
  await loadIdentity();
  renderComposer();
  renderFeed();
}

/* ---------- host bridge: the chat header drags the whole panel ---------- */

/* the side drawers must never stretch or shift the chat column: instead of
   taking the chat's space they widen and narrow the overlay window itself */
const panelW = { fx: 0, lenta: 0 };

function measurePanels() {
  if (!$("fx").hidden) panelW.fx = $("fx").getBoundingClientRect().width;
  if (!$("lenta").hidden) panelW.lenta = $("lenta").getBoundingClientRect().width;
}

function syncPanels(mode) {
  if (!EMBEDDED) return;
  applyDrawerMode();
  const floats = screenWidth() <= 900;
  const fx = floats || $("fx").hidden ? 0 : panelW.fx;
  const lenta = floats || $("lenta").hidden ? 0 : panelW.lenta;
  toHost("panels", { fx, lenta, init: mode === "init", rebind: mode === "rebind" });
}

function bindHostControls() {
  $("opacity").closest(".row").hidden = !EMBEDDED;
  $("opacity").addEventListener("input", (e) => {
    toHost("opacity", { value: Number(e.target.value) / 100 });
  });
  if (!EMBEDDED) return;
  const top = document.querySelector(".top");
  let dragging = false;
  let queued = null;
  let raf = 0;
  const flush = () => {
    raf = 0;
    if (!dragging || !queued) return;
    toHost("drag", { phase: "move", sx: queued.sx, sy: queued.sy });
    queued = null;
  };
  top.addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button, select, input, a, .search")) return;
    dragging = true;
    top.classList.add("dragging");
    top.setPointerCapture(ev.pointerId);
    // screenX/screenY belong to the OS screen, not to this iframe: unlike clientX they
    // don't shift when the panel moves, so the panel can't chase its own cursor
    toHost("drag", { phase: "start", sx: ev.screenX, sy: ev.screenY });
  });
  top.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    queued = { sx: ev.screenX, sy: ev.screenY };
    if (!raf) raf = requestAnimationFrame(flush);
  });
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    queued = null;
    top.classList.remove("dragging");
    toHost("drag", { phase: "end" });
  };
  top.addEventListener("pointerup", stop);
  top.addEventListener("pointercancel", stop);
  let rebindTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(rebindTimer);
    rebindTimer = setTimeout(() => {
      measurePanels();
      syncPanels("rebind");
    }, 200);
  });
}

/* ---------- data ---------- */

/* Отпечаток ленты: только те поля, из которых собирается строка. Long-pолл приносит
   «sync» каждые сорок секунд даже тогда, когда никто ничего не писал, а пересборка ста
   пузырей с десятками слушателей на i5 8400 — это заметный рывок процессора. Совпал
   отпечаток — DOM не трогаем. */
function feedSig(list) {
  let out = "";
  for (const m of list) {
    out += `${m.id}~${(m.up || []).length},${(m.down || []).length},${(m.stars || []).length},${(m.reports || []).length}|${m.hidden || ""}|${fxType(m.effect) || ""}|${m.replyTo || ""}|${(m.quote || "").length}|${m.text.length}|${(m.links || []).length}|${m.ts};`;
  }
  return out;
}

async function refresh() {
  const filter = state.settings ? state.settings.filter : true;
  const lentaCall =
    state.lentaTab === "mine"
      ? send("mine:get", { lang: state.lentaLang, period: state.lentaPeriod, filter })
      : send("lenta:get", { url: "*", lang: state.lentaLang, period: state.lentaPeriod, filter });
  const [feedRes, lentaRes, presenceRes, quotaRes, answersRes] = await Promise.all([
    send("feed:get", { url: state.url, lang: state.lang, view: state.view, period: state.period, sort: state.view === "top" ? "score" : "new", filter }),
    lentaCall,
    send("presence", { url: state.url, lang: state.lang }),
    send("quota:get"),
    // ответов всегда три: счётчик на табе обязан жить, даже когда открыт другой раздел
    send("answers:get", { lang: state.lentaLang, period: state.lentaPeriod, filter }),
  ]);
  const next = (feedRes && feedRes.messages) || [];
  const sameFeed = feedSig(state.messages) === feedSig(next);
  state.messages = next;
  state.rows = (lentaRes && lentaRes.rows) || [];
  state.answers = (answersRes && answersRes.rows) || [];
  state.answersUnread = (answersRes && answersRes.unread) || 0;
  state.clients = (presenceRes && presenceRes.clients) || 0;
  setGroup(presenceRes && presenceRes.group);
  if (quotaRes && quotaRes.quota) state.quota = quotaRes.quota;
  /* Заряды на карточках рисует renderFx(), а он раньше вызывался только до ответа
     quota:get — после перезагрузки страницы счётчики висели на «полном» запасе,
     хотя заряд уже потрачен. Перерисовываем, только если квота правда изменилась,
     чтобы не сбрасывать наведение и фокус каждые 40 секунд. */
  const fxBefore = JSON.stringify(state.fx || null);
  if (quotaRes && quotaRes.fx) state.fx = quotaRes.fx;
  if (JSON.stringify(state.fx || null) !== fxBefore) renderFx();
  // пустая комната: отпечаток совпадает и на старте, а заглушку «пока пусто» всё равно нужно поставить
  if (!sameFeed || !$("feed").childElementCount) renderFeed();
  renderLenta();
  renderMirror();
  renderHeader();
  renderComposer();
  ringNewMessages();
}

// свой пост всегда должен быть виден, даже если читатель ушёл вверх по ленте
let jumpBottom = false;

/* Пламя и угли движутся только на тех строках, которые человек видит. Кадры внутри
   SVG и на псевдоэлементах Chromium не отдаёт композитору: каждый анимированный пузырь —
   это перерисовка документа 60 раз в секунду, а комната легко держит десяток горящих.
   Состояние (рамка, свечение, градиент) при этом статичное и остаётся на месте — вне
   экрана замирает только движение. */
const liveIO =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const e of entries) e.target.classList.toggle("live", e.isIntersecting);
        },
        { root: $("feed"), rootMargin: "140px 0px" }
      )
    : null;

function renderFeed() {
  const feed = $("feed");
  /* измерять надо ДО очистки: пустая лента имеет высоту окна, и проверка «прилип ли
     к низу» после replaceChildren всегда выходит истинной — любой перерисовок
     (голос, фильтр правой панели) утаскивал читателя в конец */
  const stickBottom =
    state.view !== "top" && feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 60;
  const offset = feed.scrollTop;
  feed.replaceChildren();
  if (liveIO) liveIO.disconnect();
  const q = state.q.trim().toLowerCase();
  let list = state.messages;
  if (q) list = list.filter((m) => `${m.text} ${m.author.name || ""}`.toLowerCase().includes(q));
  // «вам ответили N» рисуем на исходном сообщении, поэтому счёт нужен до рендера
  const answered = new Map();
  state.messages.forEach((m) => {
    if (m.replyTo && !isMine(m.author && m.author.id)) {
      answered.set(m.replyTo, (answered.get(m.replyTo) || 0) + 1);
    }
  });
  state.answered = answered;
  if (!list.length) {
    feed.appendChild(el("p", "empty", state.view === "important" ? t("msg.no_important") : t("msg.empty")));
    jumpBottom = false;
    return;
  }
  for (const msg of list) {
    const row = messageNode(msg);
    feed.appendChild(row);
    if (liveIO && fxType(msg.effect)) liveIO.observe(row);
  }
  if (stickBottom || jumpBottom) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = offset;
  jumpBottom = false;
}

function renderLenta() {
  const list = $("lentaList");
  list.replaceChildren();
  const answers = state.lentaTab === "answers";
  const rows = answers ? state.answers : state.rows;
  if (!rows.length) {
    const emptyKey = answers ? "lenta.empty_answers" : state.lentaTab === "mine" ? "lenta.empty_mine" : "lenta.empty";
    list.appendChild(el("li", "empty", t(emptyKey)));
    return;
  }
  rows.forEach((row) => list.appendChild(answers ? answerRowNode(row) : panelRowNode(row)));
}

/* Один и тот же шаблон строки на оба таба панели: шапка «@ домен · язык», сам комментарий
   кнопкой (клик ведёт на сайт с оверлеем), ниже — чипы ссылок, если они в комментарии
   были, и полоса с голосами, звёздами и кнопкой «войти». */
function panelRowNode(row) {
  const li = el("li");
  const head = el("div", "sub chan");
  head.append(
    el("span", null, `@ ${hostOf(row.url)} · ${row.lang}`),
    el("span", "when", timeAgo(row.ts))
  );
  const body = el("button", "post-link", row.text.slice(0, 140));
  body.type = "button";
  body.title = t("lenta.goto");
  body.addEventListener("click", () => gotoPost(row.url, row.lang, row.id));
  li.append(head, body);
  const links = (row.links || []).map((link, i) => {
    const a = el("a", "hyper", `Hyperlink ${i + 1}`);
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    a.title = link.host || hostOf(link.href);
    return a;
  });
  if (links.length) {
    const box = el("div", "links");
    box.append(...links);
    li.append(box);
  }
  const meta = el("div", "sub");
  const marks = [`▲ ${row.votes}`];
  if (row.stars) marks.push(`★ ${row.stars}`);
  meta.append(el("span", null, marks.join(" · ")), joinButton(row.url, row.lang, row.id));
  li.append(meta);
  return li;
}

/* Строка раздела «Ответы»: сверху адрес и время, ниже — начало моей реплики и начало
   ответа на неё. Клик ведёт именно к ответу: в этой комнате прокрутка, на другом адресе
   сайт с оверлеем и goto. */
function answerRowNode(row) {
  const li = el("li", row.unread ? "unread" : null);
  const head = el("div", "sub chan");
  head.append(
    el("span", null, `@ ${hostOf(row.url)} · ${row.lang}`),
    el("span", "when", timeAgo(row.ts))
  );
  const src = el("div", "answer-src", `↩ ${row.parent.text.slice(0, 90)}`);
  src.title = t("lenta.answer_src");
  const body = el("button", "post-link", row.text.slice(0, 140));
  body.type = "button";
  body.title = t("lenta.goto_answer");
  body.addEventListener("click", () => {
    state.answersUnread = Math.max(0, state.answersUnread - 1);
    row.unread = false;
    // подсветка строки снимается сразу: панель перезагрузится не раньше, чем человек в
    // неё вернётся, а счётчик в шапке уже молчит — строка обязана совпадать с ним
    li.classList.remove("unread");
    send("answers:read", { id: row.id }).catch(() => {});
    renderHeader();
    gotoPost(row.url, row.lang, row.id);
  });
  const meta = el("div", "sub");
  const who = row.name || t("composer.anon");
  meta.append(el("span", null, `${who} · ▲ ${row.votes}`), joinButton(row.url, row.lang, row.id));
  li.append(head, src, body, meta);
  return li;
}

/* Строка из «Моих сообщений» и «войти» ведут на сам сайт, а не на служебную страницу
   чата: background открывает вкладку с адресом и навешивает оверлей, когда страница
   догрузится. Прежняя вкладка chat.html остаётся запасным путём — её выбирает сам
   background, если сайт не принимает оверлей. */
function gotoPost(url, lang, msgId) {
  if (normalizeUrl(url) === normalizeUrl(state.url) && lang === state.lang) {
    jumpToMessage(msgId);
    return;
  }
  send("site:open", { url, lang, msg: msgId }).catch(() => {});
}

// the visible period may not reach that far back: widen it, then scroll and flash the row
async function jumpToMessage(msgId) {
  state.q = "";
  $("q").value = "";
  state.view = "all";
  state.period = "all";
  await refresh();
  const node = document.querySelector(`#feed [data-id="${CSS.escape(msgId)}"]`);
  if (!node) {
    flash(t("msg.not_found"), true);
    return;
  }
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.add("jump");
  setTimeout(() => node.classList.remove("jump"), 2600);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url || "").slice(0, 30);
  }
}

function joinButton(url, lang, msgId) {
  const btn = el("button", "join", t("lenta.join"));
  btn.type = "button";
  btn.title = `${hostOf(url)} · ${lang}`;
  btn.addEventListener("click", () => {
    send("site:open", { url, lang, msg: msgId || "" }).catch(() => {});
  });
  return btn;
}

function openLangPop(anchor, current, onPick, allowAll) {
  const pop = $("langPop");
  const search = $("langSearch");
  const list = $("langList");
  search.value = "";
  search.placeholder = t("lang.search");
  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 276))}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  pop.hidden = false;

  const paint = () => {
    const query = search.value;
    const found = searchLangs(query);
    const ordered = query
      ? found
      : [...found.filter((l) => PRIMARY_CODES.includes(l.code)), ...found.filter((l) => !PRIMARY_CODES.includes(l.code))];
    list.replaceChildren();
    if (allowAll && !query) {
      const li = el("li", "pinned");
      const b = el("button", null, t("lang.all"));
      b.type = "button";
      b.addEventListener("click", () => {
        onPick("*");
        pop.hidden = true;
      });
      li.appendChild(b);
      list.appendChild(li);
    }
    ordered.slice(0, 60).forEach((l) => {
      const li = el("li", PRIMARY_CODES.includes(l.code) && !query ? "pinned" : "");
      const b = el("button");
      b.type = "button";
      b.append(el("span", null, l.native), el("span", "code", l.code));
      b.addEventListener("click", () => {
        onPick(l.code);
        pop.hidden = true;
      });
      li.appendChild(b);
      list.appendChild(li);
    });
    if (!ordered.length) list.appendChild(el("li", "empty", "—"));
  };
  search.oninput = paint;
  paint();
  setTimeout(() => search.focus(), 30);
}

/* interface-language picker: flag button → list of flags + native names */
function renderUiLangList() {
  const list = $("uiLangList");
  const current = (state.settings && state.settings.uiLang) || "ru";
  list.replaceChildren();
  LANG_META.forEach((l) => {
    const li = el("li");
    const b = el("button", l.code === current ? "current" : "");
    b.type = "button";
    b.innerHTML = l.svg;
    b.appendChild(el("span", "nm", l.name));
    if (l.code === current) b.appendChild(el("span", "tick", "✓"));
    b.addEventListener("click", async () => {
      $("uiLangPop").hidden = true;
      const live = (state.settings && state.settings.uiLang) || "ru";
      if (l.code === live) return;
      await send("settings:set", { patch: { uiLang: l.code } });
      await loadSettings();
      $("uiLangSel").value = l.code;
      applyLocale();
      refresh();
    });
    li.appendChild(b);
    list.appendChild(li);
  });
}

function toggleUiLangPop() {
  const pop = $("uiLangPop");
  const willOpen = pop.hidden;
  closePopovers(willOpen ? "uiLangPop" : null);
  if (!willOpen) {
    pop.hidden = true;
    renderHeader();
    return;
  }
  const rect = $("uiLangBtn").getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 236))}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  renderUiLangList();
  pop.hidden = false;
  renderHeader();
}

async function loadIdentity() {
  const res = await send("identity:get", { url: state.url });
  state.identity = res && res.identity;
  myId = state.identity ? state.identity.pub : "";
  myIds = state.identity ? [state.identity.pub, state.identity.deviceId] : [];
}

async function loadSettings() {
  const res = await send("settings:get");
  state.settings = (res && res.settings) || {};
}

/* ---------- bindings ---------- */

function closePopovers(except) {
  ["langPop", "uiLangPop", "profilePop", "themePop", "mirrorPop"].forEach((id) => {
    if (id !== except) $(id).hidden = true;
  });
  renderHeader();
}

function bindEvents() {
  $("period").addEventListener("change", (e) => {
    state.period = e.target.value;
    refresh();
  });
  $("lentaPeriod").addEventListener("change", (e) => {
    state.lentaPeriod = e.target.value;
    refresh();
  });
  $("lentaTabGlobal").addEventListener("click", () => {
    if (state.lentaTab === "global") return;
    state.lentaTab = "global";
    refresh();
  });
  $("lentaTabMine").addEventListener("click", () => {
    if (state.lentaTab === "mine") return;
    state.lentaTab = "mine";
    refresh();
  });
  $("lentaTabAnswers").addEventListener("click", () => {
    if (state.lentaTab === "answers") return;
    state.lentaTab = "answers";
    refresh();
  });
  $("langBtn").addEventListener("click", () =>
    openLangPop($("langBtn"), state.lang, (code) => {
      state.lang = code;
      refresh();
    }, false)
  );
  $("lentaLangBtn").addEventListener("click", () =>
    openLangPop($("lentaLangBtn"), state.lentaLang, (code) => {
      state.lentaLang = code;
      refresh();
    }, true)
  );
  $("uiLangBtn").addEventListener("click", toggleUiLangPop);
  $("q").addEventListener("input", (e) => {
    state.q = e.target.value;
    renderFeed();
  });
  $("qClear").addEventListener("click", () => {
    state.q = "";
    $("q").value = "";
    renderFeed();
  });
  $("fxToggle").addEventListener("click", () => {
    $("fx").hidden = !$("fx").hidden;
    renderHeader();
    measurePanels();
    syncPanels();
  });
  $("lentaToggle").addEventListener("click", () => {
    $("lenta").hidden = !$("lenta").hidden;
    renderHeader();
    measurePanels();
    syncPanels();
  });
  $("closeBtn").addEventListener("click", close);
  $("profileBtn").addEventListener("click", () => {
    const willOpen = $("profilePop").hidden;
    closePopovers(willOpen ? "profilePop" : null);
    $("profilePop").hidden = !willOpen;
  });
  $("themeBtn").addEventListener("click", () => {
    const willOpen = $("themePop").hidden;
    closePopovers(willOpen ? "themePop" : null);
    $("themePop").hidden = !willOpen;
  });
  $("mirrorBtn").addEventListener("click", () => {
    const willOpen = $("mirrorPop").hidden;
    closePopovers(willOpen ? "mirrorPop" : null);
    if (willOpen) {
      send("mirror:list", { url: state.url }).then((r) => {
        if (r && r.ok) {
          setGroup(r.group);
          renderMirror();
        }
      });
    }
    $("mirrorPop").hidden = !willOpen;
    renderHeader();
  });
  $("mirrorAdd").addEventListener("click", addMirror);
  $("mirrorInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      addMirror();
    }
  });
  $("siteReset").addEventListener("click", async () => {
    const res = await send("identity:reset_site", { url: state.url });
    if (res && res.identity) state.identity = res.identity;
    $("nameInput").value = state.identity.name || "";
    $("anonChk").checked = !!state.identity.anon;
    paintProfileSite();
    paintNameCount();
    renderComposer();
  });
  $("who").addEventListener("click", () => {
    closePopovers("profilePop");
    $("profilePop").hidden = false;
  });
  $("quoteLine").addEventListener("click", () => {
    state.quote = null;
    renderComposer();
  });

  // theme controls
  $("gradA").addEventListener("click", () => openPicker("a"));
  $("gradB").addEventListener("click", () => openPicker("b"));
  $("gradAngle").addEventListener("input", (e) => {
    state.theme.gradient.angle = Number(e.target.value);
    state.theme.gradient.custom = true;
    applyTheme(document.documentElement, state.theme);
  paintScene();
    saveTheme();
  });
  $("gradAlpha").addEventListener("input", (e) => {
    state.theme.gradient.alpha = Number(e.target.value) / 100;
    applyTheme(document.documentElement, state.theme);
  paintScene();
    saveTheme();
  });
  $("pickerClose").addEventListener("click", () => {
    $("picker").hidden = true;
  });
  $("wheel").addEventListener("pointerdown", (e) => {
    pickFromEvent(e);
    const move = (ev) => pickFromEvent(ev);
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", stop);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", stop);
  });
  $("lightness").addEventListener("input", (e) => {
    picker.l = Number(e.target.value) / 100;
    drawWheel();
    applyPickedColor();
  });
  $("hex").addEventListener("change", (e) => {
    const value = e.target.value.trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(value)) {
      paintThemeControls();
      return;
    }
    const hex = value.startsWith("#") ? value : `#${value}`;
    state.theme.gradient = { ...state.theme.gradient, custom: true };
    if (picker.target === "b") state.theme.gradient.to = hex;
    else state.theme.gradient.from = hex;
    applyTheme(document.documentElement, state.theme);
  paintScene();
    paintSwatches();
    saveTheme();
  });
  $("bgFile").addEventListener("change", (e) => readBackground(e.target.files[0]));
  $("bgClear").addEventListener("click", () => {
    $("bgFile").value = "";
    useTheme({
      skin: state.theme.skin,
      gradient: state.theme.gradient,
      background: { ...state.theme.background, data: "" },
    });
  });
  $("bgFit").addEventListener("change", (e) => {
    state.theme.background.fit = e.target.value;
    applyTheme(document.documentElement, state.theme);
  paintScene();
    saveTheme();
  });
  /* Звук живёт в настройках, а не в теме: панель 🎨 только рядом с ним лежит,
     поэтому громкость и сигнал пишутся через settings:set, а не в orbita.theme. */
  $("soundOn").addEventListener("change", (e) => patchSound({ on: e.target.checked }));
  $("volume").addEventListener("input", (e) => {
    const pct = Number(e.target.value);
    $("lblVolume").textContent = `${t("sound.volume")} · ${pct}%`;
  });
  $("volume").addEventListener("change", (e) => {
    const volume = Number(e.target.value) / 100;
    patchSound({ volume });
    playSound(soundPrefs().tone, { volume, custom: state.customSound });
  });
  $("soundFile").addEventListener("change", (e) => readSound(e.target.files[0]));
  $("soundClear").addEventListener("click", async () => {
    const res = await send("sound:set", { dataUrl: "" });
    if (res && res.ok) {
      state.customSound = "";
      renderSound();
      flash(t("sound.cleared"), false);
    }
  });
  $("soundTest").addEventListener("click", () => {
    const p = soundPrefs();
    playSound(p.tone, { volume: Math.max(0.15, p.volume), custom: state.customSound });
  });
  $("bgAlpha").addEventListener("input", (e) => {
    state.theme.background.alpha = Number(e.target.value) / 100;
    applyTheme(document.documentElement, state.theme);
  paintScene();
    saveTheme();
  });
  $("glassBlur").addEventListener("change", (e) => {
    state.theme.blur = e.target.checked;
    applyTheme(document.documentElement, state.theme);
  paintScene();
    saveTheme();
  });
  /* Живой фон: три независимых ползунка, 0 = эффект выключен, 100 = максимальная
     скорость. Пишем в тему и сразу перекрашиваем — applyTheme разложит значения
     в --k-bub/--k-sun/--k-plant и data-bub/sun/plant на <html>.
     Сохранение отложено на 350 мс, поэтому взмах ползунком не пишет в storage. */
  [["liveBubbles", "bubbles"], ["liveSun", "sun"], ["livePlants", "plants"]].forEach(([id, key]) => {
    $(id).addEventListener("input", (e) => {
      state.theme.live = { ...(state.theme.live || {}), [key]: Number(e.target.value) };
      applyTheme(document.documentElement, state.theme);
  paintScene();
      saveTheme();
    });
  });
  $("sphereSpeed").addEventListener("input", (e) => {
    state.theme.sphereSpeed = Number(e.target.value);
    applyTheme(document.documentElement, state.theme);
    saveTheme();
  });
  $("panelAlpha").addEventListener("input", (e) => {
    state.theme.panelAlpha = Number(e.target.value);
    applyTheme(document.documentElement, state.theme);
  paintScene();
    saveTheme();
  });
  $("themeReset").addEventListener("click", () => {
    $("picker").hidden = true;
    useTheme(structuredClone(DEFAULT_THEME));
  });

  $("anonChk").addEventListener("change", async (e) => {
    await send("identity:set", { patch: { anon: e.target.checked }, url: state.url });
    await loadIdentity();
    paintProfileSite();
    renderComposer();
  });
  $("nameInput").addEventListener("input", paintNameCount);
  $("nameInput").addEventListener("change", async (e) => {
    const name = e.target.value.trim().slice(0, NAME_MAX);
    await send("identity:set", { patch: { name, anon: false }, url: state.url });
    $("anonChk").checked = false;
    await loadIdentity();
    $("nameInput").value = state.identity.name || "";
    paintIdentityLock();
    paintProfileSite();
    paintNameCount();
    renderComposer();
  });
  $("avatarFile").addEventListener("change", (e) => readAvatar(e.target.files[0]));
  $("filterChk").addEventListener("change", async (e) => {
    await send("settings:set", { patch: { filter: e.target.checked } });
    await loadSettings();
    refresh();
  });
  $("hiddenChk").addEventListener("change", async (e) => {
    await send("settings:set", { patch: { showHidden: e.target.checked } });
    await loadSettings();
    refresh();
  });
  $("uiLangSel").addEventListener("change", async (e) => {
    await send("settings:set", { patch: { uiLang: e.target.value } });
    await loadSettings();
    applyLocale();
    refresh();
  });
  $("composer").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const text = $("text").value;
    if (!text.trim()) return;
    const res = await send("msg:post", {
      url: state.url,
      title: state.title,
      lang: state.lang,
      text,
      quote: state.quote ? state.quote.text : "",
      replyTo: state.quote ? state.quote.id : "",
    });
    if (res && res.error === "rate_limited") {
      flash(`${t("composer.rate_limit")} ${res.retryInSec} ${t("composer.sec")}`, true);
      return;
    }
    if (res && res.error) {
      flash(String(res.error), true);
      return;
    }
    $("text").value = "";
    state.quote = null;
    jumpBottom = true;
    refresh();
  });
  $("text").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      $("composer").requestSubmit();
    }
  });
  document.addEventListener("click", (ev) => {
    const pop = $("langPop");
    if (!pop.hidden && !pop.contains(ev.target) && !$("langBtn").contains(ev.target) && !$("lentaLangBtn").contains(ev.target)) {
      pop.hidden = true;
    }
    const uiPop = $("uiLangPop");
    if (!uiPop.hidden && !uiPop.contains(ev.target) && !$("uiLangBtn").contains(ev.target)) {
      uiPop.hidden = true;
      renderHeader();
    }
    const theme = $("themePop");
    if (!theme.hidden && !theme.contains(ev.target) && !$("themeBtn").contains(ev.target)) {
      theme.hidden = true;
      renderHeader();
    }
    const profile = $("profilePop");
    if (!profile.hidden && !profile.contains(ev.target) && !$("profileBtn").contains(ev.target) && !$("who").contains(ev.target)) {
      profile.hidden = true;
    }
    const mirror = $("mirrorPop");
    if (!mirror.hidden && !mirror.contains(ev.target) && !$("mirrorBtn").contains(ev.target)) {
      mirror.hidden = true;
      renderHeader();
    }
  });
  addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!$("langPop").hidden) $("langPop").hidden = true;
      else if (!$("uiLangPop").hidden) {
        $("uiLangPop").hidden = true;
        renderHeader();
      } else if (!$("profilePop").hidden) $("profilePop").hidden = true;
      else if (!$("themePop").hidden) $("themePop").hidden = true;
      else if (!$("mirrorPop").hidden) {
        $("mirrorPop").hidden = true;
        renderHeader();
      } else close();
    }
  });
  addEventListener("message", (ev) => {
    if (ev.data && ev.data.source === "orbita-host" && ev.data.action === "closing") close();
  });
  if (!EMBEDDED) {
    addEventListener("resize", () => {
      applyDrawerMode();
      measurePanels();
    });
  }
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "orbita:event") return;
    if (msg.event === "sync" && msg.payload && msg.payload.online === false) {
      flash(`${t("sync.offline")}: ${msg.payload.error || ""}`, true);
      return;
    }
    debouncedRefresh();
  });
}

let timer = null;
function debouncedRefresh() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 250);
}

function close() {
  send("channel:close").catch(() => {});
  if (EMBEDDED) {
    parent.postMessage({ source: "orbita-chat", action: "close" }, "*");
    return;
  }
  /* Во вкладке родителя нет — просим фон закрыть саму вкладку, и только если
     сообщение не ушло, пробуем window.close(). */
  try {
    chrome.runtime.sendMessage({ type: "chat:close" }, () => {
      if (chrome.runtime.lastError) window.close();
    });
  } catch {
    window.close();
  }
}

function hideSiteRow() {
  const row = el("label", "row");
  const span = el("span", null, t("header.hide_site"));
  const btn = el("button", "vbtn", "⛔");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    try {
      const host = new URL(state.url).hostname.replace(/^www\./, "");
      await send("site:hide", { domain: host });
      flash(`${t("site.hidden")} ${host}`, false);
    } catch {
      /* bad url */
    }
  });
  row.append(span, btn);
  $("profilePop").appendChild(row);
}

async function init() {
  parent.postMessage({ source: "orbita-chat", action: "ready" }, "*");
  if (!state.url) {
    state.url = location.href;
    state.title = document.title;
  }
  if (!EMBEDDED) document.documentElement.classList.add("standalone");
  const [collapsedRaw, themeRaw, geomRaw] = await Promise.all([
    storeGet(COLLAPSED_KEY),
    storeGet(THEME_KEY),
    storeGet(GEOM_KEY),
  ]);
  const siteGeom = geomFor(geomRaw, siteHost());
  applyStandSize(siteGeom);
  if (!EMBEDDED) initStandaloneWindow(geomRaw, siteGeom);
  state.collapsed = collapsedRaw && typeof collapsedRaw === "object" ? collapsedRaw : {};
  state.theme = normalizeTheme(themeRaw);
  applyTheme(document.documentElement, state.theme);
  paintScene();
  await Promise.all([loadSettings(), loadIdentity()]);
  UI_LANGS.forEach((code) => $("uiLangSel").add(new Option(langName(code) || code.toUpperCase(), code)));
  $("uiLangSel").value = state.settings.uiLang || "ru";
  $("anonChk").checked = !!state.identity.anon;
  $("nameInput").value = state.identity.name || "";
  $("opacity").value = String(Math.round((siteGeom.opacity || 0.9) * 100));
  $("filterChk").checked = state.settings.filter !== false;
  $("hiddenChk").checked = !!state.settings.showHidden;
  applyLocale();
  applyDrawerMode();
  paintThemeControls();
  paintIdentityLock();
  hideSiteRow();
  bindEvents();
  bindHostControls();
  /* Свой mp3 может весить мегабайты — читаем его один раз при старте и только
     когда человек вообще собрался звучать. */
  if (soundPrefs().on !== false) {
    const own = await send("sound:get").catch(() => null);
    state.customSound = (own && own.dataUrl) || "";
    renderSound();
  }
  // браузер не даёт звуку стартовать без жеста: первое же касание будит AudioContext
  addEventListener("pointerdown", unlockSound, { capture: true });
  await send("channel:open", { url: state.url, title: state.title, lang: state.lang, visible: !document.hidden });
  await refresh();
  measurePanels();
  syncPanels("init");
  if (state.jumpTo) {
    const id = state.jumpTo;
    state.jumpTo = "";
    jumpToMessage(id);
  }
  // маяк: раз в 20 секунд говорим фоновому скрипту, что эта комната жива, и говорим,
  // смотрит ли в неё человек — фоновая вкладка не должна считаться «онлайном»
  const ping = () =>
    send("presence", { url: state.url, lang: state.lang, visible: !document.hidden })
      .then((r) => {
        if (r && typeof r.clients === "number") {
          state.clients = r.clients;
          renderHeader();
        }
      })
      .catch(() => {});
  setInterval(ping, 20000);
  document.addEventListener("visibilitychange", ping);
  addEventListener("beforeunload", () => send("channel:close").catch(() => {}));
}

init();
