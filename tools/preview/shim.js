// Dev-only: canned chrome.* shim so chat.html can be opened in a plain browser
// to smoke-test rendering. Not part of the extension package.
(() => {
  const now = Date.now();
  const dev = "d-preview-me";
  /* Стенд повторяет схему v0.3: наружу и в author.id уходит детерминированный публичный
     алиас, а deviceId остаётся при себе. Хэш здесь поддельный (FNV вместо SHA-1) —
     важно не совпадение с store.js, а форма значения. */
  const fnv = (s, salt) => {
    let h = (0x811c9dc5 ^ salt) >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const alias = (seed) => "u" + (fnv(seed, 1) + fnv(seed, 2) + fnv(seed, 7)).slice(0, 24);
  const ME = alias(dev);
  const HIDE_REPORTS = 3;
  const HIDE_DOWNVOTES = 10;
  const hideReason = (m) =>
    m.reports.length >= HIDE_REPORTS ? "reports" : m.down.length >= HIDE_DOWNVOTES ? "votes" : null;
  const mk = (i, text, up, down, stars, lang, extra = {}) => {
    const url = extra.url || "https://example.com/article";
    return {
      id: `m${i}`,
      ch: `${url}#${lang}`,
      url,
      lang,
      ts: extra.ts || now - i * 7 * 60e3,
      author: i === 5 || extra.mine
        ? { id: ME, name: i === 5 ? "Mine" : "", anon: i !== 5, avatar: "", userId: null }
        : { id: alias("neighbour-" + i), name: i % 3 ? "" : "Vasya", anon: !(i % 3), avatar: "", userId: null },
      text,
      links: i === 2 ? [{ href: "https://news.site/top", host: "news.site", title: "news.site" }] : (extra.links || []),
      up: Array.from({ length: up }, (_, k) => alias("up-" + i + "-" + k)),
      down: Array.from({ length: down }, (_, k) => alias("down-" + i + "-" + k)),
      stars: Array.from({ length: stars }, (_, k) => alias("star-" + i + "-" + k)),
      reports: [],
      effect: extra.effect || null,
      quote: extra.quote || "",
      // id родителя: раздел «Ответы» собирает ленту только по этой связи
      replyTo: extra.replyTo || "",
    };
  };

  const messages = [
    mk(1, "Orbita поверх этого сайта? Ну наконец-то. 57", 57, 0, 2, "en"),
    mk(2, "I'm a tooltip!\nOr am I a speech bubble?", 12, 0, 0, "en", { effect: { type: "shield", by: "Vasya", ts: now - 4e5 } }),
    mk(3, "Смотрите ссылку https://news.site/top — там по теме, а bullshit тут ни при чём", 8, 0, 1, "en"),
    mk(4, "Оффтоп флуд, зажал", 0, 15, 0, "en"),
    mk(5, "Важное: в 20:00 разбор темы, приходите", 31, 1, 4, "en", { effect: { type: "flame", variant: "plasma", by: "Kolya", ts: now - 6e5 } }),
    mk(6, "Deutsch hier bitte", 4, 0, 0, "de"),
  ];

  // enough rows for the right drawer to need real scrolling in both tabs
  const CHANS = [
    "https://example.com/article",
    "https://news.site/live",
    "https://forum.example.org/thread/42",
    "https://docs.example.net/guide",
    "https://blog.example.com/roundup",
  ];
  const LANGS = ["en", "de", "ru", "es"];
  for (let i = 0; i < 40; i++) {
    const url = CHANS[i % CHANS.length];
    const lang = LANGS[i % LANGS.length];
    const mine = i % 2 === 0;
    const host = url.replace(/^https?:\/\//, "").split("/")[0];
    messages.push(
      mk(
        100 + i,
        mine
          ? `My note ${i / 2 + 1} on ${host} — ${"text ".repeat(4)}plus a longer tail so the drawer row wraps nicely`
          : `Someone on ${host} wrote a long comment with a link https://link.example/${i + 1}/page about ${lang}`,
        mine ? (i % 3) + 1 : (i % 9) + 1,
        i % 7 === 0 ? 1 : 0,
        0,
        lang,
        {
          url,
          mine,
          ts: now - i * 37 * 60e3,
          links: mine ? [] : [{ href: `https://link.example/${i + 1}/page`, host: "link.example", title: "link" }],
        }
      )
    );
  }

  /* Mirrors: the preview page and its joined mirror share one room, and the merged
     rows carry their own address so the chat can tag the source site. */
  const MIRROR = "https://reactor.example/old";
  for (let i = 0; i < 5; i++) {
    messages.push(
      mk(
        200 + i,
        `Зеркало ответ ${i + 1}: тот же чат, но страница открыта с другого адреса.`,
        (i % 4) + 1,
        0,
        0,
        "en",
        { url: MIRROR, ts: now - i * 26 * 60e3 }
      )
    );
  }
  // extra rows on the preview page itself, so the feed has something to scroll
  for (let i = 0; i < 12; i++) {
    messages.push(mk(300 + i, `Строка чата ${i + 1} — ${"текст ".repeat(8)}хвост`, i % 5, 0, 0, "en", { ts: now - i * 11 * 60e3 }));
  }

  /* Раздел «Ответы»: соседи отвечают на мои реплики в других комнатах. Один ответ спрятан
     за минусами — он не обязан попадать в список, как и в store.answers. */
  const myRows = messages.filter((m) => m.author.id === ME);
  myRows.slice(0, 4).forEach((parent, k) => {
    messages.push(
      mk(400 + k, `Ответ на вашу реплику ${k + 1}: ${"тут по теме ".repeat(4)}и продолжение мысли`, (k % 4) + 1, k === 3 ? 12 : 0, 0, parent.lang, {
        url: parent.url,
        replyTo: parent.id,
        ts: now - (k + 1) * 19 * 60e3,
      })
    );
  });
  /* Живой воркер v0.2 не хранит replyTo и возвращает только текст цитаты, поэтому
     родителя добирают по нему. В стенде — тот же путь: строка без ссылки обязана
     попасть в «Ответы» ровно как в store.answers. */
  const quoted = myRows[0];
  if (quoted) {
    messages.push(
      mk(420, "Ответ, у которого ссылка на родителя потерялась на сервере", 2, 0, 0, quoted.lang, {
        url: quoted.url,
        quote: quoted.text,
        replyTo: "",
        ts: quoted.ts + 60e3,
      })
    );
  }

  const state = {
    sent: [],
    reads: [],
    settings: {
      serverUrl: "", syncOn: true, enabled: true, uiLang: "ru", filter: true,
      opacity: 0.9, mode: "overlay", hiddenDomains: [], showHidden: false,
      sound: { on: true, tone: "chime", volume: 0.6 },
    },
    customSound: "",
    identity: { deviceId: dev, pub: ME, name: "", anon: true, avatar: "", userId: null, sites: {} },
    mirrors: {},
  };

  // те же заряды и запреты, что в store.js, чтобы drag можно было пощупать в превью
  const FX_MAX = { flame: 30, shield: 1 };
  const STAR_MAX = 10;
  const starLedger = {}; // сообщение → когда: снятая звезда возвращает свой заряд
  const starQuota = () => {
    const used = Object.keys(starLedger).length;
    return { used, left: Math.max(0, STAR_MAX - used), windowMs: 864e5 };
  };
  /* Заряды эффектов переживают перезагрузку стенда — как в боевом сторе, где они
     лежат в chrome.storage. kv объявлен ниже, поэтому читаем его лениво. */
  const fxUsed = () => {
    if (!kv["orbita.fx"]) kv["orbita.fx"] = { flame: 0, shield: 0 };
    return kv["orbita.fx"];
  };
  const saveFx = () => {
    try {
      localStorage.setItem("orbita.preview.kv", JSON.stringify(kv));
    } catch {
      /* квота стенда */
    }
  };
  const fxQuota = () => {
    const u = fxUsed();
    return {
      windowMs: 864e5,
      flame: { used: u.flame, left: Math.max(0, FX_MAX.flame - u.flame), max: FX_MAX.flame },
      shield: { used: u.shield, left: Math.max(0, FX_MAX.shield - u.shield), max: FX_MAX.shield },
    };
  };

  const norm = (u) => {
    try {
      const x = new URL(u);
      x.hash = "";
      x.hostname = x.hostname.toLowerCase().replace(/^www\./, "");
      const path = x.pathname === "/" ? "/" : x.pathname.replace(/\/+$/, "");
      return x.origin + path;
    } catch {
      return String(u || "");
    }
  };
  const homeOf = (u) => state.mirrors[norm(u)] || norm(u);
  const groupOf = (u) => {
    const home = homeOf(u);
    const urls = Object.keys(state.mirrors).filter((k) => state.mirrors[k] === home);
    return { home, urls: urls.length ? urls : [home] };
  };
  state.mirrors[norm("https://example.com/article")] = norm("https://example.com/article");
  state.mirrors[norm(MIRROR)] = norm("https://example.com/article");
  // remembered nicknames, one per site
  state.identity.sites["example.com"] = { name: "Крокодил", anon: false };
  state.identity.sites["vk.com"] = { name: "Лобстер", anon: false };

  // chrome.storage survives reloads, so the preview keeps its keys in localStorage
  let kv = {};
  try {
    kv = JSON.parse(localStorage.getItem("orbita.preview.kv") || "{}");
  } catch {
    kv = {};
  }

  const byId = (id) => messages.find((m) => m.id === id);
  /* как store.quoteIndex: ссылка по id важнее, а если сервер её потерял — родителя ищут
     по тексту цитаты в той же комнате, среди своих и более старых сообщений */
  const normText = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 220);
  const parentFor = (m) => {
    if (m.replyTo) return byId(m.replyTo);
    const q = normText(m.quote);
    if (q.length < 4) return undefined;
    return messages.find((p) => p.ch === m.ch && p.author.id === ME && p.ts <= m.ts && normText(p.text) === q);
  };
  const score = (m) => m.up.length - m.down.length;
  const SPANS = { recent: Infinity, day: 864e5, week: 7 * 864e5, month: 30 * 864e5, year: 365 * 864e5, all: Infinity };
  const within = (m, period) => {
    const span = SPANS[period] ?? SPANS.day;
    return span === Infinity || Date.now() - m.ts <= span;
  };
  // та же форма строки, что отдаёт store.lenta / store.myPosts
  const panelRow = (m) => ({
    id: m.id,
    url: m.url,
    lang: m.lang,
    ts: m.ts,
    title: "",
    text: m.text,
    votes: score(m),
    stars: m.stars.length,
    links: m.links.slice(0, 3),
  });

  const hostOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };
  const withSite = (url) => {
    const id = state.identity;
    const site = url && id.sites ? id.sites[hostOf(url)] : null;
    return site ? { ...id, name: site.name || "", anon: site.anon !== false } : { ...id };
  };

  function respond(msg) {
    switch (msg.cmd) {
      case "page:register":
        return { ok: true, hidden: false };
      case "channel:open":
        return { ok: true, clients: 3 };
      case "channel:close":
        return { ok: true };
      case "presence":
        return { ok: true, clients: 3, group: groupOf(msg.url) };
      case "quota:get":
        return { ok: true, quota: starQuota(), fx: fxQuota() };
      case "identity:get":
        return { ok: true, identity: withSite(msg.url) };
      case "identity:set": {
        const host = msg.url ? hostOf(msg.url) : "";
        const siteKey = host && ("name" in msg.patch || "anon" in msg.patch);
        if (siteKey) state.identity.sites[host] = { ...(state.identity.sites[host] || {}), ...msg.patch };
        else Object.assign(state.identity, msg.patch);
        return { ok: true, identity: withSite(msg.url) };
      }
      case "identity:reset_site": {
        const host = hostOf(msg.url) || String(msg.url || "").toLowerCase();
        delete state.identity.sites[host];
        return { ok: true, identity: withSite(msg.url) };
      }
      case "mirror:list":
        return { ok: true, group: groupOf(msg.url) };
      case "mirror:add": {
        const member = norm(msg.url);
        if (!/^https?:\/\//.test(member)) return { error: "bad_url" };
        const home = homeOf(msg.base);
        state.mirrors[home] = home;
        if (member !== home) state.mirrors[member] = home;
        return { ok: true, group: groupOf(home) };
      }
      case "mirror:remove": {
        const member = norm(msg.url);
        const home = homeOf(member);
        if (member === home) {
          Object.keys(state.mirrors).forEach((k) => {
            if (state.mirrors[k] === home) delete state.mirrors[k];
          });
          return { ok: true, group: { home, urls: [home] } };
        }
        delete state.mirrors[member];
        return { ok: true, group: groupOf(home) };
      }
      case "settings:get":
        return { ok: true, settings: state.settings };
      case "settings:set":
        Object.assign(state.settings, msg.patch);
        return { ok: true, settings: state.settings };
      case "sound:get":
        return { ok: true, dataUrl: state.customSound || "" };
      case "sound:set":
        state.customSound = msg.dataUrl || "";
        return { ok: true, bytes: state.customSound.length };
      case "msg:post": {
        const created = mk(messages.length + 1, msg.text, 0, 0, 0, msg.lang, { url: msg.url });
        const id = withSite(msg.url);
        created.author = { id: ME, name: id.anon ? "" : id.name, anon: !!id.anon, avatar: "" };
        created.quote = msg.quote || "";
        created.replyTo = msg.replyTo && byId(msg.replyTo) ? msg.replyTo : "";
        messages.push(created);
        state.sent.push(msg);
        return { message: created };
      }
      case "feed:get": {
        let list = messages.filter(
          (m) => (msg.lang === "*" || m.lang === msg.lang) && homeOf(m.url) === homeOf(msg.url)
        );
        if (msg.view === "important") list = list.filter((m) => m.stars.length);
        if (msg.view === "mine") list = list.filter((m) => m.author.id === ME);
        list = [...list].sort((a, b) =>
          msg.view === "top" ? score(b) - score(a) : a.ts - b.ts
        );
        return {
          ok: true,
          // store.feed возвращает восстановленный replyTo — без него значок «↩ N» в стенде молчал бы
          messages: list.map((m) => {
            const parent = m.replyTo ? byId(m.replyTo) : parentFor(m);
            return { ...m, hidden: hideReason(m), replyTo: parent ? parent.id : m.replyTo || "" };
          }),
        };
      }
      case "lenta:get": {
        const rows = messages
          .filter((m) => !hideReason(m) && score(m) > 0 && within(m, msg.period) && (msg.lang === "*" || m.lang === msg.lang))
          .sort((a, b) => (msg.period === "recent" ? b.ts - a.ts : score(b) - score(a) || b.ts - a.ts))
          .slice(0, 30)
          .map((m) => panelRow(m));
        return { ok: true, rows };
      }
      case "mine:get": {
        const list = messages
          .filter((m) => m.author.id === ME && within(m, msg.period) && (msg.lang === "*" || m.lang === msg.lang))
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 30)
          .map((m) => panelRow(m));
        return { ok: true, rows: list };
      }
      // та же форма строки, что отдаёт store.answers: ответ + короткая реплика родителя
      case "answers:get": {
        const read = new Set(state.reads);
        const list = messages
          .filter((m) => (m.replyTo || m.quote) && !hideReason(m) && m.author.id !== ME && within(m, msg.period))
          .map((m) => ({ m, parent: parentFor(m) }))
          .filter(({ m, parent }) => parent && parent.author.id === ME && (msg.lang === "*" || m.lang === msg.lang))
          .sort((a, b) => b.m.ts - a.m.ts)
          .slice(0, 30)
          .map(({ m, parent }) => ({
            ...panelRow(m),
            name: m.author.name,
            unread: !read.has(m.id),
            parent: { id: parent.id, text: parent.text, ts: parent.ts },
          }));
        return { ok: true, rows: list, unread: list.filter((r) => r.unread).length };
      }
      case "answers:read":
        if (!state.reads.includes(msg.id)) state.reads.unshift(msg.id);
        return { ok: true };
      // стенд не может открыть произвольный сайт — только сообщить, что команда дошла
      case "site:open":
        console.log("shim: site:open", msg.url, msg.lang, msg.msg || "");
        return { ok: true, mode: "site" };
      case "vote": {
        const m = byId(msg.msgId);
        if (!m) return null;
        const field = msg.dir === "up" ? "up" : "down";
        const other = msg.dir === "up" ? "down" : "up";
        const had = m[field].includes(ME);
        m[field] = had ? m[field].filter((x) => x !== ME) : [...m[field], ME];
        m[other] = m[other].filter((x) => x !== ME);
        return { ok: true, score: score(m), myVote: had ? null : msg.dir, withdrawn: had ? { [field]: [ME] } : {} };
      }
      case "star": {
        const m = byId(msg.msgId);
        if (!m) return { error: "not_found" };
        const had = m.stars.includes(ME);
        if (had) {
          m.stars = m.stars.filter((x) => x !== ME);
          delete starLedger[msg.msgId];
        } else {
          if (starQuota().left <= 0) return { error: "quota", quota: starQuota() };
          m.stars = [...m.stars, ME];
          starLedger[msg.msgId] = Date.now();
        }
        return { starred: !had, withdrawn: had ? { stars: [ME] } : {}, quota: starQuota() };
      }
      case "report": {
        const m = byId(msg.msgId);
        if (!m) return null;
        const had = m.reports.includes(ME);
        m.reports = had ? m.reports.filter((x) => x !== ME) : [...m.reports, ME];
        const reason = hideReason(m);
        return { reported: !had, withdrawn: had ? { reports: [ME] } : {}, reports: m.reports.length, hidden: !!reason, reason, down: m.down.length };
      }
      case "effect": {
        const m = byId(msg.msgId);
        if (!m) return { error: "not_found" };
        if (!FX_MAX[msg.type]) return { error: "bad_effect" };
        const quota = fxQuota();
        const prev = m.effect ? (m.effect.type === "dragon" ? "flame" : m.effect.type) : null;
        if (msg.type === "flame" && prev === "flame") return { error: "busy_flame", quota };
        if (msg.type === "flame" && prev === "shield") return { error: "protected", quota };
        if (msg.type === "shield" && prev === "shield") return { error: "busy_shield", quota };
        if (quota[msg.type].left <= 0) return { error: "quota", quota };
        fxUsed()[msg.type] += 1;
        saveFx();
        m.effect = { type: msg.type, ...(msg.type === "flame" ? { variant: msg.variant === "inferno" ? "inferno" : "plasma" } : {}), by: "you", ts: Date.now() };
        return { message: m, quenched: prev === "flame", quota: fxQuota() };
      }
      case "msg:delete": {
        const idx = messages.findIndex((m) => m.id === msg.msgId);
        if (idx < 0) return { error: "not_found" };
        if (messages[idx].author.id !== ME) return { error: "not_mine" };
        messages.splice(idx, 1);
        return { deleted: msg.msgId };
      }
      case "site:hide":
        return { ok: true };
      case "channels:list":
        return {
          ok: true,
          recent: [
            { url: "https://example.com/article", title: "Example article", lang: "en", lastTs: now },
            { url: "https://vk.com/feed", title: "vk.com", lang: "ru", lastTs: now - 4e5 },
            { url: "https://reactor.example/old", title: "", lang: "ru", lastTs: now - 9e5 },
          ],
        };
      case "stats":
        return { ok: true, stats: { channels: [{ url: "x", title: "x", lang: "en", count: 6, updatedAt: now }], messages: 6 } };
      case "sync:now":
        return { mode: "local" };
      case "data:clear":
        return { ok: true };
      default:
        console.warn("shim: unhandled cmd", msg.cmd);
        return { ok: true };
    }
  }

  const listeners = [];

  window.chrome = {
    runtime: {
      id: "preview",
      // absolute URLs, so the real content.js overlay can run inside the preview
      getURL: (p) => new URL(String(p || "").replace(/^\//, ""), location.origin + "/").href,
      getManifest: () => ({ version: "dev" }),
      sendMessage: async (msg) => respond(msg),
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          const out = {};
          list.forEach((k) => (out[k] = kv[k]));
          if (cb) setTimeout(() => cb(out), 0);
          return Promise.resolve(out);
        },
        set: (obj, cb) => {
          Object.assign(kv, obj);
          try {
            localStorage.setItem("orbita.preview.kv", JSON.stringify(kv));
          } catch {
            /* preview quota */
          }
          if (cb) setTimeout(() => cb(), 0);
          return Promise.resolve(true);
        },
      },
    },
    tabs: {
      // the settings page opens the channel chat in a tab; in preview, a plain window
      create: (opts) => {
        window.open(opts.url, "_blank");
        return Promise.resolve({ id: 1 });
      },
    },
    identity: { getAuthToken: async () => { throw new Error("preview build: google auth is not wired"); } },
  };
  window.__orbitaPreview = state;
  /* Дев-инструмент стенда: чужое сообщение в текущую комнату + событие, как из
     background. Без него оповещения и «прилетело сверху» в превью не проверить —
     свой пост чат молчит по замыслу. */
  window.__orbitaInject = (text, lang, replyTo) => {
    // в iframe адрес комнаты лежит в ?url=, на странице-хосте комната = сама страница
    const room = new URL(location.href).searchParams.get("url") || location.href;
    const m = mk(700 + messages.length, text || "Сосед написал прямо сейчас", 0, 0, 0, lang || "en", {
      url: room,
      ts: Date.now(),
      replyTo: replyTo || "",
    });
    m.author = { id: alias("neighbour-live"), name: "Сосед", anon: false, avatar: "", userId: null };
    messages.push(m);
    window.__orbitaSync();
    return m.id;
  };
  /* Дев-инструмент нагрузки: зажечь n сообщений текущей комнаты одним стилем.
     Нужен, чтобы проверить 30 огней и FPS, не перетаскивая карточку тридцать раз. */
  window.__orbitaFlood = (n = 30, variant = "plasma") => {
    const room = new URL(location.href).searchParams.get("url") || location.href;
    const lang = new URL(location.href).searchParams.get("lang") || "en";
    for (let i = 0; i < n; i += 1) {
      const m = mk(3000 + messages.length, `Burn test ${i + 1} — проверка нагрузки`, 0, 0, 0, lang, {
        url: room,
        ts: Date.now(),
        effect: { type: "flame", variant: variant === "inferno" ? "inferno" : "plasma", by: "Test", ts: Date.now() },
      });
      m.author = { id: alias(`burn-${i}`), name: "Burn", anon: false, avatar: "", userId: null };
      messages.push(m);
    }
    window.__orbitaSync();
    return n;
  };
  /* событие «прилетел sync» без нового сообщения: на нём проверяют, что чат не пересобирает
     ленту, когда данные не изменились */
  window.__orbitaSync = () =>
    listeners.forEach((fn) => fn({ type: "orbita:event", event: "sync", payload: {} }, {}, () => {}));
  // let the preview host page drive the content script the way chrome would
  window.__orbitaHostSend = (msg) =>
    new Promise((resolve) => listeners.forEach((fn) => fn(msg, {}, resolve)));
})();
