/* ==========================================================================
   Dvir Clicker - living background (window.DCBackground)
   --------------------------------------------------------------------------
   An opaque deep-space scene drawn on a full-screen canvas behind the UI:
   slowly breathing nebula clouds, twinkling stars in two parallax layers, the
   odd shooting star and a gentle rain of Dvir coins whose density follows the
   player's production.

   Performance: everything soft or glowy (nebula textures, star glows,
   vignette, coin sprites) is rendered ONCE to small offscreen canvases. The
   slow-moving nebula is composed into a ~1/3-resolution buffer ~30 times a
   second, so a frame is one full-screen drawImage of that buffer plus ~150
   small sprites (stars, coins): no shadowBlur, no per-frame gradients, no
   per-frame allocations. The nebula textures themselves are generated in
   small time slices over the first frames and then fade in, so startup
   never blocks. The game's own requestAnimationFrame loop drives us through
   step(dt).

   API:
     DCBackground.init(canvas, { coinSrc: "coin.png" })
     DCBackground.step(dt)               dt in seconds
     DCBackground.resize()
     DCBackground.setProduction(perSec)  drives the coin rain density
     DCBackground.setMode(mode)          "normal" | "frenzy" | "clickfrenzy"
     DCBackground.pulse(strength)        0..1 light flash from the centre
     DCBackground.setAccent(cssColor)    tints one nebula cloud
   ========================================================================== */
(function () {
  "use strict";

  const TAU = Math.PI * 2;
  const MAX_DPR = 1.5;
  const MAX_COINS = 40;
  const MAX_RAIN = 6; // coins per second at the very top end
  const NEB_RES = 96; // nebula texture size; it is soft, so it upscales well
  const NEB_SCALE = 0.35; // nebula buffer resolution, per CSS pixel
  const NEB_MAX_AREA = 320000; // ...but at most this many buffer pixels
  const NEB_INTERVAL = 1 / 30; // seconds between nebula buffer updates...
  const NEB_INTERVAL_SLOW = 1 / 12; // ...when the canvas turns out to be slow

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (t) => t * t * (3 - 2 * t);
  // Frame-rate independent exponential approach: share of the gap to close.
  const approach = (dt, tau) => 1 - Math.exp(-dt / tau);
  // globalAlpha silently ignores values outside 0..1, so always clamp.
  const alpha01 = (a) => (a > 1 ? 1 : a < 0 ? 0 : a);

  function makeCanvas(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }

  // ---------------------------------------------------------------
  // Colours
  // ---------------------------------------------------------------
  let parseCtx = null;

  // Let the browser parse any CSS colour; returns [r, g, b] or null.
  function parseColor(css) {
    if (!parseCtx) parseCtx = makeCanvas(1, 1).getContext("2d");
    const SENTINEL = "#010203";
    parseCtx.fillStyle = SENTINEL;
    parseCtx.fillStyle = String(css);
    const s = String(parseCtx.fillStyle);
    if (s === SENTINEL && String(css).toLowerCase() !== SENTINEL) return null;
    if (s[0] === "#") {
      return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
    }
    const m = s.match(/[\d.]+/g);
    return m && m.length >= 3 ? [+m[0], +m[1], +m[2]] : null;
  }

  // Relative luminance (0..1) of an [r, g, b] colour.
  function luminance(c) {
    const lin = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  }

  const rgba = (c, a) => "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";

  // ---------------------------------------------------------------
  // Procedural nebula textures (computed once, a few rows per frame)
  // ---------------------------------------------------------------
  // 8 gradient directions for 2D Perlin noise.
  const GX = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071];
  const GY = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];

  function makeNoise(seed) {
    const perm = new Uint8Array(512);
    let s = seed >>> 0 || 1;
    const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      const t = perm[i];
      perm[i] = perm[j];
      perm[j] = t;
    }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

    return function noise(x, y) {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const xf = x - xi;
      const yf = y - yi;
      const X = xi & 255;
      const Y = yi & 255;
      const h00 = perm[perm[X] + Y] & 7;
      const h10 = perm[perm[X + 1] + Y] & 7;
      const h01 = perm[perm[X] + Y + 1] & 7;
      const h11 = perm[perm[X + 1] + Y + 1] & 7;
      const n00 = GX[h00] * xf + GY[h00] * yf;
      const n10 = GX[h10] * (xf - 1) + GY[h10] * yf;
      const n01 = GX[h01] * xf + GY[h01] * (yf - 1);
      const n11 = GX[h11] * (xf - 1) + GY[h11] * (yf - 1);
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
      const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      const a = n00 + (n10 - n00) * u;
      const b = n01 + (n11 - n01) * u;
      return a + (b - a) * v; // roughly -0.7..0.7
    };
  }

  function fbm(noise, x, y, octaves) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * noise(x, y);
      norm += amp;
      // Double the frequency and rotate ~37deg each octave (hides the grid).
      const nx = 1.6 * x - 1.2 * y + 17.3;
      y = 1.2 * x + 1.6 * y + 9.1;
      x = nx;
      amp *= 0.5;
    }
    return sum / norm;
  }

  // A cloud: soft, noise-distorted round falloff with domain-warped wisps.
  // dens = opacity 0..1, mix = 0..1 blend between the cloud's two colours.
  // Built row by row (fieldRow) so startup never blocks for long.
  function newField(seed) {
    const N = NEB_RES;
    return { noise: makeNoise(seed), dens: new Float32Array(N * N), mix: new Float32Array(N * N), row: 0 };
  }

  function fieldRow(f, j) {
    const N = NEB_RES;
    const noise = f.noise;
    const ny = ((j + 0.5) / N) * 2 - 1;
    for (let i = 0; i < N; i++) {
      const nx = ((i + 0.5) / N) * 2 - 1;
      const r = Math.sqrt(nx * nx + ny * ny);
      if (r >= 1) continue;
      const px = nx * 1.35;
      const py = ny * 1.35;
      const wx = fbm(noise, px + 3.1, py + 1.7, 2);
      const wy = fbm(noise, px - 4.3, py + 6.2, 2);
      const n = fbm(noise, px * 1.7 + wx * 1.9, py * 1.7 + wy * 1.9, 4) + 0.5;
      const wisps = smooth(clamp((n - 0.28) / 0.5, 0, 1));
      const rr = r * (1 + 0.5 * wx);
      const edge = smooth(clamp((1 - r) / 0.3, 0, 1)); // exactly 0 at the border
      const k = j * N + i;
      f.dens[k] = Math.exp(-rr * rr * 3.2) * edge * (0.14 + 0.86 * wisps * wisps);
      f.mix[k] = clamp(0.5 + wy * 1.6, 0, 1);
    }
  }

  // Colour a field into a sprite canvas (cheap; redone on accent change).
  function paintField(field, colA, colB, peak) {
    const N = NEB_RES;
    const c = makeCanvas(N, N);
    const g = c.getContext("2d");
    const img = g.createImageData(N, N);
    const d = img.data;
    for (let k = 0; k < N * N; k++) {
      const m = field.mix[k];
      const p = k * 4;
      d[p] = colA[0] + (colB[0] - colA[0]) * m;
      d[p + 1] = colA[1] + (colB[1] - colA[1]) * m;
      d[p + 2] = colA[2] + (colB[2] - colA[2]) * m;
      d[p + 3] = 255 * peak * field.dens[k];
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // ---------------------------------------------------------------
  // Scene description
  // ---------------------------------------------------------------
  // Clouds. x/y: centre as a share of the screen; r: radius as a share of the
  // screen size; sx: horizontal stretch; a: opacity; ax/ay: drift amplitude
  // (share of the screen); pd/pb: drift / breathing periods in seconds.
  const CLOUDS = [
    { field: 0, x: 0.76, y: 0.16, r: 0.95, sx: 1.25, a: 0.9, colA: "#34257f", colB: "#22175a", ax: 0.05, ay: 0.03, pd: 71, pb: 23 },
    { field: 1, x: 0.08, y: 0.9, r: 0.92, sx: 1.15, a: 0.95, colA: "#561a5e", colB: "#33103d", ax: 0.04, ay: 0.03, pd: 83, pb: 29 },
    { field: 2, x: 0.16, y: 0.34, r: 0.62, sx: 1.35, a: 0.6, colA: "#1b3478", colB: "#1d1b5c", ax: 0.05, ay: 0.04, pd: 97, pb: 19 },
  ];
  // The accent cloud (colour follows the equipped Dvir frame): an aura in
  // the upper-middle, roughly behind Dvir on phones and desktops alike.
  const ACCENT = { field: 3, x: 0.6, y: 0.36, r: 0.7, sx: 1.2, a: 1, ax: 0.05, ay: 0.04, pd: 89, pb: 25 };
  // Mode tints, faded in by the eased mode weights.
  const TINTS = {
    frenzy: [
      { field: 1, x: 0.5, y: 1.02, r: 1.0, sx: 1.6, a: 0.46, colA: "#ffa030", colB: "#ff6a1f", ax: 0.04, ay: 0.02, pd: 31, pb: 7 },
      { field: 3, x: 0.86, y: 0.12, r: 0.72, sx: 1.2, a: 0.34, colA: "#ffc44a", colB: "#ff8a1f", ax: 0.04, ay: 0.03, pd: 37, pb: 9 },
      { field: 0, x: 0.08, y: 0.4, r: 0.66, sx: 1.2, a: 0.3, colA: "#ffa03d", colB: "#ff5a1a", ax: 0.04, ay: 0.04, pd: 41, pb: 8 },
    ],
    clickfrenzy: [
      { field: 2, x: 0.06, y: 0.24, r: 0.8, sx: 1.2, a: 0.34, colA: "#ff4f8b", colB: "#d42a8a", ax: 0.05, ay: 0.04, pd: 23, pb: 3.1 },
      { field: 0, x: 0.96, y: 0.62, r: 0.78, sx: 1.2, a: 0.3, colA: "#3ae0ff", colB: "#2f6bff", ax: 0.05, ay: 0.04, pd: 27, pb: 3.7 },
      { field: 1, x: 0.7, y: 0.02, r: 0.6, sx: 1.4, a: 0.2, colA: "#b84dff", colB: "#ff4f8b", ax: 0.05, ay: 0.03, pd: 19, pb: 2.9 },
    ],
  };
  // Per mode: [normal-blend strength, additive strength] for the tints.
  const TINT_BLEND = { frenzy: [0.75, 0.55], clickfrenzy: [0, 1] };
  // Star colours per mode: [white, blue, gold, lilac] style slots.
  const STAR_COLORS = {
    normal: ["#ffffff", "#cfe0ff", "#ffe6b8", "#e6d2ff"],
    frenzy: ["#fff4d6", "#ffd98a", "#ffb547", "#ffe9a8"],
    clickfrenzy: ["#f4fdff", "#7ff0ff", "#ff8fc0", "#c9a8ff"],
  };
  const STREAK_COLORS = { normal: "#dfe9ff", frenzy: "#ffd27a", clickfrenzy: "#8ff3ff" };
  const MODES = ["normal", "frenzy", "clickfrenzy"];

  // Rain density anchors: [log10(perSec), coins per second].
  const RAIN_CURVE = [
    [0, 0.3],
    [1, 0.8],
    [2, 1.5],
    [3, 2.5],
    [5, MAX_RAIN],
  ];

  function rainFor(perSec) {
    if (!(perSec > 0)) return 0; // also catches NaN / negative
    if (perSec < 1) return RAIN_CURVE[0][1] * perSec;
    const x = Math.log10(perSec);
    for (let i = 1; i < RAIN_CURVE.length; i++) {
      const a = RAIN_CURVE[i - 1];
      const b = RAIN_CURVE[i];
      if (x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
    }
    return MAX_RAIN;
  }

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let canvas = null;
  let ctx = null;
  let ready = false;
  let W = 0; // CSS pixels
  let H = 0;
  let dpr = 1;
  let baseGrad = null;
  let neb = null; // low-resolution nebula buffer (opaque)
  let nebCtx = null;
  let nebKx = NEB_SCALE; // buffer pixels per CSS pixel (x / y: the buffer
  let nebKy = NEB_SCALE; // is whole pixels, so the ratios differ a hair)
  let nebAge = 0;
  let nebInterval = NEB_INTERVAL;
  let nebCost = 0; // moving average of a buffer refresh, in ms
  let nebDirty = true;
  let reduced = false;
  let dirty = true; // reduced motion only redraws when something changed
  let sinceDraw = 0;

  let nebClock = rand(0, 600); // drift clock (random start = varied layout)
  let twClock = 0; // twinkle clock, runs faster in the frenzy modes
  let tintClock = 0; // mode-tint breathing clock

  // Eased inputs.
  let production = 0;
  let rain = 0; // eased coins/second, before the mode multiplier
  let mode = "normal";
  const weight = { normal: 1, frenzy: 0, clickfrenzy: 0 };

  // Sprites (offscreen canvases).
  const FIELD_SEEDS = [7, 23, 41, 59]; // four textures shared by all clouds
  const fields = [];
  let fieldJob = null; // texture being computed
  let nebReady = false; // all cloud sprites painted
  let nebFade = 0; // 0..1 fade-in once they are
  let clouds = []; // painted CLOUDS
  const tints = { frenzy: [], clickfrenzy: [] };
  let accentColor = [123, 77, 255]; // soft violet until setAccent()
  let accentFrom = null; // cross-fade: old sprite...
  let accentTo = null; // ...to new sprite
  let accentMix = 1;
  const starSprites = { normal: [], frenzy: [], clickfrenzy: [] };
  const sparkleSprites = {};
  const streakSprites = {};
  let glowSprite = null;
  let ringSprite = null;
  let vignette = null;
  let grain = null;
  let coinImg = null;
  let coinBig = null;
  let coinSmall = null;
  let coinDpr = 0;

  const stars = [];
  const coins = []; // alive, sorted far -> near
  const coinPool = [];
  let spawnAcc = 0;
  let spawnNext = 1;

  const shoot = { on: false, x: 0, y: 0, dx: 0, dy: 0, speed: 0, len: 0, age: 0, life: 1, sprite: null };
  let shootTimer = rand(4, 10);

  const pulses = [];
  for (let i = 0; i < 4; i++) pulses.push({ on: false, age: 0, life: 1, s: 0 });

  // ---------------------------------------------------------------
  // Sprite builders
  // ---------------------------------------------------------------
  function radialSprite(size, stops) {
    const c = makeCanvas(size, size);
    const g = c.getContext("2d");
    const r = size / 2;
    const grad = g.createRadialGradient(r, r, 0, r, r, r);
    for (let i = 0; i < stops.length; i++) grad.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  function buildStarSprites() {
    for (let m = 0; m < MODES.length; m++) {
      const key = MODES[m];
      const list = STAR_COLORS[key];
      starSprites[key] = list.map((css) => {
        const c = parseColor(css);
        // Hot white core, coloured halo.
        return radialSprite(32, [
          [0, "rgba(255,255,255,1)"],
          [0.12, rgba(c, 0.95)],
          [0.28, rgba(c, 0.32)],
          [0.55, rgba(c, 0.08)],
          [1, rgba(c, 0)],
        ]);
      });

      // Four-point sparkle for a few bright stars.
      const col = parseColor(list[key === "normal" ? 1 : 2]);
      const S = 64;
      const sp = makeCanvas(S, S);
      const g = sp.getContext("2d");
      g.globalCompositeOperation = "lighter";
      const h = S / 2;
      for (let k = 0; k < 2; k++) {
        const grad = k === 0 ? g.createLinearGradient(0, 0, S, 0) : g.createLinearGradient(0, 0, 0, S);
        grad.addColorStop(0, rgba(col, 0));
        grad.addColorStop(0.5, rgba(col, 0.9));
        grad.addColorStop(1, rgba(col, 0));
        g.fillStyle = grad;
        if (k === 0) g.fillRect(0, h - 1, S, 2);
        else g.fillRect(h - 1, 0, 2, S);
      }
      g.drawImage(
        radialSprite(S, [
          [0, "rgba(255,255,255,1)"],
          [0.08, rgba(col, 0.8)],
          [0.22, rgba(col, 0.18)],
          [1, rgba(col, 0)],
        ]),
        0,
        0
      );
      sparkleSprites[key] = sp;

      // Shooting-star streak: fading tail on the left, bright head on the right.
      const sc = parseColor(STREAK_COLORS[key]);
      const st = makeCanvas(256, 16);
      const sg = st.getContext("2d");
      const tail = sg.createLinearGradient(0, 0, 248, 0);
      tail.addColorStop(0, rgba(sc, 0));
      tail.addColorStop(0.7, rgba(sc, 0.35));
      tail.addColorStop(1, "rgba(255,255,255,0.95)");
      sg.fillStyle = tail;
      sg.beginPath();
      sg.moveTo(0, 8);
      sg.lineTo(248, 6.4);
      sg.lineTo(248, 9.6);
      sg.closePath();
      sg.fill();
      sg.globalCompositeOperation = "lighter";
      sg.drawImage(
        radialSprite(16, [
          [0, "rgba(255,255,255,1)"],
          [0.3, rgba(sc, 0.6)],
          [1, rgba(sc, 0)],
        ]),
        240,
        0
      );
      streakSprites[key] = st;
    }
  }

  function buildStaticSprites() {
    buildStarSprites();
    // Warm light for pulses.
    glowSprite = radialSprite(128, [
      [0, "rgba(255,240,205,1)"],
      [0.18, "rgba(255,200,100,0.55)"],
      [0.45, "rgba(255,160,60,0.18)"],
      [1, "rgba(255,130,40,0)"],
    ]);
    ringSprite = radialSprite(256, [
      [0, "rgba(255,210,120,0)"],
      [0.62, "rgba(255,210,120,0)"],
      [0.8, "rgba(255,222,140,0.6)"],
      [0.87, "rgba(255,190,90,0.22)"],
      [1, "rgba(255,170,70,0)"],
    ]);
    // Vignette: corners darken a little to frame the UI.
    vignette = makeCanvas(128, 128);
    const vg = vignette.getContext("2d");
    const grad = vg.createRadialGradient(64, 64, 0, 64, 64, 64 * Math.SQRT2);
    grad.addColorStop(0, "rgba(6,4,18,0)");
    grad.addColorStop(0.5, "rgba(6,4,18,0)");
    grad.addColorStop(0.8, "rgba(6,4,18,0.28)");
    grad.addColorStop(1, "rgba(6,4,18,0.6)");
    vg.fillStyle = grad;
    vg.fillRect(0, 0, 128, 128);
    // Very faint static grain: dithers the dark gradients so they never band.
    const G = 128;
    const gc = makeCanvas(G, G);
    const gg = gc.getContext("2d");
    const img = gg.createImageData(G, G);
    for (let p = 0; p < img.data.length; p += 4) {
      const v = Math.random() < 0.5 ? 0 : 255;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 4 + Math.random() * 7;
    }
    gg.putImageData(img, 0, 0);
    grain = gc;
  }

  // Compute texture rows until the time budget is spent (a couple of dozen
  // frames on a slow phone in total). Returns true once every texture exists.
  function buildFields(budgetMs) {
    const t0 = performance.now();
    while (fields.length < FIELD_SEEDS.length) {
      if (!fieldJob) fieldJob = newField(FIELD_SEEDS[fields.length]);
      while (fieldJob.row < NEB_RES) {
        fieldRow(fieldJob, fieldJob.row++);
        if (performance.now() - t0 > budgetMs) return false;
      }
      fields.push(fieldJob);
      fieldJob = null;
    }
    return true;
  }

  // Colouring the textures into sprites, as a list of small jobs so startup
  // can do one per frame.
  function paintJobs() {
    const jobs = [];
    const paint = (def) => paintField(fields[def.field], parseColor(def.colA), parseColor(def.colB), def.a);
    CLOUDS.forEach((def, i) => jobs.push(() => (clouds[i] = paint(def))));
    for (const key in TINTS) TINTS[key].forEach((def, i) => jobs.push(() => (tints[key][i] = paint(def))));
    jobs.push(() => {
      accentTo = paintAccent(accentColor);
      accentFrom = null;
      accentMix = 1;
    });
    return jobs;
  }

  let paintQueue = null;

  // One sprite per call; the nebula is ready after the last one.
  function paintNebulaStep() {
    if (!paintQueue) paintQueue = paintJobs();
    paintQueue.shift()();
    if (!paintQueue.length) {
      paintQueue = null;
      nebReady = true;
    }
  }

  // All at once (after a lost canvas context comes back).
  function paintNebula() {
    const jobs = paintJobs();
    for (let i = 0; i < jobs.length; i++) jobs[i]();
  }

  // Bright accent colours are drawn fainter so the scene stays dark enough
  // for the UI text on top; the second colour is a darker, cooler variant.
  function paintAccent(c) {
    const lum = luminance(c);
    const peak = clamp(0.12 / Math.sqrt(lum + 0.01), 0.2, 0.45);
    const dark = [c[0] * 0.45 + 20, c[1] * 0.35 + 10, c[2] * 0.55 + 40].map((v) => Math.min(255, v | 0));
    return paintField(fields[ACCENT.field], c, dark, peak);
  }

  // Pre-shrink the coin with high-quality filtering, at the sizes we draw it,
  // so small coins don't shimmer.
  function buildCoinSprites() {
    if (!coinImg || !coinImg.complete || !coinImg.naturalWidth) return;
    // Each sprite: a soft golden halo, the coin, then the coin added onto
    // itself so it reads as warm gold (not brown) at background opacity.
    const shrink = (px) => {
      const pad = Math.ceil(px * 0.3);
      const c = makeCanvas(px + pad * 2, px + pad * 2);
      const g = c.getContext("2d");
      const mid = c.width / 2;
      const halo = g.createRadialGradient(mid, mid, px * 0.3, mid, mid, mid);
      halo.addColorStop(0, "rgba(255,200,80,0.55)");
      halo.addColorStop(0.6, "rgba(255,185,60,0.2)");
      halo.addColorStop(1, "rgba(255,170,40,0)");
      g.fillStyle = halo;
      g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(coinImg, pad, pad, px, px);
      g.globalCompositeOperation = "lighter";
      g.globalAlpha = 0.45;
      g.drawImage(coinImg, pad, pad, px, px);
      c.scale = c.width / px; // sprite size relative to the coin itself
      return c;
    };
    coinBig = shrink(Math.ceil(28 * dpr));
    coinSmall = shrink(Math.ceil(19 * dpr));
    coinDpr = dpr;
  }

  // ---------------------------------------------------------------
  // Stars
  // ---------------------------------------------------------------
  function newStar() {
    const near = Math.random() < 0.38;
    const r = Math.random();
    return {
      u: Math.random(), // position as a share of the screen (survives resizes)
      v: Math.random(),
      near,
      size: near ? rand(1.1, 2.1) : rand(0.55, 1.1),
      a: near ? rand(0.55, 0.95) : rand(0.28, 0.6),
      speed: near ? rand(6.5, 10) : rand(2.2, 4), // CSS px/s, upward
      tw: rand(0.5, 2),
      tph: rand(0, TAU),
      tamp: Math.random() < 0.3 ? rand(0.45, 0.8) : rand(0.08, 0.3),
      col: r < 0.55 ? 0 : r < 0.75 ? 1 : r < 0.9 ? 2 : 3,
      sparkle: near && Math.random() < 0.14,
    };
  }

  // Star count follows screen area (~100 on a phone). Hysteresis so the
  // mobile URL bar showing/hiding doesn't add or remove stars.
  function fitStars() {
    const target = Math.round(clamp((W * H) / 3600, 45, 220));
    if (stars.length && Math.abs(target - stars.length) < stars.length * 0.15) return;
    while (stars.length < target) stars.push(newStar());
    if (stars.length > target) stars.length = target;
  }

  // ---------------------------------------------------------------
  // Coins
  // ---------------------------------------------------------------
  function spawnCoin() {
    if (coins.length >= MAX_COINS || !coinBig) return;
    const c = coinPool.pop() || {};
    const d = Math.pow(Math.random(), 1.4); // depth 0 = far, 1 = near; more far ones
    c.d = d;
    c.size = 14 + 14 * d;
    c.alpha = 0.3 + 0.25 * d;
    c.vy = 34 + 44 * d;
    c.x0 = rand(-0.02, 1.02) * W;
    c.y = -c.size; // just above the top edge
    c.sway = 3 + 10 * d;
    c.swf = rand(0.5, 1.1);
    c.swph = rand(0, TAU);
    c.ang = rand(0, TAU);
    c.spin = rand(1.6, 3.6) * (Math.random() < 0.5 ? -1 : 1);
    c.tilt = rand(-0.35, 0.35);
    c.age = 0;
    // Keep the list sorted far -> near so nearer coins draw on top.
    let i = coins.length;
    while (i > 0 && coins[i - 1].d > d) i--;
    coins.splice(i, 0, c);
  }

  // ---------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------
  function update(dt) {
    // Nebula textures: computed a little each frame, coloured one sprite per
    // frame, then faded in.
    let nebChanging = false;
    if (!nebReady) {
      if (fields.length < FIELD_SEEDS.length) buildFields(2);
      else paintNebulaStep();
      nebChanging = nebReady;
    } else if (nebFade < 1) {
      nebFade = Math.min(1, nebFade + dt / 1.5);
      nebChanging = true;
    }

    // Mode weights (~1s transitions).
    const km = approach(dt, 0.33);
    let modeMoving = false;
    for (let i = 0; i < MODES.length; i++) {
      const key = MODES[i];
      const target = key === mode ? 1 : 0;
      weight[key] += (target - weight[key]) * km;
      if (Math.abs(target - weight[key]) < 0.001) weight[key] = target;
      else modeMoving = true;
    }
    const wF = weight.frenzy;
    const wC = weight.clickfrenzy;

    // Accent cross-fade.
    if (accentMix < 1) accentMix = Math.min(1, accentMix + dt / 1.2);

    // Pulses.
    let pulsing = false;
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      if (!p.on) continue;
      p.age += dt;
      if (p.age >= p.life) p.on = false;
      else pulsing = true;
    }

    if (reduced) {
      if (modeMoving || accentMix < 1 || nebChanging) nebDirty = true;
      if (modeMoving || accentMix < 1 || nebChanging || pulsing) dirty = true;
      return;
    }

    // The nebula moves very slowly: refresh its buffer ~30 times a second.
    nebAge += dt;
    if (nebAge >= nebInterval) {
      nebAge %= nebInterval;
      nebDirty = true;
    }

    // Clocks.
    nebClock += dt;
    tintClock += dt;
    twClock += dt * (1 + 0.4 * wF + 1.3 * wC);

    // Stars drift upward; faster (warp-ish) in the frenzy modes.
    const drift = (1 + 1.3 * wF + 2.3 * wC) * dt;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      s.v -= (s.speed * drift) / H;
      if (s.v < -0.02) {
        s.v += 1.04;
        s.u = Math.random();
      }
    }

    // Shooting stars (more often in the frenzy modes).
    if (shoot.on) {
      shoot.age += dt;
      shoot.x += shoot.dx * shoot.speed * dt;
      shoot.y += shoot.dy * shoot.speed * dt;
      if (shoot.age >= shoot.life) shoot.on = false;
    } else {
      shootTimer -= dt * (1 + 1.5 * wF + 1 * wC);
      if (shootTimer <= 0) {
        shootTimer = rand(8, 20);
        const right = Math.random() < 0.5;
        const ang = rand(0.16, 0.36) * Math.PI; // below horizontal
        shoot.on = true;
        shoot.age = 0;
        shoot.life = rand(0.65, 1);
        shoot.speed = rand(650, 950) * clamp(Math.max(W, H) / 900, 0.7, 1.4);
        shoot.len = rand(110, 190);
        shoot.dx = Math.cos(ang) * (right ? 1 : -1);
        shoot.dy = Math.sin(ang);
        shoot.x = right ? rand(0.05, 0.6) * W : rand(0.4, 0.95) * W;
        shoot.y = rand(0.03, 0.4) * H;
        shoot.sprite = streakSprites[wC > 0.5 ? "clickfrenzy" : wF > 0.5 ? "frenzy" : "normal"];
      }
    }

    // Coin rain: Poisson spawns at the eased rate.
    rain += (rainFor(production) - rain) * approach(dt, 1.2);
    const rate = Math.max(rain * (1 + 2 * wF), 0.8 * wF);
    const intensity = clamp(rate / MAX_RAIN, 0, 1);
    if (rate > 0.001 && coinBig) {
      spawnAcc += rate * dt;
      while (spawnAcc >= spawnNext) {
        spawnAcc -= spawnNext;
        spawnNext = -Math.log(1 - Math.random() * 0.999);
        spawnCoin();
      }
    } else {
      spawnAcc = 0;
    }
    const fall = (1 + 0.7 * intensity + 0.3 * wF) * dt;
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      c.age += dt;
      c.y += c.vy * fall;
      c.ang += c.spin * dt;
      if (c.y > H + c.size) {
        coinPool.push(coins[i]);
        coins.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------
  // Draw img centred on (cx, cy) CSS px, half-size rw x rh, on context g
  // whose pixels are kx / ky per CSS pixel. (No rotation: axis-aligned
  // scaled blits are much cheaper if the canvas ends up software-rendered.)
  function drawSprite(g, kx, ky, img, cx, cy, rw, rh, a) {
    if (a <= 0.003 || !img) return;
    g.setTransform(kx, 0, 0, ky, cx * kx, cy * ky);
    g.globalAlpha = alpha01(a);
    g.drawImage(img, -rw, -rh, rw * 2, rh * 2);
  }

  // A cloud drifts and breathes (size + glow) on its own slow sine clocks.
  function drawCloud(img, def, size, a, clock, i) {
    const t = clock;
    const ph = i * 1.7;
    const cx = W * (def.x + def.ax * Math.sin((t * TAU) / def.pd + ph));
    const cy = H * (def.y + def.ay * Math.sin((t * TAU) / (def.pd * 1.3) + ph * 2.1));
    const breathe = 1 + 0.07 * Math.sin((t * TAU) / def.pb + ph);
    const r = size * def.r * breathe;
    const glow = 0.86 + 0.14 * Math.sin((t * TAU) / (def.pb * 1.3) + ph * 3);
    drawSprite(nebCtx, nebKx, nebKy, img, cx, cy, r * def.sx, r, a * glow);
  }

  // Base gradient + clouds + tints + vignette into the low-res buffer.
  function renderNebula() {
    const g = nebCtx;
    const wF = weight.frenzy;
    const wC = weight.clickfrenzy;
    const size = (W + H) * 0.5;
    g.setTransform(nebKx, 0, 0, nebKy, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.fillStyle = baseGrad;
    g.fillRect(0, 0, W, H);

    // Palette clouds dim while a frenzy tint takes over.
    const fade = smooth(nebFade); // startup fade-in
    const dimClouds = (1 - 0.62 * wF - 0.4 * wC) * fade;
    for (let i = 0; i < clouds.length; i++) drawCloud(clouds[i], CLOUDS[i], size, dimClouds, nebClock, i);
    const am = smooth(accentMix);
    if (accentFrom && am < 1) drawCloud(accentFrom, ACCENT, size, (1 - am) * fade, nebClock, 3);
    drawCloud(accentTo, ACCENT, size, am * fade, nebClock, 3);
    // Mode tints: a normal pass replaces some of the purple (so gold reads
    // as gold, not mauve), then an additive pass makes it glow.
    for (const key in tints) {
      const w = weight[key] * fade;
      if (w < 0.003) continue;
      const list = tints[key];
      const blend = TINT_BLEND[key];
      for (let pass = 0; pass < 2; pass++) {
        if (!blend[pass]) continue;
        g.globalCompositeOperation = pass ? "lighter" : "source-over";
        for (let i = 0; i < list.length; i++) drawCloud(list[i], TINTS[key][i], size, w * blend[pass], tintClock, i + 5);
      }
    }

    // Vignette: corners darken a little to frame the UI.
    g.setTransform(nebKx, 0, 0, nebKy, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 1;
    g.drawImage(vignette, 0, 0, W, H);
  }

  function draw() {
    if (!ctx || !W || !H) return;
    const wF = weight.frenzy;
    const wC = weight.clickfrenzy;

    // Nebula buffer, stretched over the whole (opaque) canvas.
    const refresh = nebDirty;
    const t0 = refresh ? performance.now() : 0;
    if (refresh) {
      renderNebula();
      nebDirty = false;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(neb, 0, 0, canvas.width, canvas.height);
    if (refresh) {
      // With a GPU canvas this is a fraction of a millisecond. A software
      // canvas rasterises the buffer right here, so refresh it less often.
      nebCost += (performance.now() - t0 - nebCost) * 0.1;
      nebInterval = nebCost > 2.5 ? NEB_INTERVAL_SLOW : NEB_INTERVAL;
    }

    // Stars (additive light). During a mode change both colour sets draw,
    // weighted, so the stars cross-fade instead of popping.
    ctx.globalCompositeOperation = "lighter";
    const pulseBoost = pulseLevel();
    const bright = 1 + 0.45 * wF + 0.3 * wC + 0.8 * pulseBoost;
    drawStars(false, bright);
    if (shoot.on) drawShootingStar();
    drawStars(true, bright);

    // Coins.
    ctx.globalCompositeOperation = "source-over";
    if (coins.length) drawCoins();

    // Pulse light on top, then grain.
    if (pulseBoost > 0) drawPulses();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    if (grain) {
      if (!grain.pattern) grain.pattern = ctx.createPattern(grain, "repeat");
      ctx.fillStyle = grain.pattern;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function drawStars(near, bright) {
    const twinkle = !reduced;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // one transform for all stars
    for (let m = 0; m < MODES.length; m++) {
      const key = MODES[m];
      const w = weight[key];
      if (w < 0.01) continue;
      const sprites = starSprites[key];
      const sparkle = sparkleSprites[key];
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        if (s.near !== near) continue;
        let a = s.a * bright * w;
        if (twinkle) a *= 1 - s.tamp * 0.5 * (1 + Math.sin(twClock * s.tw + s.tph));
        if (a < 0.01) continue;
        const x = s.u * W;
        const y = s.v * H;
        const d = s.size * 6;
        ctx.globalAlpha = alpha01(a);
        ctx.drawImage(sprites[s.col], x - d / 2, y - d / 2, d, d);
        if (s.sparkle) {
          const k = s.size * 9;
          ctx.globalAlpha = alpha01(a * a * 0.9);
          ctx.drawImage(sparkle, x - k / 2, y - k / 2, k, k);
        }
      }
    }
  }

  function drawShootingStar() {
    const t = shoot.age / shoot.life;
    const a = Math.min(1, t / 0.12) * (1 - smooth(clamp((t - 0.5) / 0.5, 0, 1)));
    const len = shoot.len * Math.min(1, 0.35 + t * 2);
    const c = shoot.dx * dpr;
    const s = shoot.dy * dpr;
    ctx.setTransform(c, s, -s, c, shoot.x * dpr, shoot.y * dpr);
    ctx.globalAlpha = alpha01(a * 0.9);
    ctx.drawImage(shoot.sprite, -len, -3.5, len + 4, 7);
  }

  function drawCoins() {
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      // Spinning coin = horizontal squash; edge-on it is a little darker.
      let sx = Math.cos(c.ang);
      const face = Math.abs(sx);
      if (face < 0.06) sx = sx < 0 ? -0.06 : 0.06;
      const tilt = c.tilt + 0.12 * Math.sin(c.age * c.swf * 1.3 + c.swph);
      const ct = Math.cos(tilt) * dpr;
      const st = Math.sin(tilt) * dpr;
      const x = c.x0 + c.sway * Math.sin(c.age * c.swf + c.swph);
      ctx.setTransform(ct * sx, st * sx, -st, ct, x * dpr, c.y * dpr);
      ctx.globalAlpha = alpha01(c.alpha * (0.72 + 0.28 * face));
      const img = c.size > 21 ? coinBig : coinSmall;
      const d = c.size * img.scale;
      ctx.drawImage(img, -d / 2, -d / 2, d, d);
    }
  }

  // Combined brightness of active pulses (0..~1), also used to lift the stars.
  function pulseLevel() {
    let sum = 0;
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      if (!p.on) continue;
      const k = 1 - p.age / p.life;
      sum += p.s * k * k;
    }
    return sum;
  }

  function drawPulses() {
    ctx.globalCompositeOperation = "lighter";
    const cx = W / 2;
    const cy = H / 2;
    const reach = Math.sqrt(W * W + H * H) / 2; // centre to corner
    for (let i = 0; i < pulses.length; i++) {
      const p = pulses[i];
      if (!p.on) continue;
      const t = p.age / p.life;
      const fade = (1 - t) * (1 - t);
      if (reduced) {
        // No expansion: just a soft swell of light that fades.
        const r = reach * 0.9;
        drawSprite(ctx, dpr, dpr, glowSprite, cx, cy, r, r, p.s * 0.3 * fade);
        continue;
      }
      const e = 1 - Math.pow(1 - t, 3); // ease-out
      const r = reach * (0.45 + 0.75 * e) * (0.75 + 0.5 * p.s);
      drawSprite(ctx, dpr, dpr, glowSprite, cx, cy, r, r, p.s * 0.42 * fade);
      const rr = reach * (0.08 + 1.1 * e);
      drawSprite(ctx, dpr, dpr, ringSprite, cx, cy, rr, rr, p.s * 0.5 * (1 - t));
    }
  }

  // ---------------------------------------------------------------
  // Size / environment
  // ---------------------------------------------------------------
  function applySize(force) {
    let cw = canvas.clientWidth;
    let ch = canvas.clientHeight;
    if (!cw || !ch) {
      cw = window.innerWidth;
      ch = window.innerHeight;
    }
    if (!cw || !ch) return;
    const nd = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const pw = Math.round(cw * nd);
    const ph = Math.round(ch * nd);
    if (!force && cw === W && ch === H && nd === dpr && canvas.width === pw && canvas.height === ph) return;
    W = cw;
    H = ch;
    dpr = nd;
    // Resizing clears the canvas (and its state), so only touch it if needed.
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    // Nebula buffer: ~1/3 resolution (capped), it is all soft light anyway.
    const k = Math.min(NEB_SCALE, Math.sqrt(NEB_MAX_AREA / (W * H)));
    const nw = Math.max(1, Math.ceil(W * k));
    const nh = Math.max(1, Math.ceil(H * k));
    nebKx = nw / W;
    nebKy = nh / H;
    if (!neb) {
      neb = makeCanvas(nw, nh);
      nebCtx = neb.getContext("2d", { alpha: false }) || neb.getContext("2d");
    }
    if (neb.width !== nw) neb.width = nw;
    if (neb.height !== nh) neb.height = nh;
    nebDirty = true;
    baseGrad = nebCtx.createLinearGradient(0, 0, 0, H);
    baseGrad.addColorStop(0, "#0e0b22");
    baseGrad.addColorStop(0.45, "#120e26");
    baseGrad.addColorStop(1, "#170f2c");
    if (grain) grain.pattern = null; // patterns belong to the context state
    fitStars();
    if (coinDpr !== dpr) buildCoinSprites();
    dirty = true;
    // Repaint right away: a resized canvas is blank until the next frame.
    draw();
    dirty = false;
    sinceDraw = 0;
  }

  function setReduced(on) {
    reduced = Boolean(on);
    if (reduced) {
      coins.length = 0;
      shoot.on = false;
    }
    dirty = nebDirty = true;
  }

  function watchReducedMotion() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------
  const api = {
    init(el, opts) {
      try {
        if (ready) return;
        el = el || document.getElementById("bg");
        if (!el || !el.getContext) return;
        canvas = el;
        // Opaque canvas: cheaper to composite, and we paint every pixel anyway.
        ctx = canvas.getContext("2d", { alpha: false }) || canvas.getContext("2d");
        if (!ctx) return;
        canvas.setAttribute("aria-hidden", "true");

        watchReducedMotion();
        buildStaticSprites();

        const src = (opts && opts.coinSrc) || "coin.png";
        coinImg = new Image();
        coinImg.onload = () => {
          try {
            buildCoinSprites();
          } catch (_) {
            /* no coins then */
          }
        };
        coinImg.src = src;

        ready = true;
        applySize(true);

        window.addEventListener("resize", api.resize);
        window.addEventListener("orientationchange", api.resize);
        // Also watch the canvas box itself: catches size changes that come
        // without a window resize event, and never forces a layout.
        if (window.ResizeObserver) new ResizeObserver(api.resize).observe(canvas);
        // Context loss (Android can drop GPU canvases in the background):
        // sprites with lost pixels get rebuilt and the scene repainted.
        canvas.addEventListener("contextrestored", () => {
          try {
            buildStaticSprites();
            if (nebReady) paintNebula();
            buildCoinSprites();
            applySize(true);
          } catch (_) {
            /* ignore */
          }
        });
        document.addEventListener("visibilitychange", () => {
          dirty = nebDirty = true;
        });
      } catch (err) {
        ready = false;
        if (window.console) console.warn("DCBackground.init failed", err);
      }
    },

    step(dt) {
      try {
        if (!ready) return;
        dt = dt > 0 ? Math.min(dt, 0.1) : 0;
        update(dt);
        if (reduced) {
          // Static scene: repaint only on change (plus a slow safety repaint).
          sinceDraw += dt;
          if (!dirty && sinceDraw < 2) return;
          if (sinceDraw >= 2) nebDirty = true;
          dirty = false;
          sinceDraw = 0;
        }
        draw();
      } catch (err) {
        /* never break the game's loop */
      }
    },

    resize() {
      try {
        if (ready) applySize(false);
      } catch (_) {
        /* ignore */
      }
    },

    setProduction(perSec) {
      try {
        const n = Number(perSec);
        production = n > 0 ? n : 0; // NaN / negative -> 0; Infinity -> max rain
      } catch (_) {
        /* ignore */
      }
    },

    setMode(m) {
      try {
        mode = m === "frenzy" || m === "clickfrenzy" ? m : "normal";
      } catch (_) {
        /* ignore */
      }
    },

    pulse(strength) {
      try {
        const s = clamp(Number(strength) || 0, 0, 1);
        if (s <= 0) return;
        // Reuse a free slot, or the oldest one.
        let slot = pulses[0];
        for (let i = 0; i < pulses.length; i++) {
          const p = pulses[i];
          if (!p.on) {
            slot = p;
            break;
          }
          if (p.age / p.life > slot.age / slot.life) slot = p;
        }
        slot.on = true;
        slot.age = 0;
        slot.life = 0.9 + 0.7 * s;
        slot.s = s;
        dirty = true;
      } catch (_) {
        /* ignore */
      }
    },

    setAccent(css) {
      try {
        const c = parseColor(css);
        if (!c) return;
        if (accentColor && c[0] === accentColor[0] && c[1] === accentColor[1] && c[2] === accentColor[2]) return;
        accentColor = c;
        if (!nebReady) return; // painted with the rest of the nebula
        // Start the cross-fade from whatever is most visible right now.
        accentFrom = accentMix >= 0.5 || !accentFrom ? accentTo : accentFrom;
        accentTo = paintAccent(c);
        accentMix = 0;
        dirty = nebDirty = true;
      } catch (_) {
        /* ignore */
      }
    },
  };

  window.DCBackground = api;
})();
