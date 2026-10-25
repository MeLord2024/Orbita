// Skin tokens + gradient/background engine for the Orbita chat UI.
// Readability rule: message bubbles always keep a solid-ish backdrop and a
// guaranteed ink contrast, no matter what skin, gradient or background is on.

const MILITARY_TOKENS = {
  ink: "#eafaf0", muted: "#93b8a2", panel: "rgba(14,22,17,0.86)", panelAlt: "rgba(26,40,31,0.78)",
  line: "rgba(74,222,128,0.3)", bubble: "rgba(248,252,250,0.94)", bubbleInk: "#10201a",
  bubbleSub: "#4d6a5a", accent: "#4ade80", accent2: "#2fa35c", accentInk: "#04150c",
  scoreBg: "rgba(26,40,31,0.8)", scoreInk: "#dcf5e4", link: "#7db8ff", star: "#ffd166",
 flame: "#ffa02e", gold: "#ffd166",
  drawer: "rgba(8,14,10,0.55)", searchBg: "rgba(255,255,255,0.92)", searchInk: "#16241c",
};

export const SKINS = [
  {
    id: "azure",
    name: "Лазурь",
    mode: "light",
    preview: ["#c9f0ff", "#2f7ff2"],
    tokens: {
      ink: "#0d2c4a", muted: "#4b708f", panel: "rgba(228,246,255,0.88)", panelAlt: "rgba(255,255,255,0.7)",
      line: "rgba(47,127,242,0.3)", bubble: "rgba(255,255,255,0.95)", bubbleInk: "#0d2c4a",
      bubbleSub: "#4b708f", accent: "#1f8fe0", accent2: "#1d6fc0", accentInk: "#ffffff",
      scoreBg: "rgba(255,255,255,0.85)", scoreInk: "#0d2c4a", link: "#0a5cc0", star: "#e08a00",
 flame: "#ff7a1a", gold: "#ffc93c",
      drawer: "rgba(255,255,255,0.45)", searchBg: "rgba(255,255,255,0.96)", searchInk: "#0d2c4a",
    },
    gradient: { from: "#d3f2ff", to: "#2f7ff2", angle: 160, alpha: 0.72 },
  },
  {
    id: "lime",
    name: "Салат aero",
    mode: "light",
    preview: ["#d9ff8f", "#3fd9b0"],
    tokens: {
      ink: "#12331f", muted: "#4c7a5c", panel: "rgba(240,255,232,0.86)", panelAlt: "rgba(255,255,255,0.7)",
      line: "rgba(46,160,110,0.32)", bubble: "rgba(255,255,255,0.95)", bubbleInk: "#14261b",
      bubbleSub: "#5b7f68", accent: "#3fbf5f", accent2: "#1f9e57", accentInk: "#ffffff",
      scoreBg: "rgba(255,255,255,0.82)", scoreInk: "#14261b", link: "#0a6fb0", star: "#d98a00",
 flame: "#ff8a2b", gold: "#ffd23f",
      drawer: "rgba(255,255,255,0.45)", searchBg: "rgba(255,255,255,0.96)", searchInk: "#14261b",
    },
    gradient: { from: "#e4ff9c", to: "#3fd9b0", angle: 135, alpha: 0.72 },
  },
  {
    id: "daylight",
    name: "Дневной",
    mode: "light",
    preview: ["#fff3c4", "#8fe3a8"],
    tokens: {
      ink: "#2c2a17", muted: "#6f6a4c", panel: "rgba(255,252,238,0.88)", panelAlt: "rgba(255,255,255,0.72)",
      line: "rgba(190,160,60,0.3)", bubble: "rgba(255,255,255,0.96)", bubbleInk: "#2c2a17",
      bubbleSub: "#7a7355", accent: "#e0a52a", accent2: "#3fbf5f", accentInk: "#ffffff",
      scoreBg: "rgba(255,255,255,0.86)", scoreInk: "#2c2a17", link: "#1f6fb8", star: "#c9902a",
 flame: "#f97316", gold: "#f5b301",
      drawer: "rgba(255,255,255,0.48)", searchBg: "rgba(255,255,255,0.96)", searchInk: "#2c2a17",
    },
    gradient: { from: "#fff0b8", to: "#9fe6b4", angle: 120, alpha: 0.68 },
  },
  {
    id: "coral",
    name: "Коралл",
    mode: "light",
    preview: ["#ffd7e6", "#ffb26b"],
    tokens: {
      ink: "#3a2028", muted: "#8a6068", panel: "rgba(255,242,245,0.88)", panelAlt: "rgba(255,255,255,0.7)",
      line: "rgba(230,120,140,0.3)", bubble: "rgba(255,255,255,0.96)", bubbleInk: "#3a2028",
      bubbleSub: "#8a6068", accent: "#e0557a", accent2: "#f08a3c", accentInk: "#ffffff",
      scoreBg: "rgba(255,255,255,0.86)", scoreInk: "#3a2028", link: "#c04a2a", star: "#d98a00",
 flame: "#ff5f2e", gold: "#ffc247",
      drawer: "rgba(255,255,255,0.46)", searchBg: "rgba(255,255,255,0.96)", searchInk: "#3a2028",
    },
    gradient: { from: "#ffd9e8", to: "#ffbe7a", angle: 130, alpha: 0.68 },
  },
  {
    id: "mint",
    name: "Мята стекло",
    mode: "light",
    preview: ["#d6fff2", "#5fd6c0"],
    tokens: {
      ink: "#123c34", muted: "#4e8078", panel: "rgba(232,255,248,0.86)", panelAlt: "rgba(255,255,255,0.7)",
      line: "rgba(40,160,140,0.3)", bubble: "rgba(255,255,255,0.95)", bubbleInk: "#123c34",
      bubbleSub: "#4e8078", accent: "#25c2a0", accent2: "#16a34a", accentInk: "#04241c",
      scoreBg: "rgba(255,255,255,0.86)", scoreInk: "#123c34", link: "#0a7f9e", star: "#d9a000",
 flame: "#ff8a3c", gold: "#ffcf4d",
      drawer: "rgba(255,255,255,0.45)", searchBg: "rgba(255,255,255,0.96)", searchInk: "#123c34",
    },
    gradient: { from: "#dcfff4", to: "#5fd6c0", angle: 150, alpha: 0.68 },
  },
  {
    id: "ultra",
    name: "Ультра aero",
    mode: "dark",
    preview: ["#8b5cf6", "#38bdf8"],
    tokens: {
      ink: "#eae6ff", muted: "#a99fd6", panel: "rgba(18,14,40,0.88)", panelAlt: "rgba(38,28,74,0.74)",
      line: "rgba(160,120,255,0.3)", bubble: "rgba(240,238,255,0.94)", bubbleInk: "#241a4a",
      bubbleSub: "#5b5288", accent: "#a78bfa", accent2: "#38bdf8", accentInk: "#160f33",
      scoreBg: "rgba(38,28,74,0.9)", scoreInk: "#eae6ff", link: "#7dd3fc", star: "#ffd166",
 flame: "#ff7a45", gold: "#ffd166",
      drawer: "rgba(14,10,32,0.55)", searchBg: "rgba(240,238,255,0.92)", searchInk: "#241a4a",
    },
    gradient: { from: "#7c3aed", to: "#38bdf8", angle: 140, alpha: 0.5 },
  },
  {
    id: "night",
    name: "Ночной",
    mode: "dark",
    preview: ["#1b2450", "#0f7a44"],
    tokens: {
      ink: "#dfe6ff", muted: "#8b93b8", panel: "rgba(10,13,30,0.88)", panelAlt: "rgba(24,28,56,0.74)",
      line: "rgba(120,140,255,0.28)", bubble: "rgba(28,33,66,0.92)", bubbleInk: "#e6ebff",
      bubbleSub: "#98a1cc", accent: "#7aa2ff", accent2: "#3f5fd0", accentInk: "#0a0d22",
      scoreBg: "rgba(24,28,56,0.9)", scoreInk: "#dfe6ff", link: "#8fc3ff", star: "#ffd166",
 flame: "#ff8b3d", gold: "#ffd166",
      drawer: "rgba(6,9,24,0.55)", searchBg: "rgba(24,28,56,0.9)", searchInk: "#e6ebff",
    },
    gradient: { from: "#1b2450", to: "#0f7a44", angle: 145, alpha: 0.5 },
  },
  {
    id: "military",
    name: "Милитари",
    mode: "dark",
    preview: ["#0f7a44", "#4ade80"],
    tokens: MILITARY_TOKENS,
    gradient: { from: "#0f7a44", to: "#4ade80", angle: 135, alpha: 0.4 },
  },
];

// Skins that restyle the whole surface (glass, aurora) — own group in the picker.
export const SPECIAL_SKINS = [
  {
    id: "frutiger",
    name: "Frutiger Aero",
    mode: "light",
    glass: true,
    aurora: true,
    /* Настоящая Aero-сцена и передний план из растений. Лежат в extension/bg/,
       грузятся один раз; CSS-градиенты остаются подстраховкой, если файл не открылся. */
    scene: "bg/aero.jpg",
    grass: "bg/grass.jpg",
    preview: ["#8fe3ff", "#1f6fd0"],
    tokens: {
      ink: "#0d3550", muted: "#35627f", panel: "rgba(255,255,255,0.34)", panelAlt: "rgba(255,255,255,0.5)",
      line: "rgba(255,255,255,0.7)", bubble: "rgba(255,255,255,0.6)", bubbleInk: "#0e3350",
      bubbleSub: "#35627f", accent: "#17a8dd", accent2: "#0d7fb8", accentInk: "#ffffff",
      scoreBg: "rgba(255,255,255,0.72)", scoreInk: "#0e3350", link: "#0a6ea8", star: "#ffb703",
 flame: "#ff7a1a", gold: "#ffc93c",
      drawer: "rgba(255,255,255,0.28)", searchBg: "rgba(255,255,255,0.82)", searchInk: "#0e3350",
      /* Aero-only: pale cyan for the top of glossy buttons, deep blue for the shadow
         under them, navy for the medallions in the animations drawer. */
      aqua: "#8fe6ff", deep: "rgba(8, 66, 112, 0.3)", medal: "#0f4a72", medal2: "#071e33",
    },
    gradient: { from: "#cdf3ff", to: "#1a6fc4", angle: 155, alpha: 0.45 },
  },
];

export const ALL_SKINS = [...SKINS, ...SPECIAL_SKINS];

/* Aurora wash for the glass skin: a still Aero scene in pure CSS, no assets.
   Layers paint top-down, so the sky gradient goes last and everything else
   (clouds, sun path on the water, two bubbles) sits on top of it. It is one
   static paint on one element — nothing here animates or repaints. */
const AURORA =
  "radial-gradient(46% 26% at 16% 11%, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 70%)," +
  "radial-gradient(38% 20% at 76% 7%, rgba(255,255,255,.8) 0%, rgba(255,255,255,0) 72%)," +
  "radial-gradient(54% 17% at 50% 67%, rgba(255,255,255,.85) 0%, rgba(255,255,255,0) 74%)," +
  "radial-gradient(circle at 88% 81%, rgba(255,255,255,0) 34px, rgba(255,255,255,.6) 35px, rgba(200,240,255,.14) 39px, rgba(255,255,255,0) 41px)," +
  "radial-gradient(circle at 11% 87%, rgba(255,255,255,0) 19px, rgba(255,255,255,.5) 20px, rgba(255,255,255,0) 23px)," +
  "linear-gradient(180deg, rgba(214,246,255,.96) 0%, rgba(151,226,255,.92) 32%, rgba(92,185,235,.9) 62%, rgba(38,150,212,.92) 100%)";

export const DEFAULT_THEME = {
  skin: "azure",
  blur: true,
  liveSpeed: "normal",
  gradient: { ...SKINS[0].gradient, custom: false },
  background: { data: "", fit: "cover", alpha: 0.35 },
};

// «Живой фон»: множитель длительности анимаций (меньше — быстрее). off — стенд.
const LIVE_SPEED = { off: 0, slow: 1.7, normal: 1, fast: 0.62 };

// Simple glassy avatar gradients — one per author id, so anons look different
// from message to message but stay stable while scrolling.
export const AVATARS = [
  ["#7ee8fa", "#1f6fd0"], ["#a1ffce", "#12a4a0"], ["#fbc2eb", "#a18cd1"], ["#ffecd2", "#fcb69f"],
  ["#84fab0", "#2bb673"], ["#a6c0fe", "#4a6cf7"], ["#fdd0a2", "#ff6a88"], ["#96fbc4", "#38c7c3"],
  ["#d299c2", "#4b6cb7"], ["#8fd3f4", "#2f7ff2"], ["#f6d365", "#da748c"], ["#c1dfc4", "#267871"],
  ["#e0c3fc", "#6a5cff"], ["#91eae4", "#30b0c7"], ["#ff9a9e", "#f6b54e"], ["#9be7f4", "#1f8fe0"],
  ["#fbc7d4", "#959eca"], ["#b8f5e8", "#16a34a"], ["#ffe29f", "#ffa99f"], ["#8ee4af", "#135e8a"],
  ["#cac6ff", "#4c5470"], ["#8fd3f4", "#84fab0"], ["#fddb92", "#d1fdff"], ["#a1c4fd", "#c2e9fb"],
  ["#f09ff8", "#7367f0"], ["#74ebd5", "#5bb6e0"], ["#fff1eb", "#acc6ee"], ["#ffd1ff", "#c98bd4"],
  ["#9890e3", "#4b6cb7"], ["#84fec4", "#20bfa0"], ["#ffb199", "#ff0844"], ["#a8edea", "#2c9cd8"],
  ["#fbd3e9", "#bb370d"], ["#92fe9d", "#1a6f4b"], ["#ffedbc", "#f79d00"], ["#8ec5fc", "#4b6cb7"],
  ["#f5c6d2", "#9796f0"], ["#99f2c8", "#38b77c"], ["#e8cbf7", "#5b86e5"], ["#7de2fc", "#1176bb"],
];

export function skinById(id) {
  return ALL_SKINS.find((s) => s.id === id) || SKINS[0];
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function avatarGradient(seed) {
  const [a, b] = AVATARS[hash(seed || "anon") % AVATARS.length];
  return `linear-gradient(135deg, ${a}, ${b})`;
}

function hexToRgba(hex, alpha) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0").slice(0, 6);
  const num = parseInt(full, 16);
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

export function gradientCss(g) {
  if (!g || !g.from || !g.to) return "none";
  return `linear-gradient(${g.angle}deg, ${hexToRgba(g.from, 1)}, ${hexToRgba(g.to, 1)})`;
}

/* Значения перекладываются на :root по каждому ползунку 🎨, а `--bg-image` — это data-URL
   на несколько мегабайт: перезать его раз сто за один взмах слайдера значит стодвадцать
   раз разобрать строчку в CSS-парсере. Потому пропуск одинаковых значений. */
const applied = new WeakMap();

export function applyTheme(root, theme) {
  const skin = skinById(theme.skin);
  let cache = applied.get(root);
  if (!cache) {
    cache = new Map();
    applied.set(root, cache);
  }
  const set = (name, value) => {
    if (cache.get(name) === value) return;
    cache.set(name, value);
    root.style.setProperty(name, value);
  };
  for (const [key, value] of Object.entries(skin.tokens)) {
    set(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value);
  }
  set("--mode", skin.mode);
  set("--grad", gradientCss(theme.gradient));
  set("--grad-alpha", String(theme.gradient.alpha ?? 0.2));
  set("--aurora", skin.aurora ? AURORA : "none");
  set("--scene", skin.scene ? `url("${skin.scene}")` : "none");
  set("--grass", skin.grass ? `url("${skin.grass}")` : "none");
  set("--live-k", String(LIVE_SPEED[theme.liveSpeed] ?? 1));
  set("--bg-image", theme.background.data ? `url(${theme.background.data})` : "none");
  set("--bg-size", theme.background.fit === "tile" ? "auto" : theme.background.fit);
  set("--bg-repeat", theme.background.fit === "tile" ? "repeat" : "no-repeat");
  set("--bg-alpha", String(theme.background.data ? theme.background.alpha : 0));
  root.dataset.skin = skin.id;
  root.dataset.glass = skin.glass ? "1" : "0";
  root.dataset.live = skin.glass && theme.liveSpeed !== "off" ? "1" : "0";
  root.dataset.blur = theme.blur === false ? "0" : "1";
  root.dataset.mode = skin.mode;
}

export function normalizeTheme(raw) {
  const base = structuredClone(DEFAULT_THEME);
  if (!raw || typeof raw !== "object") return base;
  if (ALL_SKINS.some((s) => s.id === raw.skin)) base.skin = raw.skin;
  if (typeof raw.blur === "boolean") base.blur = raw.blur;
  if (Object.prototype.hasOwnProperty.call(LIVE_SPEED, raw.liveSpeed)) base.liveSpeed = raw.liveSpeed;
  Object.assign(base.gradient, raw.gradient || {});
  Object.assign(base.background, raw.background || {});
  if (base.background.fit === "repeat") base.background.fit = "tile";
  if (!["cover", "contain", "tile", "center", "repeat-x", "repeat-y"].includes(base.background.fit)) {
    base.background.fit = "cover";
  }
  return base;
}
