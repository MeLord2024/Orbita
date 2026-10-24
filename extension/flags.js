// Language picker assets. Flag emoji do not render as flags on Windows,
// so every entry is a tiny inline SVG built from local constants only.

const W = 18;
const H = 12;

const wrap = (inner) =>
  `<svg class="flag" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false">` +
  `${inner}<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="rgba(0,0,0,.28)"/></svg>`;

const horizontal = (colors) => {
  const band = H / colors.length;
  return colors.map((c, i) => `<rect x="0" y="${(i * band).toFixed(2)}" width="${W}" height="${(band + 0.02).toFixed(2)}" fill="${c}"/>`).join("");
};

const vertical = (colors) => {
  const band = W / colors.length;
  return colors.map((c, i) => `<rect x="${(i * band).toFixed(2)}" y="0" width="${(band + 0.02).toFixed(2)}" height="${H}" fill="${c}"/>`).join("");
};

const us = () => {
  let out = `<rect width="${W}" height="${H}" fill="#f7f7f7"/>`;
  for (let i = 0; i < 7; i += 1) out += `<rect x="0" y="${(i * (H / 7)).toFixed(2)}" width="${W}" height="${(H / 14).toFixed(2)}" fill="#c6273c"/>`;
  out += `<rect x="0" y="0" width="${W * 0.45}" height="${H * 0.55}" fill="#2b3d8f"/>`;
  for (let r = 0; r < 2; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      out += `<circle cx="${(1.6 + c * 1.9).toFixed(2)}" cy="${(1.7 + r * 2.2).toFixed(2)}" r="0.55" fill="#fff"/>`;
    }
  }
  return out;
};

const jp = () => `<rect width="${W}" height="${H}" fill="#f7f7f7"/><circle cx="9" cy="6" r="3.2" fill="#d0263a"/>`;

const CN_STAR =
  "4.5,3.4 5.15,5.11 6.97,5.2 5.55,6.34 6.03,8.1 4.5,7.1 2.97,8.1 3.45,6.34 2.03,5.2 3.85,5.11";
const cn = () =>
  `<rect width="${W}" height="${H}" fill="#d4322b"/><polygon points="${CN_STAR}" fill="#ffd85c" transform="translate(0.4,-1.2) scale(0.95)"/>` +
  `<circle cx="8.4" cy="2.6" r="0.6" fill="#ffd85c"/><circle cx="9.6" cy="4.4" r="0.6" fill="#ffd85c"/><circle cx="9.2" cy="6.6" r="0.6" fill="#ffd85c"/>`;

export const LANG_META = [
  { code: "ru", name: "Русский", svg: wrap(horizontal(["#f7f7f7", "#2b4fa0", "#d0263a"])) },
  { code: "en", name: "English", svg: wrap(us()) },
  { code: "de", name: "Deutsch", svg: wrap(horizontal(["#232323", "#d7242e", "#f7ce2b"])) },
  { code: "fr", name: "Français", svg: wrap(vertical(["#2b3d8f", "#f7f7f7", "#d0263a"])) },
  { code: "es", name: "Español", svg: wrap(`<rect width="${W}" height="${H}" fill="#c6273c"/><rect x="0" y="3" width="${W}" height="6" fill="#f7ce2b"/>`) },
  { code: "it", name: "Italiano", svg: wrap(vertical(["#3d8a4e", "#f7f7f7", "#d0263a"])) },
  { code: "ja", name: "日本語", svg: wrap(jp()) },
  { code: "zh", name: "中文", svg: wrap(cn()) },
];

export const UI_LANG_ORDER = LANG_META.map((l) => l.code);

export function flagSvg(code) {
  const meta = LANG_META.find((l) => l.code === code);
  return meta ? meta.svg : "";
}

export function langName(code) {
  const meta = LANG_META.find((l) => l.code === code);
  return meta ? meta.name : code;
}
