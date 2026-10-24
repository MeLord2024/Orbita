import io, sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

VOTES = {
    "ru": "скрыто по минусам",
    "en": "hidden after downvotes",
    "de": "nach Daumen-runter verborgen",
    "fr": "masqué après votes négatifs",
    "es": "oculto tras votos negativos",
    "it": "nascosto dopo i voti negativi",
    "ja": "低評価により非表示",
    "zh": "因点踩被隐藏",
}
REVEAL = {
    "ru": "показать",
    "en": "show",
    "de": "zeigen",
    "fr": "afficher",
    "es": "mostrar",
    "it": "mostra",
    "ja": "表示",
    "zh": "显示",
}

# each locale block is delimited by a 2-letter key at two-space indent
FILES = {
    "extension/locales.js": ["ru", "en"],
    "extension/locales_more.js": ["de", "fr", "es", "it", "ja", "zh"],
}

for path, langs in FILES.items():
    lines = open(path, encoding="utf-8").read().split("\n")
    out = []
    li = 0
    for line in lines:
        out.append(line)
        stripped = line.strip()
        if stripped.startswith('"msg.hidden":'):
            lang = langs[li]
            li += 1
            out.append('    "msg.hidden_votes": "%s",' % VOTES[lang])
            out.append('    "msg.reveal": "%s",' % REVEAL[lang])
    assert li == len(langs), (path, li, len(langs))
    open(path, "w", encoding="utf-8", newline="\n").write("\n".join(out))
    print("ok", path, li)
