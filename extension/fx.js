// Two hand-drawn SVG tokens for the animation panel, in the chunky flash-game
// style (Kingdom Rush icons): a flamethrower operator bust and a guardian shield.
// Fire and gold come from the skin tokens (--flame, --gold); the black helmet and
// the steel plates are object colours the operator is drawn with in every skin.

const DEFS = `
  <defs>
    <linearGradient id="fxFire" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="var(--flame)" stop-opacity="0.55"/>
      <stop offset="0.45" stop-color="var(--flame)"/>
      <stop offset="1" stop-color="var(--gold)"/>
    </linearGradient>
    <linearGradient id="fxSteel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5a6980"/>
      <stop offset="1" stop-color="#222b36"/>
    </linearGradient>
    <linearGradient id="fxHelmet" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#333b46"/>
      <stop offset="0.55" stop-color="#14191f"/>
      <stop offset="1" stop-color="#05070a"/>
    </linearGradient>
    <linearGradient id="fxGold" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="var(--gold)"/>
      <stop offset="0.55" stop-color="var(--gold)"/>
      <stop offset="1" stop-color="var(--flame)"/>
    </linearGradient>
  </defs>`;

const OPEN = `<svg class="fx-art" viewBox="0 0 48 48" aria-hidden="true" focusable="false">`;

// Flamethrower operator: black helmet with a glowing visor, air tank, chest plate,
// a nozzle in hand and a fire tongue licking up to the right.
const FLAME = `${OPEN}${DEFS}
  <g class="body">
    <rect x="34" y="18" width="11" height="18" rx="5.5" fill="url(#fxSteel)"/>
    <rect x="37.5" y="13.5" width="4" height="6" rx="2" fill="#7b8ca3"/>
    <path d="M36 34q-6 5-11 2" fill="none" stroke="#161c24" stroke-width="3" stroke-linecap="round"/>
    <path d="M4 47q1-14 20-15 19 1 20 15z" fill="url(#fxSteel)"/>
    <path d="M12 45q2-8 11-10" fill="none" stroke="#93a7bf" stroke-width="2.2" stroke-linecap="round" opacity="0.55"/>
    <path d="M6 43.5h36v3.5H6z" fill="#141a22"/>
    <path d="M17 30h14v5H17z" fill="#161c24"/>
    <path d="M11 20a13 13 0 0 1 26 0v6a13 12 0 0 1-26 0z" fill="url(#fxHelmet)"/>
    <path d="M15.5 11.5q4.5-4 10.5-3.8" fill="none" stroke="#8fa2ba" stroke-width="3" stroke-linecap="round" opacity="0.5"/>
    <path d="M12.6 18.5h22.8v4.2a5.4 5.4 0 0 1-5.4 5.4H18a5.4 5.4 0 0 1-5.4-5.4z" fill="url(#fxFire)" class="visor"/>
    <path d="M12.6 18.5h22.8" stroke="#05070a" stroke-width="2.6"/>
    <path d="M22 41.5l11.5-5 2.5 5-11.5 5z" fill="#7b8ca3"/>
    <path d="M22 41.5l11.5-5" stroke="#22303f" stroke-width="1.6"/>
  </g>
  <g transform="rotate(24 35 41)">
    <g class="fire">
      <path d="M35 13c6.5 9.5 9.5 17 4.5 25-1.8 3.1-4.5 4.2-4.5 8 0-3.8-2.7-4.9-4.5-8C25.5 30 28.5 22.5 35 13z" fill="url(#fxFire)"/>
      <path d="M35 24.5c3.2 5 4.4 9 1.8 13-.7 1.2-1.8 1.9-1.8 3.5 0-1.6-1.1-2.3-1.8-3.5-2.6-4-1.4-8 1.8-13z" fill="var(--gold)"/>
    </g>
  </g>
</svg>`;

// Guardian: a heater shield, gold rim over a dark field with a gold boss.
const SHIELD = `${OPEN}${DEFS}
  <g class="shield">
    <path d="M24 3.2l17.5 5.2v13.4c0 10.8-6.6 17.7-17.5 22.8C13.1 39.5 6.5 32.6 6.5 21.8V8.4z" fill="url(#fxGold)"/>
    <path d="M24 7.4l13.3 4v10.2c0 8.3-4.6 13.7-13.3 17.7-8.7-4-13.3-9.4-13.3-17.7V11.4z" fill="#152030"/>
    <path d="M24 12.5l7.5 3.2v5.6c0 4.6-3.1 7.6-7.5 9.6-4.4-2-7.5-5-7.5-9.6v-5.6z" fill="url(#fxGold)"/>
    <path d="M9.5 11.6l14.5-4.2 1.6 2.4-15.3 4.6z" fill="#ffffff" opacity="0.42"/>
    <path d="M24 17.8v10.4" stroke="#152030" stroke-width="2.2" stroke-linecap="round" opacity="0.55"/>
  </g>
</svg>`;

export const FX_ART = { flame: FLAME, shield: SHIELD };
export const FX_LEGACY = { dragon: "flame" };

export function fxArt(id) {
  return FX_ART[id] || "";
}
