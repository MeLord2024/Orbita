// Живой фон Orbita: одна canvas-поверхность вместо десятка DOM-слоёв.
//
// Почему canvas, а не CSS: вода — это искажение отражений по строкам, сферу
// нужно наполнять «водичкой» из той же сцены, а пузыри и блики рисовать как
// готовые спрайты. В DOM каждый такой элемент — отдельный слой композитора,
// и браузер пересобирает их каждый кадр. Здесь же один слой и около сотни
// drawImage: ровно то, что делает Flash в старых играх.
//
// Сцена рисуется в offscreen-канву один раз (при смене размера), дальше кадр
// складывается из её кусков: верх — один блит, вода — полоски со сдвигом,
// сфера — вырезка той же воды с вращающимся бликом.

const HORIZON = 0.79; // где на картинке заканчивается небо и начинается вода
const SUN = { x: 0.46, y: 0.04 };

export function createScene(canvas) {
  const ctx = canvas.getContext("2d", { alpha: true });
  let img = null;
  let ready = false;
  let cache = null; // сцена, отмасштабированная под окно
  let cacheW = 0;
  let cacheH = 0;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let horizonY = 0;
  let sceneDy = 0;
  let sceneDh = 0;
  let raf = 0;
  let last = 0;
  let time = 0;
  let active = false;
  let speed = 1;
  let sunOn = true;
  let bubblesOn = true;
  const bubbles = [];
  let bubbleSprite = null;

  function makeBubbleSprite() {
    const s = 64;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(s * 0.34, s * 0.3, 1, s * 0.5, s * 0.5, s * 0.5);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.28, "rgba(255,255,255,0.22)");
    grad.addColorStop(0.62, "rgba(190,240,255,0.12)");
    grad.addColorStop(0.88, "rgba(255,255,255,0.55)");
    grad.addColorStop(1, "rgba(255,255,255,0.05)");
    g.fillStyle = grad;
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  function resetBubble(b, fromBottom) {
    b.r = 4 + Math.random() * 12;
    b.x = Math.random() * w;
    b.y = fromBottom ? h + b.r * 2 : Math.random() * h;
    b.vy = 14 + Math.random() * 26;
    b.drift = 6 + Math.random() * 22;
    b.phase = Math.random() * Math.PI * 2;
    b.alpha = 0.35 + Math.random() * 0.45;
  }

  function seedBubbles() {
    bubbles.length = 0;
    for (let i = 0; i < 9; i++) {
      const b = {};
      resetBubble(b, false);
      bubbles.push(b);
    }
  }

  function buildCache() {
    if (!img || !w || !h) return;
    cache = document.createElement("canvas");
    cache.width = Math.max(1, Math.round(w * dpr));
    cache.height = Math.max(1, Math.round(h * dpr));
    const g = cache.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    sceneDh = dh;
    sceneDy = (h - dh) / 2;
    g.drawImage(img, (w - dw) / 2, sceneDy, dw, dh);
    horizonY = sceneDy + dh * HORIZON;
    cacheW = w;
    cacheH = h;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nw = Math.max(1, Math.round(rect.width));
    const nh = Math.max(1, Math.round(rect.height));
    const ndpr = Math.min(2, window.devicePixelRatio || 1);
    if (nw === w && nh === h && ndpr === dpr) return;
    w = nw;
    h = nh;
    dpr = ndpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildCache();
    seedBubbles();
    draw(0);
  }

  function drawWater(t) {
    if (!cache || horizonY >= h) return;
    const strip = 3;
    const band = h - horizonY;
    for (let y = horizonY; y < h; y += strip) {
      const depth = (y - horizonY) / band;
      const amp = 1.2 + depth * 6;
      const phase = y * 0.055 - t * (0.7 + depth * 1.4);
      const dx = Math.sin(phase) * amp;
      const sh = Math.min(strip + 1, h - y);
      ctx.drawImage(cache, 0, (y - 0) * dpr, cacheW * dpr, sh * dpr, dx - 6, y, w + 12, sh);
    }
  }

  function drawSun(t) {
    if (!sunOn) return;
    const cx = w * SUN.x;
    const cy = h * SUN.y;
    const pulse = 0.82 + Math.sin(t * 0.9) * 0.18;
    const r = Math.max(w, h) * 0.42;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    glow.addColorStop(0, `rgba(255,255,250,${0.55 * pulse})`);
    glow.addColorStop(0.14, `rgba(255,250,225,${0.22 * pulse})`);
    glow.addColorStop(0.42, `rgba(255,245,210,${0.06 * pulse})`);
    glow.addColorStop(1, "rgba(255,245,210,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    // два луча: горизонтальный и наклонный, «дышат» в противофазе
    const rays = [
      { a: 0.1, len: 0.9, k: 0.7, off: 0 },
      { a: -0.55, len: 0.55, k: 0.45, off: 1.7 },
    ];
    for (const ray of rays) {
      const a = (0.1 + Math.sin(t * ray.k + ray.off) * 0.08) * pulse;
      if (a <= 0.01) continue;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ray.a);
      const g = ctx.createLinearGradient(0, 0, w * ray.len, 0);
      g.addColorStop(0, `rgba(255,255,255,${0.5 * a})`);
      g.addColorStop(0.55, `rgba(255,255,255,${0.14 * a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, -h * 0.012, w * ray.len, h * 0.024);
      ctx.restore();
    }
    ctx.restore();
  }

  function drawBubbles(dt) {
    if (!bubblesOn) return;
    if (!bubbleSprite) bubbleSprite = makeBubbleSprite();
    for (const b of bubbles) {
      b.y -= b.vy * dt;
      b.phase += dt * 1.6;
      const x = b.x + Math.sin(b.phase) * b.drift;
      if (b.y < -b.r * 2) resetBubble(b, true);
      const size = b.r * 2;
      ctx.globalAlpha = b.alpha;
      ctx.drawImage(bubbleSprite, x - b.r, b.y - b.r, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function drawSphere(t) {
    if (!cache) return;
    const r = Math.max(44, Math.min(h * 0.13, w * 0.09));
    const cx = r * 0.72;
    const cy = h - r * 0.5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    // внутри — та же вода, чуть смещённая и покачивающаяся
    const wobble = Math.sin(t * 0.7) * r * 0.06;
    ctx.drawImage(cache, cx - r + wobble, cy - r * 0.5, r * 2.2, r * 2.2);
    ctx.fillStyle = "rgba(120, 210, 245, 0.28)";
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    // вращающийся блик
    if (typeof ctx.createConicGradient === "function") {
      const g = ctx.createConicGradient(t * 0.9, cx, cy);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.55, "rgba(255,255,255,0)");
      g.addColorStop(0.66, "rgba(255,255,255,0.85)");
      g.addColorStop(0.74, "rgba(255,255,255,0.1)");
      g.addColorStop(0.86, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    // верхний тёмный край и белая кромка — объём
    const shade = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    shade.addColorStop(0, "rgba(255,255,255,0.45)");
    shade.addColorStop(0.55, "rgba(255,255,255,0)");
    shade.addColorStop(0.86, "rgba(8,70,120,0.22)");
    shade.addColorStop(1, "rgba(255,255,255,0.55)");
    ctx.fillStyle = shade;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.34, cy - r * 0.42, r * 0.2, r * 0.11, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fill();
    ctx.restore();
  }

  function draw(dt) {
    if (!cache) return;
    ctx.clearRect(0, 0, w, h);
    // небо и город — одним блитом, вода — полосками
    if (horizonY > 0) {
      ctx.drawImage(cache, 0, 0, cacheW * dpr, horizonY * dpr, 0, 0, w, horizonY);
    }
    drawWater(time);
    drawSun(time);
    drawBubbles(dt);
    drawSphere(time);
  }

  function tick(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    time += dt * speed;
    draw(dt);
    raf = requestAnimationFrame(tick);
  }

  let running = false;

  function start() {
    if (running || !ready || !active) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function apply() {
    stop();
    canvas.style.display = active ? "" : "none";
    if (!active) {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    draw(0); // один статичный кадр, чтобы не было пустоты до старта
    start();
  }

  const scene = {
    load(src) {
      img = new Image();
      img.onload = () => {
        ready = true;
        buildCache();
        resize();
        apply();
      };
      img.src = src;
    },
    /* active — стеклянный скин; bubbles/sun — 0..100 из ползунков;
       speed — общая скорость (берём максимум из включённых эффектов). */
    configure(next) {
      const wasActive = active;
      active = !!next.active;
      bubblesOn = (next.bubbles || 0) > 0;
      sunOn = (next.sun || 0) > 0;
      speed = 0.35 + (Math.max(next.bubbles || 0, next.sun || 0) / 100) * 1.85;
      resize();
      if (!active || wasActive !== active) apply();
      else if (!running) start();
      else draw(0);
    },
    refresh: resize,
    stop,
  };

  window.addEventListener("resize", () => scene.refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (active) start();
  });
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    scene.configure = ((orig) =>
      function (next) {
        orig.call(scene, { ...next, bubbles: 0, sun: 0 });
      })(scene.configure);
  }
  return scene;
}
