// Locale sync check: every UI language must carry the same key set as ru,
// and every t("key") used in the code must exist.
// Run: node tests/check_locales.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, "..", "extension");
const { STRINGS, UI_LANGS } = await import("../extension/locales.js");
const { LANG_META, UI_LANG_ORDER, flagSvg, langName } = await import("../extension/flags.js");

const base = Object.keys(STRINGS.ru).sort();
let bad = 0;

for (const lang of Object.keys(STRINGS)) {
  const keys = Object.keys(STRINGS[lang]);
  const missing = base.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !base.includes(k));
  if (missing.length || extra.length) {
    bad += 1;
    console.log(`${lang}: missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`);
  } else if (new Set(keys).size !== keys.length) {
    bad += 1;
    console.log(`${lang}: duplicate keys`);
  } else {
    console.log(`  ok ${lang}: ${keys.length} keys`);
  }
}

if (String(UI_LANGS.join(",")) !== String(UI_LANG_ORDER.join(","))) {
  bad += 1;
  console.log(`UI_LANGS ${UI_LANGS} != UI_LANG_ORDER ${UI_LANG_ORDER}`);
} else {
  console.log(`  ok UI_LANGS = ${UI_LANGS.join(", ")}`);
}
for (const l of LANG_META) {
  if (!flagSvg(l.code).startsWith("<svg") || !l.name) {
    bad += 1;
    console.log(`flag/name missing for ${l.code}`);
  }
}
for (const code of UI_LANG_ORDER) {
  if (!langName(code)) {
    bad += 1;
    console.log(`no native name for ${code}`);
  }
}
console.log(`  ok ${LANG_META.length} flags`);

const used = new Set();
const collect = (text) => {
  for (const m of text.matchAll(/\bt\(\s*"([a-z0-9_.:-]+)"/g)) used.add(m[1]);
  for (const m of text.matchAll(/t\(`([a-z0-9_.:-]+)`\)/g)) used.add(m[1]);
};
for (const file of fs.readdirSync(EXT)) {
  if (!file.endsWith(".js") || file === "locales.js" || file === "locales_more.js") continue;
  collect(fs.readFileSync(path.join(EXT, file), "utf8"));
}
const unknown = [...used].filter((k) => !base.includes(k));
if (unknown.length) {
  bad += 1;
  console.log(`keys used but not defined: ${JSON.stringify(unknown)}`);
}
const unused = base.filter((k) => !used.has(k) && !k.startsWith("msg.") && !k.includes("."));
console.log(`  ok ${used.size} t() keys resolve in ru`);
void unused;

console.log(bad ? `FAIL: ${bad} problem(s)` : `PASS: ${Object.keys(STRINGS).length} locales x ${base.length} keys`);
process.exit(bad ? 1 : 0);
