#!/usr/bin/env python3
# Вставляет ключи раздела «Звук» в каждый из 8 словарей интерфейса.
import io, re, sys

SOUND = {
    "ru": [
        ("sound.title", "Звук"),
        ("sound.on", "Оповещать о новых сообщениях"),
        ("sound.drop", "капля"),
        ("sound.chime", "перезвон"),
        ("sound.pulse", "импульс"),
        ("sound.volume", "Громкость"),
        ("sound.test", "Проверить звук"),
        ("sound.file", "Свой звук (mp3)"),
        ("sound.clear", "убрать свой звук"),
        ("sound.custom_hint", "Можно загрузить свой mp3 — он заменит готовый сигнал."),
        ("sound.custom_on", "Сейчас играет ваш файл. Выбор готового сигнала вернёт его."),
        ("sound.loaded", "Звук загружен"),
        ("sound.cleared", "Свой звук убран"),
        ("sound.bad", "Не удалось прочитать файл"),
        ("sound.too_big", "Файл больше 3 МБ"),
    ],
    "en": [
        ("sound.title", "Sound"),
        ("sound.on", "Alert about new messages"),
        ("sound.drop", "drop"),
        ("sound.chime", "chime"),
        ("sound.pulse", "pulse"),
        ("sound.volume", "Volume"),
        ("sound.test", "Test the sound"),
        ("sound.file", "Own sound (mp3)"),
        ("sound.clear", "remove own sound"),
        ("sound.custom_hint", "You can upload your own mp3 — it replaces the built-in signal."),
        ("sound.custom_on", "Your file is playing now. Picking a built-in signal brings it back."),
        ("sound.loaded", "Sound loaded"),
        ("sound.cleared", "Own sound removed"),
        ("sound.bad", "Could not read the file"),
        ("sound.too_big", "The file is larger than 3 MB"),
    ],
    "de": [
        ("sound.title", "Ton"),
        ("sound.on", "Bei neuen Nachrichten warnen"),
        ("sound.drop", "Tropfen"),
        ("sound.chime", "Klingel"),
        ("sound.pulse", "Impuls"),
        ("sound.volume", "Lautstärke"),
        ("sound.test", "Ton testen"),
        ("sound.file", "Eigener Ton (mp3)"),
        ("sound.clear", "eigenen Ton entfernen"),
        ("sound.custom_hint", "Eigene mp3-Datei hochladen — sie ersetzt den fertigen Ton."),
        ("sound.custom_on", "Gerade läuft deine Datei. Ein fertiger Ton stellt sie zurück."),
        ("sound.loaded", "Ton geladen"),
        ("sound.cleared", "Eigener Ton entfernt"),
        ("sound.bad", "Datei konnte nicht gelesen werden"),
        ("sound.too_big", "Die Datei ist größer als 3 MB"),
    ],
    "fr": [
        ("sound.title", "Son"),
        ("sound.on", "Alerte aux nouveaux messages"),
        ("sound.drop", "goutte"),
        ("sound.chime", "carillon"),
        ("sound.pulse", "impulsion"),
        ("sound.volume", "Volume"),
        ("sound.test", "Tester le son"),
        ("sound.file", "Son perso (mp3)"),
        ("sound.clear", "retirer le son perso"),
        ("sound.custom_hint", "Téléversez votre mp3 : il remplace le signal prêt."),
        ("sound.custom_on", "C'est votre fichier qui joue. Un signal prêt fait revenir l'ancien."),
        ("sound.loaded", "Son chargé"),
        ("sound.cleared", "Son perso retiré"),
        ("sound.bad", "Impossible de lire le fichier"),
        ("sound.too_big", "Le fichier dépasse 3 Mo"),
    ],
    "es": [
        ("sound.title", "Sonido"),
        ("sound.on", "Avisar de mensajes nuevos"),
        ("sound.drop", "gota"),
        ("sound.chime", "carrillón"),
        ("sound.pulse", "impulso"),
        ("sound.volume", "Volumen"),
        ("sound.test", "Probar el sonido"),
        ("sound.file", "Sonido propio (mp3)"),
        ("sound.clear", "quitar el sonido propio"),
        ("sound.custom_hint", "Puedes subir tu mp3: sustituye a la señal lista."),
        ("sound.custom_on", "Suena tu archivo ahora. Elegir una señal lista lo devuelve."),
        ("sound.loaded", "Sonido cargado"),
        ("sound.cleared", "Sonido propio quitado"),
        ("sound.bad", "No se pudo leer el archivo"),
        ("sound.too_big", "El archivo supera 3 MB"),
    ],
    "it": [
        ("sound.title", "Suono"),
        ("sound.on", "Avvisa dei nuovi messaggi"),
        ("sound.drop", "goccia"),
        ("sound.chime", "carillon"),
        ("sound.pulse", "impulso"),
        ("sound.volume", "Volume"),
        ("sound.test", "Prova il suono"),
        ("sound.file", "Suono proprio (mp3)"),
        ("sound.clear", "rimuovi il suono proprio"),
        ("sound.custom_hint", "Puoi caricare il tuo mp3: sostituisce il segnale pronto."),
        ("sound.custom_on", "Ora riproduce il tuo file. Un segnale pronto lo riporta indietro."),
        ("sound.loaded", "Suono caricato"),
        ("sound.cleared", "Suono proprio rimosso"),
        ("sound.bad", "Impossibile leggere il file"),
        ("sound.too_big", "Il file supera 3 MB"),
    ],
    "ja": [
        ("sound.title", "サウンド"),
        ("sound.on", "新着メッセージを通知する"),
        ("sound.drop", "しずく"),
        ("sound.chime", "チャイム"),
        ("sound.pulse", "パルス"),
        ("sound.volume", "音量"),
        ("sound.test", "音を試す"),
        ("sound.file", "自分の音 (mp3)"),
        ("sound.clear", "自分の音を削除"),
        ("sound.custom_hint", "独自の mp3 を読み込むと既定の音を置き換えます。"),
        ("sound.custom_on", "いまはあなたのファイルを再生中。既定の音を選ぶと戻ります。"),
        ("sound.loaded", "サウンドを読み込みました"),
        ("sound.cleared", "自分の音を削除しました"),
        ("sound.bad", "ファイルを読み込めません"),
        ("sound.too_big", "ファイルが 3MB を超えています"),
    ],
    "zh": [
        ("sound.title", "提示音"),
        ("sound.on", "新消息提醒"),
        ("sound.drop", "水滴"),
        ("sound.chime", "门铃"),
        ("sound.pulse", "脉冲"),
        ("sound.volume", "音量"),
        ("sound.test", "试听提示音"),
        ("sound.file", "自己的声音 (mp3)"),
        ("sound.clear", "清除自己的声音"),
        ("sound.custom_hint", "可上传你自己的 mp3，它会取代内置提示音。"),
        ("sound.custom_on", "现在播放的是你的文件；选内置提示音即可切回。"),
        ("sound.loaded", "声音已加载"),
        ("sound.cleared", "已清除自己的声音"),
        ("sound.bad", "无法读取该文件"),
        ("sound.too_big", "文件超过 3 MB"),
    ],
}

ANCHOR = '"theme.opacity":'
LANG_RE = re.compile(r"^  ([a-z]{2}): \{")


def patch(path):
    with io.open(path, encoding="utf-8") as f:
        text = f.read()
    if '"sound.title"' in text:
        print("%s: already patched" % path)
        return
    lines = text.split("\n")
    out, lang, added = [], None, 0
    for line in lines:
        m = LANG_RE.match(line)
        if m:
            lang = m.group(1)
        out.append(line)
        if lang and line.strip().startswith(ANCHOR):
            indent = line[: len(line) - len(line.lstrip())]
            for key, value in SOUND[lang]:
                out.append('%s"%s": "%s",' % (indent, key, value.replace('"', '\\"')))
            added += len(SOUND[lang])
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(out))
    print("%s: +%d keys" % (path, added))


patch("extension/locales.js")
patch("extension/locales_more.js")
