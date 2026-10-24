const PRIMARY = [
  { code: "en", native: "English", ru: "Английский" },
  { code: "ru", native: "Русский", ru: "Русский" },
  { code: "de", native: "Deutsch", ru: "Немецкий" },
  { code: "es", native: "Español", ru: "Испанский" },
];

const REST = [
  { code: "pt", native: "Português", ru: "Португальский" },
  { code: "hi", native: "हिन्दी", ru: "Хинди" },
  { code: "id", native: "Indonesia", ru: "Индонезийский" },
  { code: "ja", native: "日本語", ru: "Японский" },
  { code: "ar", native: "العربية", ru: "Арабский" },
  { code: "fr", native: "Français", ru: "Французский" },
  { code: "ko", native: "한국어", ru: "Корейский" },
  { code: "tr", native: "Türkçe", ru: "Турецкий" },
  { code: "vi", native: "Tiếng Việt", ru: "Вьетнамский" },
  { code: "it", native: "Italiano", ru: "Итальянский" },
  { code: "th", native: "ไทย", ru: "Тайский" },
  { code: "zh-CN", native: "中文(简体)", ru: "Китайский (упр.)" },
  { code: "zh-TW", native: "中文(繁體)", ru: "Китайский (трад.)" },
  { code: "nl", native: "Nederlands", ru: "Голландский" },
  { code: "pl", native: "Polski", ru: "Польский" },
  { code: "uk", native: "Українська", ru: "Украинский" },
  { code: "fil", native: "Filipino", ru: "Филиппинский" },
  { code: "ms", native: "Melayu", ru: "Малайский" },
  { code: "bn", native: "বাংলা", ru: "Бенгальский" },
  { code: "ta", native: "தமிழ்", ru: "Тамильский" },
  { code: "te", native: "తెలుగు", ru: "Телугу" },
  { code: "sv", native: "Svenska", ru: "Шведский" },
  { code: "fa", native: "فارسی", ru: "Персидский" },
  { code: "he", native: "עברית", ru: "Иврит" },
  { code: "ro", native: "Română", ru: "Румынский" },
  { code: "el", native: "Ελληνικά", ru: "Греческий" },
  { code: "cs", native: "Čeština", ru: "Чешский" },
  { code: "hu", native: "Magyar", ru: "Венгерский" },
  { code: "fi", native: "Suomi", ru: "Финский" },
  { code: "da", native: "Dansk", ru: "Датский" },
  { code: "no", native: "Norsk", ru: "Норвежский" },
  { code: "bg", native: "Български", ru: "Болгарский" },
  { code: "hr", native: "Hrvatski", ru: "Хорватский" },
  { code: "sr", native: "Српски", ru: "Сербский" },
  { code: "sk", native: "Slovenčina", ru: "Словацкий" },
  { code: "lt", native: "Lietuvių", ru: "Литовский" },
  { code: "lv", native: "Latviešu", ru: "Латышский" },
  { code: "et", native: "Eesti", ru: "Эстонский" },
  { code: "ca", native: "Català", ru: "Каталанский" },
  { code: "gl", native: "Galego", ru: "Галисийский" },
  { code: "su", native: "Sundanese", ru: "Сунданский" },
  { code: "sw", native: "Kiswahili", ru: "Суахили" },
  { code: "af", native: "Afrikaans", ru: "Африкаанс" },
  { code: "ka", native: "ქართული", ru: "Грузинский" },
  { code: "hy", native: "Հայերեն", ru: "Армянский" },
  { code: "kk", native: "Қазақша", ru: "Казахский" },
  { code: "az", native: "Azərbaycanca", ru: "Азербайджанский" },
  { code: "eo", native: "Esperanto", ru: "Эсперанто" },
  { code: "la", native: "Latina", ru: "Латынь" },
];

export const LANGS = [...PRIMARY, ...REST];
export const PRIMARY_CODES = PRIMARY.map((l) => l.code);

export function langName(code) {
  const hit = LANGS.find((l) => l.code === code);
  return hit ? hit.native : code;
}

export function searchLangs(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return LANGS;
  return LANGS.filter(
    (l) =>
      l.code.toLowerCase().includes(q) ||
      l.native.toLowerCase().includes(q) ||
      (l.ru || "").toLowerCase().includes(q)
  );
}
