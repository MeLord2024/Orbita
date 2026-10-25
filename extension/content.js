(() => {
  if (window.__orbitaLoaded) return;
  window.__orbitaLoaded = true;

  const EXT_ORIGIN = new URL(chrome.runtime.getURL("/")).origin;
  const GEOM_KEY = "orbita.geom";
  const DEFAULT_GEOM = { w: 1180, h: 680, x: null, y: null, opacity: 1 };

  let host = null;
  let shadow = null;
  let frame = null;
  let ready = false;
  let readyResolve = null;
  // порядковый номер сборки: пока show() ждёт геометрию, может прийти следующий клик
  let buildSeq = 0;
  const watchdogs = [];
  // every site keeps its own window: { default, sites: { "vk.com": {x,y,w,h,opacity} } }
  let geomStore = { default: { ...DEFAULT_GEOM }, sites: {} };
  let siteKey = "";
  let geom = { ...DEFAULT_GEOM };
  let open = false;
  let dragFromFrame = null;
  let panels = null;
  let channel = null;
  // floor for geom.w: the chat column always keeps MIN_CHAT px, the drawers add their own width
  const MIN_CHAT = 420;
  let minW = MIN_CHAT;

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }

  function clampGeom() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    geom.w = Math.max(minW, Math.min(geom.w, vw - 16));
    geom.h = Math.max(360, Math.min(geom.h, vh - 16));
    geom.x = geom.x == null ? Math.max(8, (vw - geom.w) / 2) : Math.min(Math.max(8, geom.x), Math.max(8, vw - geom.w - 8));
    geom.y = geom.y == null ? Math.max(8, (vh - geom.h) / 2) : Math.min(Math.max(8, geom.y), Math.max(8, vh - geom.h - 8));
  }

  function build(url, title, lang, msg) {
    host = document.createElement("div");
    host.id = "orbita-host";
    const style = host.style;
    style.position = "fixed";
    style.inset = "0";
    style.zIndex = "2147483647";
    style.pointerEvents = "none";
    style.background = "transparent";
    shadow = host.attachShadow({ mode: "open" });

    const css = document.createElement("style");
    css.textContent = `
      .panel{position:fixed;pointer-events:auto;display:flex;flex-direction:column;
        border-radius:16px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.5);
        border:1px solid rgba(255,255,255,.28);background:transparent}
      iframe{flex:1;width:100%;border:0;background:transparent}
      .grip{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;pointer-events:auto;
        background:linear-gradient(135deg,transparent 45%,rgba(255,255,255,.35) 46%,rgba(255,255,255,.35) 54%,transparent 55%)}
    `;
    shadow.appendChild(css);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.dataset.role = "panel";

    frame = document.createElement("iframe");
    frame.setAttribute("allowtransparency", "true");
    frame.src = `${chrome.runtime.getURL("chat.html")}?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}&lang=${encodeURIComponent(lang || "en")}&vw=${Math.round(window.innerWidth)}${msg ? `&msg=${encodeURIComponent(msg)}` : ""}`;
    // Sites with frame-ancestors CSP silently refuse the frame: fall back to a standalone tab.
    const watchdog = setTimeout(() => {
      if (!ready) {
        host.remove();
        host = null;
        shadow = null;
        frame = null;
        open = false;
        chrome.runtime.sendMessage({ cmd: "overlay:fallback", url, title, lang, msg }).catch(() => {});
      }
    }, 3000);
    watchdogs.push(readyResolve = () => clearTimeout(watchdog));

    const grip = document.createElement("div");
    grip.className = "grip";

    panel.append(frame, grip);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);

    let resize = null;
    grip.addEventListener("pointerdown", (ev) => {
      resize = { x: ev.clientX, y: ev.clientY, w: geom.w, h: geom.h };
      grip.setPointerCapture(ev.pointerId);
    });
    grip.addEventListener("pointermove", (ev) => {
      if (!resize) return;
      geom.w = resize.w + (ev.clientX - resize.x);
      geom.h = resize.h + (ev.clientY - resize.y);
      clampGeom();
      place();
    });
    grip.addEventListener("pointerup", () => {
      resize = null;
      saveGeom();
    });

    paintOpacity(geom.opacity);
    place(panel);
  }

  function place(panel) {
    if (!panel) panel = shadow && shadow.querySelector("[data-role=panel]");
    if (!panel) return;
    panel.style.left = `${geom.x}px`;
    panel.style.top = `${geom.y}px`;
    panel.style.width = `${geom.w}px`;
    panel.style.height = `${geom.h}px`;
  }

  /* Непрозрачное окно не должно стоить ничего: значение меньше единицы превращает панель
     в отдельный альфа-слой поверх сайта, и каждый кадр страницы композитор заново смешивает
     все 1180×680 пикселей. При 1 свойство снимаем совсем. */
  function paintOpacity(value) {
    const panel = shadow && shadow.querySelector("[data-role=panel]");
    if (!panel) return;
    if (value >= 1) panel.style.removeProperty("opacity");
    else panel.style.opacity = String(value);
  }

  function saveGeom() {
    if (!siteKey) return;
    geomStore.sites[siteKey] = { x: geom.x, y: geom.y, w: geom.w, h: geom.h, opacity: geom.opacity };
    try {
      chrome.storage.local.set({ [GEOM_KEY]: geomStore });
    } catch {
      /* storage unavailable */
    }
  }

  // the chat inside the frame cannot see the real screen: it only knows its own width
  function postViewport() {
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage(
        { source: "orbita-host", action: "viewport", vw: Math.round(window.innerWidth) },
        EXT_ORIGIN
      );
    } catch {
      /* frame gone */
    }
  }

  function loadGeomMap() {
    return new Promise((resolve) => {
      const fallback = { default: { ...DEFAULT_GEOM }, sites: {} };
      try {
        chrome.storage.local.get(GEOM_KEY, (got) => {
          const raw = got && got[GEOM_KEY];
          if (!raw || typeof raw !== "object") return resolve(fallback);
          // up to v0.1.5 one flat window served every site — becomes the default
          if (typeof raw.w === "number") return resolve({ default: { ...DEFAULT_GEOM, ...raw }, sites: {} });
          resolve({ default: { ...DEFAULT_GEOM, ...(raw.default || {}) }, sites: raw.sites || {} });
        });
      } catch {
        resolve(fallback);
      }
    });
  }

  function close() {
    ready = false;
    if (!host) return;
    if (frame && frame.contentWindow) {
      try {
        frame.contentWindow.postMessage({ source: "orbita-host", action: "closing" }, EXT_ORIGIN);
      } catch {
        /* frame gone */
      }
    }
    host.remove();
    host = null;
    shadow = null;
    frame = null;
    open = false;
    panels = null;
    channel = null;
    dragFromFrame = null;
    chrome.runtime.sendMessage({ cmd: "channel:close" }).catch(() => {});
  }

  async function show(url, title, lang, msg) {
    /* На вкладке обязан быть ровно один оверлей. close() чистит host синхронно, но до
       сборки ещё ждём геометрию — и за это время успевает прийти следующий клик, который
       тоже увидит host === null. buildSeq обрывает такого опоздавшего: окно соберёт
       только последний вызов, иначе второй host лег бы поверх первого, а host/frame/channel
       указывали бы на новый — у старого не работают ✕, ⛓ и перетаскивание. */
    const seq = ++buildSeq;
    if (host) close();
    geomStore = await loadGeomMap();
    if (seq !== buildSeq) return;
    siteKey = hostOf(url);
    geom = { ...geomStore.default, ...(geomStore.sites[siteKey] || {}) };
    clampGeom();
    channel = { url, lang };
    build(url, title || url, lang, msg);
    open = true;
  }

  /* Коммент ищут в уже открытом окне: адрес тот же, значит хватает прокрутки.
     Сверка та же, что и в normalizeUrl: без `www.`, без хвостового слэша, query и якоря
     не в счёт — иначе лента с `google.com` против вкладки `www.google.com` считалась
     другой страницей и окно пересобиралось. */
  function samePage(a, b) {
    try {
      const key = (u) => {
        const x = new URL(u);
        const host = x.hostname.toLowerCase().replace(/^www\./, "");
        const path = x.pathname.length > 1 ? x.pathname.replace(/\/+$/, "") : "/";
        return `${x.protocol}//${host}${x.port}${path}`;
      };
      return key(a) === key(b);
    } catch {
      return a === b;
    }
  }

  function postGoto(msgId) {
    if (!frame || !frame.contentWindow) return;
    try {
      frame.contentWindow.postMessage({ source: "orbita-host", action: "goto", msg: msgId }, EXT_ORIGIN);
    } catch {
      /* frame gone */
    }
  }

  addEventListener("message", (ev) => {
    if (ev.origin !== EXT_ORIGIN || !ev.data || ev.data.source !== "orbita-chat") return;
    const { action } = ev.data;
    if (action === "ready") {
      ready = true;
      const done = watchdogs.pop();
      if (done) done();
      postViewport();
    }
    if (action === "close") close();
    if (action === "opacity") {
      geom.opacity = Math.max(0.4, Math.min(1, Number(ev.data.value) || 1));
      paintOpacity(geom.opacity);
      saveGeom();
    }
    if (action === "drag") {
      if (ev.data.phase === "start") {
        dragFromFrame = { gx: ev.data.sx - geom.x, gy: ev.data.sy - geom.y };
      } else if (ev.data.phase === "move" && dragFromFrame) {
        geom.x = ev.data.sx - dragFromFrame.gx;
        geom.y = ev.data.sy - dragFromFrame.gy;
        clampGeom();
        place();
      } else if (ev.data.phase === "end") {
        dragFromFrame = null;
        saveGeom();
      }
    }
    if (action === "panels") {
      const fx = Math.max(0, Number(ev.data.fx) || 0);
      const lenta = Math.max(0, Number(ev.data.lenta) || 0);
      // after a viewport resize the chat column reflows on its own: only re-baseline
      if (ev.data.rebind) {
        panels = { fx, lenta };
        minW = MIN_CHAT + fx + lenta;
        return;
      }
      if (ev.data.init || !panels) {
        panels = { fx, lenta };
        minW = MIN_CHAT + fx + lenta;
        // a window saved while the drawers were closed must not squeeze the chat now
        const needed = minW;
        if (geom.w < needed) {
          geom.x = Math.max(8, geom.x - (needed - geom.w) / 2);
          geom.w = needed;
        }
        clampGeom();
        place();
        saveGeom();
        return;
      }
      const chatX = geom.x + panels.fx;
      const chatW = geom.w - panels.fx - panels.lenta;
      geom.x = chatX - fx;
      geom.w = chatW + fx + lenta;
      panels = { fx, lenta };
      minW = MIN_CHAT + fx + lenta;
      clampGeom();
      place();
      saveGeom();
    }
  });

  addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && open) {
      close();
      ev.stopPropagation();
    }
  }, true);

  addEventListener("resize", () => {
    if (!open) return;
    clampGeom();
    place();
    postViewport();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "overlay:ping") {
      sendResponse({ ok: true, open });
      return;
    }
    if (msg.type === "overlay:open") {
      const url = msg.url || location.href;
      const lang = msg.lang || (navigator.language || "en").split("-")[0].toLowerCase();
      const same = open && channel && samePage(channel.url, url);
      // то же окно и та же комната — осталось only докрутить до коммента
      if (same) {
        if (channel.lang === lang) {
          if (msg.msg) postGoto(msg.msg);
          sendResponse({ ok: true, open: true });
          return;
        }
        close();
      }
      show(url, document.title, lang, msg.msg || "");
      sendResponse({ ok: true, open: true });
      return;
    }
    if (msg.type === "overlay:toggle") {
      const url = msg.url || location.href;
      const title = msg.title || document.title;
      if (open) {
        close();
        sendResponse({ ok: true, open: false });
        return;
      }
      chrome.runtime
        .sendMessage({ cmd: "page:register", url, title })
        .then((res) => {
          if (res && res.hidden) {
            sendResponse({ ok: true, open: false, blocked: true });
            return;
          }
          const lang = (navigator.language || "en").split("-")[0].toLowerCase();
          show(url, title, lang);
          sendResponse({ ok: true, open: true });
        })
        .catch(() => {
          show(url, title, (navigator.language || "en").split("-")[0].toLowerCase());
          sendResponse({ ok: true, open: true });
        });
      return true;
    }
  });

  chrome.runtime.sendMessage({ cmd: "page:register", url: location.href, title: document.title }).catch(() => {});
})();
