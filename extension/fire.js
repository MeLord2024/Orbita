/* Огонь на canvas: один слой на всю ленту, два стиля.
   Плазма — мягкие языки, искры и холодный ореол; инферно — покадровые
   «флэш»-языки с тёмным контуром и угольками. Геометрия сообщений читается
   только когда лента/окно изменились, поэтому прокрутка не вызывает reflow
   в каждом кадре. */

const TAU = Math.PI * 2;
const REDUCED =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function noise(seed, i) {
  const x = Math.sin(seed * 0.00011 + i * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function makeCanvas(w, h = w) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function radialSprite(size, stops) {
  const c = makeCanvas(size);
  const g = c.getContext("2d");
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, color] of stops) grd.addColorStop(at, color);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

export function createFireLayer(canvas, feed) {
  if (!canvas || !feed) return { sync() {}, ignite() {} };
  const ctx = canvas.getContext("2d");
  const chat = canvas.parentElement;
  const plasmaSheet = new Image();
  plasmaSheet.src = "icons/fire-plasma.png";
  const infernoSheet = new Image();
  infernoSheet.src = "icons/fire-inferno.png";
  const PLASMA_CELL = { w: 128, h: 320 };
  const INFERNO_CELL = { w: 128, h: 256 };
  const sheetReady = (img) => img.complete && img.naturalWidth > 0;
  const glowCool = radialSprite(96, [
    [0, "rgba(255,255,255,.95)"],
    [0.24, "rgba(150,250,255,.72)"],
    [0.55, "rgba(40,185,255,.32)"],
    [1, "rgba(0,60,200,0)"],
  ]);
  const glowWarm = radialSprite(96, [
    [0, "rgba(255,255,220,.95)"],
    [0.24, "rgba(255,210,90,.72)"],
    [0.55, "rgba(255,110,20,.34)"],
    [1, "rgba(190,25,0,0)"],
  ]);
  const sparkCool = radialSprite(18, [
    [0, "rgba(255,255,255,1)"],
    [0.35, "rgba(170,250,255,.95)"],
    [1, "rgba(30,160,255,0)"],
  ]);
  const sparkWarm = radialSprite(18, [
    [0, "rgba(255,255,220,1)"],
    [0.35, "rgba(255,200,70,.95)"],
    [1, "rgba(255,80,0,0)"],
  ]);
  const smoke = radialSprite(64, [
    [0, "rgba(70,55,58,.3)"],
    [0.55, "rgba(50,40,45,.16)"],
    [1, "rgba(30,25,30,0)"],
  ]);

  let active = new Map();
  const bursts = new Map();
  let running = false;
  let raf = 0;
  let last = 0;
  let dirty = true;
  let view = { w: 1, h: 1, dpr: 1 };

  function layout() {
    if (!chat || !feed.isConnected) return;
    const fr = feed.getBoundingClientRect();
    const cr = chat.getBoundingClientRect();
    const w = Math.max(1, feed.clientWidth);
    const h = Math.max(1, feed.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.style.left = `${fr.left - cr.left}px`;
    canvas.style.top = `${fr.top - cr.top}px`;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    view = { w, h, dpr };
    dirty = true;
  }

  function sync() {
    const next = new Map();
    for (const row of feed.querySelectorAll(".msg.fx-flame")) {
      const id = row.dataset.id;
      if (!id) continue;
      let rec = active.get(id);
      if (!rec) {
        rec = {
          id,
          seed: hashSeed(id),
          reignited: false,
        };
      }
      rec.row = row;
      rec.variant = row.dataset.fire === "inferno" ? "inferno" : "plasma";
      rec.bubbleEl = row.querySelector(".bubble");
      rec.avaEl = row.querySelector(".ava");
      attachBubbleCanvas(rec);
      next.set(id, rec);
    }
    for (const [id, rec] of active) {
      if (!next.has(id) && rec.bubbleCanvas) rec.bubbleCanvas.remove();
    }
    active = next;
    dirty = true;
    if (!active.size) {
      stop();
      return;
    }
    if (!running) start();
  }

  function start() {
    if (running) return;
    canvas.classList.add("on");
    layout();
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (running) cancelAnimationFrame(raf);
    running = false;
    raf = 0;
    bursts.clear();
    canvas.classList.remove("on");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function attachBubbleCanvas(rec) {
    const bubble = rec.bubbleEl;
    if (!bubble) return;
    let c = null;
    for (const child of bubble.children) {
      if (child.classList && child.classList.contains("fx-bubble-fire")) {
        c = child;
        break;
      }
    }
    if (!c) {
      c = document.createElement("canvas");
      c.className = "fx-bubble-fire";
      c.setAttribute("aria-hidden", "true");
      bubble.insertBefore(c, bubble.firstChild);
    }
    rec.bubbleCanvas = c;
    rec.bctx = c.getContext("2d");
  }

  function sizeBubbleCanvas(rec) {
    if (!rec.bubbleCanvas || !rec.bubbleEl || !rec.bctx) return;
    const w = Math.max(1, rec.bubbleEl.clientWidth);
    const h = Math.max(1, rec.bubbleEl.clientHeight);
    const dpr = view.dpr || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (rec.bubbleCanvas.width !== pw || rec.bubbleCanvas.height !== ph) {
      rec.bubbleCanvas.width = pw;
      rec.bubbleCanvas.height = ph;
    }
    rec.bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rec.bw = w;
    rec.bh = h;
    rec.brad = Math.max(0, (rec.geom && rec.geom.bubble.r ? rec.geom.bubble.r : 18) - 2);
  }

  function measure() {
    const fr = feed.getBoundingClientRect();
    for (const rec of active.values()) {
      rec.geom = null;
      if (!rec.row || !rec.row.isConnected || !rec.bubbleEl) continue;
      const rr = rec.row.getBoundingClientRect();
      if (rr.bottom < fr.top - 140 || rr.top > fr.bottom + 140) continue;
      const br = rec.bubbleEl.getBoundingClientRect();
      const ar = rec.avaEl ? rec.avaEl.getBoundingClientRect() : null;
      if (br.width < 4 || br.height < 4) continue;
      const radius =
        parseFloat(getComputedStyle(rec.bubbleEl).borderTopLeftRadius) ||
        Math.min(22, br.height / 2);
      rec.geom = {
        bubble: { x: br.left - fr.left, y: br.top - fr.top, w: br.width, h: br.height, r: radius },
        ava: ar ? { x: ar.left - fr.left, y: ar.top - fr.top, w: ar.width, h: ar.height } : null,
      };
      sizeBubbleCanvas(rec);
    }
    dirty = false;
  }

  function roundRectPath(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.lineTo(x + w - rr, y);
    g.quadraticCurveTo(x + w, y, x + w, y + rr);
    g.lineTo(x + w, y + h - rr);
    g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    g.lineTo(x + rr, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - rr);
    g.lineTo(x, y + rr);
    g.quadraticCurveTo(x, y, x + rr, y);
    g.closePath();
  }

  function rim(rec, t) {
    const b = rec.geom.bubble;
    const plasma = rec.variant !== "inferno";
    const a = 0.5 + 0.5 * Math.sin(t * 4.2 + rec.seed * 0.0001);
    ctx.save();
    roundRectPath(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 2, b.r - 1);
    ctx.globalCompositeOperation = "lighter";
    if (plasma) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = `rgba(55,195,255,${0.1 + a * 0.06})`;
      ctx.stroke();
      ctx.lineWidth = 1.7;
      ctx.strokeStyle = `rgba(160,250,255,${0.38 + a * 0.16})`;
      ctx.stroke();
    } else {
      ctx.lineWidth = 8;
      ctx.strokeStyle = `rgba(255,100,10,${0.11 + a * 0.07})`;
      ctx.stroke();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = `rgba(255,155,35,${0.42 + a * 0.2})`;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Мягкие «клубы» пламени: объём и движение вокруг языков из листов. */
  function firePuffs(rec, t, plasma) {
    const b = rec.geom.bubble;
    const n = REDUCED ? 8 : plasma ? 26 : 18;
    const speed = plasma ? 0.62 : 0.42;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < n; i += 1) {
      const n1 = noise(rec.seed, i + 700);
      const n2 = noise(rec.seed, i + 740);
      const n3 = noise(rec.seed, i + 780);
      const n4 = noise(rec.seed, i + 820);
      const life = (t * speed + n1) % 1;
      const x = b.x + b.w * (0.04 + 0.92 * n2) + Math.sin(life * TAU * 1.2 + n3 * TAU) * (2 + life * 8);
      const rise = (plasma ? 58 : 48) * (0.62 + n4 * 0.55);
      const y = b.y + 1 - life * rise - 2;
      const size = (plasma ? 7 + 11 * n4 : 9 + 14 * n4) * (1 - life * 0.4);
      ctx.globalAlpha = Math.sin(Math.PI * life) * (plasma ? 0.34 : 0.42);
      const sprite = plasma && n3 < 0.7 ? glowCool : glowWarm;
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function smoothTongues(rec, t) {
    const b = rec.geom.bubble;
    const baseY = b.y + 5;
    firePuffs(rec, t, true);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    if (sheetReady(plasmaSheet)) {
      /* два слоя: мелкие языки в промежутках и крупные поверх — огонь
         перестаёт быть ровным забором из одинаковых полос */
      const small = REDUCED ? 2 : 5;
      for (let i = 0; i < small; i += 1) {
        const n = noise(rec.seed, i + 40);
        const p = (i + 0.5) / small + (n - 0.5) * 0.08;
        const frame = (Math.floor(t * 7.5) + i * 3 + (rec.seed % 6)) % 6;
        const w = 21 + 9 * n;
        const h = w * 2.5 * (0.78 + 0.2 * Math.sin(t * 4.1 + i));
        ctx.globalAlpha = 0.5 + 0.2 * n;
        ctx.save();
        ctx.translate(b.x + b.w * p + Math.sin(t * 2.1 + i) * 4, baseY);
        ctx.rotate((n - 0.5) * 0.25);
        ctx.drawImage(plasmaSheet, frame * PLASMA_CELL.w, 0, PLASMA_CELL.w, PLASMA_CELL.h, -w / 2, -h, w, h);
        ctx.restore();
      }
      const n = REDUCED ? 3 : 6;
      for (let i = 0; i < n; i += 1) {
        const p = n === 1 ? 0.5 : i / (n - 1);
        const ph = rec.seed * 0.0001 + i * 1.63;
        const pulse = 0.7 + 0.3 * Math.sin(t * 6.2 + ph * 3.1);
        const nw = noise(rec.seed, i + 90);
        const sway = Math.sin(t * 2.3 + ph) * 7;
        const w = (38 + 12 * nw) * (1 + 0.12 * Math.sin(t * 3.6 + ph * 2.1));
        const h = w * 2.5 * (0.9 + 0.18 * Math.sin(t * 2.9 + ph));
        const frame = (Math.floor(t * 9) + i * 2 + (rec.seed % 6)) % 6;
        const x = b.x + b.w * (0.05 + 0.9 * p) + sway;
        const ang = (p - 0.5) * 0.16 + Math.sin(t * 2 + ph) * 0.05;
        ctx.globalAlpha = 0.78 + 0.18 * pulse;
        ctx.save();
        ctx.translate(x, baseY);
        ctx.rotate(ang);
        ctx.drawImage(plasmaSheet, frame * PLASMA_CELL.w, 0, PLASMA_CELL.w, PLASMA_CELL.h, -w / 2, -h, w, h);
        ctx.restore();
      }
      for (const side of [-1, 1]) {
        const x = side < 0 ? b.x + 7 : b.x + b.w - 7;
        const w = 30;
        const h = 78 + 8 * Math.sin(t * 3.4 + side);
        const frame = (Math.floor(t * 8) + (side < 0 ? 1 : 4) + (rec.seed % 6)) % 6;
        ctx.globalAlpha = 0.62;
        ctx.save();
        ctx.translate(x, b.y + 24);
        ctx.rotate(side * -0.55 + Math.sin(t * 2.4 + side) * 0.08);
        ctx.drawImage(plasmaSheet, frame * PLASMA_CELL.w, 0, PLASMA_CELL.w, PLASMA_CELL.h, -w / 2, -h, w, h);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    if (!rec.geom.ava) return;
    const a = rec.geom.ava;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.38 + 0.14 * Math.sin(t * 5 + rec.seed);
    ctx.drawImage(glowCool, a.x - a.w * 0.32, a.y - a.h * 0.32, a.w * 1.64, a.h * 1.64);
    ctx.globalCompositeOperation = "source-over";
    if (sheetReady(plasmaSheet)) {
      for (let i = 0; i < (REDUCED ? 1 : 2); i += 1) {
        const frame = (Math.floor(t * 10) + i * 3 + (rec.seed % 6)) % 6;
        const w = 24 + i * 4;
        const h = w * 2.5;
        ctx.globalAlpha = 0.78;
        ctx.drawImage(plasmaSheet, frame * PLASMA_CELL.w, 0, PLASMA_CELL.w, PLASMA_CELL.h, a.x + a.w * (0.3 + i * 0.28) - w / 2, a.y + 6 - h, w, h);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function frameTongues(rec, t) {
    const b = rec.geom.bubble;
    const baseY = b.y + 5;
    const step = 12;
    const tick = Math.floor(t * step);
    firePuffs(rec, t, false);
    ctx.save();
    if (sheetReady(infernoSheet)) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.18;
      ctx.drawImage(glowWarm, b.x + b.w * 0.05, baseY - 36, b.w * 0.9, 42);
      ctx.globalCompositeOperation = "source-over";
      const small = REDUCED ? 2 : 4;
      for (let i = 0; i < small; i += 1) {
        const n = noise(rec.seed, i + 40);
        const p = (i + 0.5) / small + (n - 0.5) * 0.07;
        const frame = (tick + i * 2 + (rec.seed % 6)) % 6;
        const w = 26 + 8 * n;
        const h = w * 2 * (0.84 + 0.18 * Math.sin(tick + i));
        ctx.globalAlpha = 0.9;
        ctx.save();
        ctx.translate(b.x + b.w * p, baseY);
        ctx.rotate((n - 0.5) * 0.2);
        ctx.drawImage(infernoSheet, frame * INFERNO_CELL.w, 0, INFERNO_CELL.w, INFERNO_CELL.h, -w / 2, -h, w, h);
        ctx.restore();
      }
      const n = REDUCED ? 2 : 5;
      for (let i = 0; i < n; i += 1) {
        const p = (i + 0.5) / n;
        const nw = noise(rec.seed, i + 90);
        const frame = (tick + i * 3 + (rec.seed % 6)) % 6;
        const ph = rec.seed * 0.0002 + i * 1.9;
        const chop = 0.9 + 0.1 * Math.sin(tick * 1.7 + ph);
        const w = (48 + 18 * nw) * (0.94 + 0.06 * Math.sin(tick + i));
        const h = w * 2 * chop;
        const x = b.x + b.w * (0.07 + 0.86 * p) + Math.sin(tick * 1.3 + ph) * 3;
        const ang = (p - 0.5) * 0.12;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.24;
        ctx.drawImage(glowWarm, x - 34, baseY - 32, 68, 38);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 0.98;
        ctx.save();
        ctx.translate(x, baseY);
        ctx.rotate(ang);
        ctx.drawImage(infernoSheet, frame * INFERNO_CELL.w, 0, INFERNO_CELL.w, INFERNO_CELL.h, -w / 2, -h, w, h);
        ctx.restore();
      }
      for (const side of [-1, 1]) {
        const x = side < 0 ? b.x + 8 : b.x + b.w - 8;
        const frame = (tick + (side < 0 ? 2 : 5) + (rec.seed % 6)) % 6;
        const w = 32;
        const h = 72 + 8 * Math.sin(t * 3.3 + side);
        ctx.globalAlpha = 0.94;
        ctx.save();
        ctx.translate(x, b.y + 22);
        ctx.rotate(side * -0.35);
        ctx.drawImage(infernoSheet, frame * INFERNO_CELL.w, 0, INFERNO_CELL.w, INFERNO_CELL.h, -w / 2, -h, w, h);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
    if (!rec.geom.ava) return;
    const a = rec.geom.ava;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.36 + 0.12 * Math.sin(t * 6 + rec.seed);
    ctx.drawImage(glowWarm, a.x - a.w * 0.38, a.y - a.h * 0.38, a.w * 1.76, a.h * 1.76);
    if (sheetReady(infernoSheet)) {
      const frame = (tick + (rec.seed % 5)) % 6;
      const w = 32;
      const h = w * 2;
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 0.96;
      ctx.drawImage(infernoSheet, frame * INFERNO_CELL.w, 0, INFERNO_CELL.w, INFERNO_CELL.h, a.x + a.w * 0.16, a.y + 4 - h, w, h);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function embers(rec, t) {
    const b = rec.geom.bubble;
    const plasma = rec.variant !== "inferno";
    const n = REDUCED ? (plasma ? 10 : 7) : plasma ? 34 : 18;
    const speed = plasma ? 0.34 : 0.27;
    const rise = plasma ? 100 : 78;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < n; i += 1) {
      const n1 = noise(rec.seed, i + 40);
      const n2 = noise(rec.seed, i + 80);
      const n3 = noise(rec.seed, i + 120);
      const life = (t * speed + n1) % 1;
      const x =
        b.x +
        b.w * (0.06 + 0.88 * n2) +
        Math.sin(life * TAU * 1.35 + n3 * TAU) * (2 + life * (plasma ? 13 : 8));
      const y = b.y + 4 - life * rise;
      const a = Math.sin(Math.PI * life) * (plasma ? 0.82 : 0.9);
      const size = plasma ? 1.8 + 3.2 * n3 : 3.4 + 4.6 * n3;
      ctx.globalAlpha = a;
      if (plasma) {
        ctx.drawImage(n3 > 0.82 ? sparkWarm : sparkCool, x - size, y - size, size * 2, size * 2);
      } else {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(life * 4 + n3 * TAU);
        ctx.fillStyle = n3 > 0.6 ? "#ffe26a" : "#ff7a16";
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }
    /* искры по бокам пузыря: canvas под лентой, поэтому они видны вокруг
       сообщения и не закрывают текст */
    for (let i = 0; i < (REDUCED ? 4 : 12); i += 1) {
      const n1 = noise(rec.seed, i + 1600);
      const n2 = noise(rec.seed, i + 1640);
      const side = n1 > 0.5 ? 1 : -1;
      const life = (t * (plasma ? 0.4 : 0.3) + n2) % 1;
      const x0 = side > 0 ? b.x + b.w + 1 : b.x - 1;
      const x = x0 + side * life * 18 + Math.sin(life * TAU + n1 * TAU) * 4;
      const y = b.y + b.h * (0.2 + 0.7 * n2) - life * (plasma ? 34 : 26);
      const size = (plasma ? 1.5 + 2.2 * n1 : 2.6 + 3.2 * n1) * (1 - life * 0.4);
      ctx.globalAlpha = Math.sin(Math.PI * life) * 0.7;
      if (plasma) ctx.drawImage(n1 > 0.8 ? sparkWarm : sparkCool, x - size, y - size, size * 2, size * 2);
      else {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(life * 3 + n1 * TAU);
        ctx.fillStyle = n1 > 0.6 ? "#ffe26a" : "#ff7a16";
        ctx.fillRect(-size / 2, -size / 2, size, size);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function smokePuffs(rec, t) {
    const b = rec.geom.bubble;
    ctx.save();
    for (let i = 0; i < (REDUCED ? 1 : 3); i += 1) {
      const n = noise(rec.seed, i + 300);
      const life = (t * 0.17 + n) % 1;
      const x = b.x + b.w * (0.2 + 0.6 * noise(rec.seed, i + 320)) + Math.sin(t * 0.8 + n * TAU) * 12;
      const y = b.y + 8 - life * 92;
      const s = 26 + life * 44;
      ctx.globalAlpha = Math.sin(Math.PI * life) * 0.24;
      ctx.drawImage(smoke, x - s / 2, y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function ignition(rec, t) {
    const started = bursts.get(rec.id);
    if (!started) return;
    const age = (performance.now() - started) / 1000;
    if (age > 0.9) {
      bursts.delete(rec.id);
      return;
    }
    const p = age / 0.9;
    const b = rec.geom.bubble;
    const cx = b.x + b.w * 0.5;
    const cy = b.y + b.h * 0.45;
    const plasma = rec.variant !== "inferno";
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const flash = (plasma ? glowCool : glowWarm);
    const fs = 60 + p * 120;
    ctx.globalAlpha = (1 - p) * 0.65;
    ctx.drawImage(flash, cx - fs / 2, cy - fs / 2, fs, fs);
    for (let i = 0; i < (REDUCED ? 6 : 22); i += 1) {
      const ang = (i / 22) * TAU + noise(rec.seed, i + 500) * 0.7;
      const dist = 12 + p * (44 + b.w * 0.42 * (0.4 + noise(rec.seed, i + 600)));
      const x = cx + Math.cos(ang) * dist;
      const y = cy + Math.sin(ang) * dist * 0.72;
      const s = (plasma ? 2.4 : 3.2) * (1 - p * 0.5);
      ctx.globalAlpha = (1 - p) * 0.9;
      ctx.drawImage(plasma ? sparkCool : sparkWarm, x - s, y - s, s * 2, s * 2);
    }
    if (!plasma) {
      /* грубая вспышка-звезда, как в старых флэшках */
      ctx.globalAlpha = (1 - p) * 0.5;
      ctx.fillStyle = "#ffd75e";
      ctx.beginPath();
      for (let i = 0; i < 16; i += 1) {
        const ang = (i / 16) * TAU;
        const r = (i % 2 ? 18 : 44) * (0.7 + p * 1.5);
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r * 0.8;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function aura(rec, t) {
    const b = rec.geom.bubble;
    const plasma = rec.variant !== "inferno";
    const sprite = plasma ? glowCool : glowWarm;
    const w = b.w + 110;
    const h = b.h + 120;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.2 + 0.06 * Math.sin(t * 3.4 + rec.seed);
    ctx.drawImage(sprite, b.x + b.w / 2 - w / 2, b.y + b.h / 2 - h / 2, w, h);
    ctx.restore();
  }

  function sideFlames(rec, t) {
    const b = rec.geom.bubble;
    const plasma = rec.variant !== "inferno";
    const sheet = plasma ? plasmaSheet : infernoSheet;
    const cell = plasma ? PLASMA_CELL : INFERNO_CELL;
    if (!sheetReady(sheet)) return;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    for (const side of [-1, 1]) {
      for (let i = 0; i < 2; i += 1) {
        const n = noise(rec.seed, 1200 + (side > 0 ? 10 : 0) + i);
        const w = (plasma ? 25 : 31) + 8 * n;
        const h = w * (plasma ? 2.5 : 2) * (0.85 + 0.18 * Math.sin(t * 3.1 + i + side));
        const bx = side < 0 ? b.x - 2 : b.x + b.w + 2;
        const by = b.y + b.h * (0.28 + i * 0.36);
        const frame = (Math.floor(t * (plasma ? 9 : 12)) + i * 2 + (rec.seed % 6)) % 6;
        ctx.globalAlpha = 0.82;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(side * (0.82 + i * 0.22) + Math.sin(t * 2.2 + i + side) * 0.06);
        ctx.drawImage(sheet, frame * cell.w, 0, cell.w, cell.h, -w / 2, -h, w, h);
        ctx.restore();
      }
      const w = plasma ? 24 : 30;
      const h = w * (plasma ? 2.5 : 2);
      const frame = (Math.floor(t * (plasma ? 9 : 12)) + 4 + (rec.seed % 6)) % 6;
      ctx.globalAlpha = 0.72;
      ctx.save();
      ctx.translate(side < 0 ? b.x - 1 : b.x + b.w + 1, b.y + b.h - 3);
      ctx.rotate(side * 1.22);
      ctx.drawImage(sheet, frame * cell.w, 0, cell.w, cell.h, -w / 2, -h, w, h);
      ctx.restore();
    }
    ctx.restore();
  }

  function draw(rec, t) {
    if (!rec.geom) return;
    aura(rec, t);
    rim(rec, t);
    sideFlames(rec, t);
    if (rec.variant === "inferno") {
      frameTongues(rec, t);
      smokePuffs(rec, t);
    } else {
      smoothTongues(rec, t);
    }
    embers(rec, t);
    ignition(rec, t);
  }

  /* Огонь внутри пузыря: отдельный маленький canvas под текстом. Он не может
     закрыть соседние сообщения и не смешивает стили у двух горящих подряд строк. */
  function drawBubbleFire(rec, t) {
    const g = rec.bctx;
    if (!g || !rec.bw || !rec.bh || !rec.geom) return;
    const w = rec.bw;
    const h = rec.bh;
    g.clearRect(0, 0, w, h);
    g.save();
    roundRectPath(g, 0.5, 0.5, w - 1, h - 1, rec.brad);
    g.clip();
    const plasma = rec.variant !== "inferno";
    const sheet = plasma ? plasmaSheet : infernoSheet;
    const cell = plasma ? PLASMA_CELL : INFERNO_CELL;
    if (!sheetReady(sheet)) {
      g.restore();
      return;
    }
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = 0.3 + 0.08 * Math.sin(t * 4 + rec.seed);
    g.drawImage(plasma ? glowCool : glowWarm, w * 0.04, h - 48, w * 0.92, 62);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    const n = REDUCED ? 2 : 3;
    for (let i = 0; i < n; i += 1) {
      const p = (i + 0.5) / n;
      const n1 = noise(rec.seed, i + 2400);
      const frame = (Math.floor(t * (plasma ? 9 : 12)) + i * 2 + (rec.seed % 6)) % 6;
      const wf = (plasma ? 58 : 68) + 20 * n1;
      const hf = wf * (plasma ? 2.1 : 1.9) * (0.88 + 0.14 * Math.sin(t * 3.3 + i));
      const x = w * (0.1 + 0.8 * p) + Math.sin(t * 2.1 + i) * 5;
      g.globalAlpha = plasma ? 0.7 : 0.86;
      g.drawImage(sheet, frame * cell.w, 0, cell.w, cell.h, x - wf / 2, h + 10 - hf, wf, hf);
    }
    for (let i = 0; i < (REDUCED ? 1 : 2); i += 1) {
      const p = (i + 0.5) / 2;
      const n1 = noise(rec.seed, i + 2500);
      const frame = (Math.floor(t * (plasma ? 8 : 11)) + i * 3 + (rec.seed % 6)) % 6;
      const wf = (plasma ? 36 : 44) + 10 * n1;
      const hf = wf * (plasma ? 2 : 1.8);
      g.globalAlpha = plasma ? 0.5 : 0.68;
      g.drawImage(sheet, frame * cell.w, 0, cell.w, cell.h, w * (0.22 + 0.56 * p) + Math.sin(t * 2.7 + i) * 4, h + 8 - hf, wf, hf);
    }
    /* стеклянная вуаль поверх огня внутри пузыря: текст и шапка читаются,
       а пламя остаётся видимым снизу и по краям */
    const veil = g.createLinearGradient(0, 0, 0, h);
    veil.addColorStop(0, plasma ? "rgba(236,252,255,.7)" : "rgba(255,246,225,.68)");
    veil.addColorStop(0.42, plasma ? "rgba(225,250,255,.28)" : "rgba(255,240,210,.26)");
    veil.addColorStop(1, "rgba(255,255,255,.04)");
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.fillStyle = veil;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "lighter";
    for (let i = 0; i < (REDUCED ? 4 : 12); i += 1) {
      const n1 = noise(rec.seed, i + 2600);
      const n2 = noise(rec.seed, i + 2640);
      const life = (t * (plasma ? 0.55 : 0.4) + n1) % 1;
      const x = w * (0.05 + 0.9 * n2) + Math.sin(life * TAU + n1 * TAU) * 4;
      const y = h - life * (h * 0.85);
      const s = (plasma ? 1.4 + 2 * n1 : 2.2 + 2.8 * n1) * (1 - life * 0.4);
      g.globalAlpha = Math.sin(Math.PI * life) * 0.75;
      if (plasma) g.drawImage(n1 > 0.82 ? sparkWarm : sparkCool, x - s, y - s, s * 2, s * 2);
      else {
        g.save();
        g.translate(x, y);
        g.rotate(life * 3 + n1 * TAU);
        g.fillStyle = n1 > 0.6 ? "#ffe26a" : "#ff7a16";
        g.fillRect(-s / 2, -s / 2, s, s);
        g.restore();
      }
    }
    /* вспышка попадания видна внутри пузыря, под текстом */
    const started = bursts.get(rec.id);
    if (started) {
      const age = (performance.now() - started) / 1000;
      if (age < 0.9) {
        const p = age / 0.9;
        g.globalCompositeOperation = "lighter";
        g.globalAlpha = (1 - p) * 0.85;
        const fs = w * (0.25 + p * 0.55);
        g.drawImage(plasma ? glowCool : glowWarm, w / 2 - fs / 2, h * 0.45 - fs / 2, fs, fs);
        g.globalAlpha = (1 - p) * 0.9;
        g.strokeStyle = plasma ? "rgba(190,250,255,.95)" : "rgba(255,225,130,.95)";
        g.lineWidth = 2 + 3 * (1 - p);
        g.beginPath();
        g.arc(w / 2, h * 0.45, 8 + p * Math.max(w * 0.5, 40), 0, TAU);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    g.restore();
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.06, Math.max(0.001, (now - last) / 1000));
    last = now;
    if (dirty) measure();
    ctx.clearRect(0, 0, view.w, view.h);
    const t = now / 1000;
    for (const rec of active.values()) {
      draw(rec, t);
      drawBubbleFire(rec, t);
    }
    void dt;
    raf = requestAnimationFrame(frame);
  }

  function ignite(id) {
    if (!active.has(id)) sync();
    if (!active.has(id)) return;
    bursts.set(id, performance.now());
    if (!running) start();
  }

  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => layout()) : null;
  if (ro) {
    ro.observe(feed);
    if (chat) ro.observe(chat);
  }
  window.addEventListener("resize", layout);
  feed.addEventListener(
    "scroll",
    () => {
      dirty = true;
    },
    { passive: true }
  );

  return { sync, ignite };
}
