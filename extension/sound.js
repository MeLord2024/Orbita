/* Оповещения чата. Три сигнала синтезируются WebAudio — в архиве нет ни одного
   аудиофайла, и звуковые ключи не раздувают расширение. Свой mp3 играется через
   <audio> и data-URL, который хранится отдельным ключом в store.js. */

const NOTES = {
  // «капля»: два коротких синих тона, вверх
  drop: [
    [660, 0, 0.13],
    [990, 0.1, 0.18],
  ],
  // «перезвон»: мажорное трезвучие, самый мягкий из трёх
  chime: [
    [523.25, 0, 0.22],
    [659.25, 0.13, 0.22],
    [783.99, 0.26, 0.4],
  ],
  // «импульс»: низкий вход и долгий хвост — слышно в шумной комнате
  pulse: [
    [392, 0, 0.1, "triangle"],
    [587.33, 0.09, 0.34, "triangle"],
  ],
};

export const SOUND_TONES = ["drop", "chime", "pulse"];

let ctx = null;
let player = null;

function audioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  // браузер будит контекст только после жеста пользователя — пробуем каждый раз
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function unlock() {
  audioCtx();
}

function clamp(v) {
  const n = Number(v);
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.6));
}

export function playTone(name, volume) {
  const c = audioCtx();
  if (!c) return;
  const notes = NOTES[name] || NOTES.chime;
  const peak = clamp(volume) * 0.45;
  if (peak <= 0) return;
  const t0 = c.currentTime + 0.02;
  for (const [freq, at, dur, type] of notes) {
    const osc = c.createOscillator();
    const env = c.createGain();
    const start = t0 + at;
    osc.type = type || "sine";
    osc.frequency.value = freq;
    // огибающая без щелчков: быстрый подъём и экспоненциальный хвост
    env.gain.setValueAtTime(0.0001, start);
    env.gain.linearRampToValueAtTime(peak, start + 0.014);
    env.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(env);
    env.connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }
}

/* Один <audio> на весь чат: новый проигрыватель на каждое сообщение сложил бы
   несколько копий звучания друг в друга. */
export function playCustom(dataUrl, volume) {
  if (!dataUrl) return;
  if (!player) player = new Audio();
  if (player.src !== dataUrl) player.src = dataUrl;
  player.volume = clamp(volume);
  try {
    player.currentTime = 0;
  } catch {
    /* файл ещё не загружен */
  }
  player.play().catch(() => {});
}

export function play(name, opts = {}) {
  const volume = opts.volume == null ? 0.6 : opts.volume;
  if (opts.custom) {
    playCustom(opts.custom, volume);
    return;
  }
  playTone(name, volume);
}

export function stop() {
  if (player && !player.paused) player.pause();
}
