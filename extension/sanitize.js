const STOPWORDS = [
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "cunt",
  "хуй", "пизд", "ебуч", "ёбуч", "блять", "мудак", "говно", "сран",
  "nazi", "cccp-lol",
];

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"')\]]+)/gi;

export function extractLinks(text) {
  const found = text.match(URL_RE) || [];
  return found.slice(0, 4).map((raw) => {
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let host = "";
    try {
      host = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      host = raw.slice(0, 40);
    }
    return { href, host, title: host };
  });
}

/* Какие параметры адреса переживают нормализацию комнаты.
   Раньше список был запретным (выбрасывали utm_/gclid/fbclid/ref), то есть наружу уезжало
   всё остальное — включая `?q=` из поиска, `?token=` из писем и параметры приватных разделов.
   Комната всё равно улетает на сервер, поэтому правила теперь разрешающие: оставляем только
   то, что различает страницы (ролик, тема, страница), и выбрасываем остальное. */
const QUERY_KEEP = /^(v|id|p|post|topic|t|page|pid|w|do|act|chat|room|msg|mid|aid|kanal)$/i;

export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return String(raw || "").slice(0, 200);
  }
  u.hash = "";
  u.username = "";
  u.password = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  const keep = [];
  u.searchParams.forEach((value, key) => {
    if (QUERY_KEEP.test(key) && value.length <= 64) keep.push([key, value]);
  });
  u.search = "";
  keep.forEach(([key, value]) => u.searchParams.append(key, value));
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/";
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.origin + u.pathname + u.search;
}

export function channelKey(url, lang) {
  return `${normalizeUrl(url)}#${lang}`;
}

export function censored(text, enabled) {
  if (!enabled) return text;
  let out = text;
  for (const word of STOPWORDS) {
    const re = new RegExp(word, "gi");
    out = out.replace(re, (m) => m[0] + "█".repeat(Math.max(1, m.length - 1)));
  }
  return out;
}

export function safeText(text) {
  return String(text == null ? "" : text).replace(/[ \t]+\n/g, "\n").slice(0, 2000);
}

export function deviceToken(id) {
  return String(id || "anon").slice(-6);
}
