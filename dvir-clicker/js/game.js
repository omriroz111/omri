// Dvir Clicker: game state, economy, UI and effects.
// Uses window.DCData (balance), and the optional modules DCAudio, DCBackground
// and DCSkins; the game still runs (silently / plainly) if one fails to load.
(() => {
  "use strict";

  const D = window.DCData;
  const noop = () => {};
  const Audio = window.DCAudio || {
    init: noop, setSfxEnabled: noop, setMusicEnabled: noop, setIntensity: noop, pause: noop, resume: noop, play: noop,
  };
  const BG = window.DCBackground || {
    init: noop, step: noop, resize: noop, setProduction: noop, setMode: noop, pulse: noop, setAccent: noop,
  };
  const Skins = window.DCSkins || {
    frames: [{ id: "gold", name: "זהב", swatch: "#ffc42e" }],
    accessories: [{ id: "none", name: "בלי אביזר", icon: "🚫", svg: "" }],
    applyFrame(el, id) {
      el.className = el.className.replace(/\bframe-\S+/g, "").trim() + " frame-" + id;
    },
    renderAccessory(el) {
      el.innerHTML = "";
    },
  };

  // ---------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------
  const SAVE_KEY = "dvir-clicker-save-v1";
  const COST_GROWTH = 1.15;
  const OFFLINE_CAP_SECONDS = 8 * 60 * 60;
  const STAR_UNIT = 1e6; // lifetime דבירים for the first star; stars grow with the square root
  const STAR_BONUS = 0.1;
  const ACH_BONUS = 0.01;
  const CRIT_CHANCE = 0.02;
  const CRIT_MULT = 10;
  const FRENZY_MULT = 7;
  const CLICK_FRENZY_MULT = 10;
  const COMBO_WINDOW_MS = 380;

  const BUILDINGS = D.BUILDINGS;
  const UPGRADES = D.UPGRADES;
  const UPG = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
  const ACHS = D.ACHIEVEMENTS;
  const ACH = Object.fromEntries(ACHS.map((a) => [a.id, a]));
  const SKIN_KEYS = Object.keys(D.SKIN_RULES);

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nativeApp = window.DvirAndroid;
  const canVibrate = Boolean(nativeApp) || typeof navigator.vibrate === "function";

  // ---------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------
  const defaults = () => ({
    v: 2,
    count: 0,
    runEarned: 0,
    totalEarned: 0,
    totalClicks: 0,
    owned: {},
    upgrades: [],
    achievements: [],
    seenAch: [],
    stars: 0,
    rebirths: 0,
    golden: 0,
    crits: 0,
    maxCombo: 0,
    skins: ["frame:gold", "acc:none"],
    frame: "gold",
    accessory: "none",
    milestone: 0,
    sound: true,
    music: true,
    vibe: true,
    buyAmount: "1",
    playTime: 0,
    lastSeen: Date.now(),
  });

  let state = defaults();
  let upgSet = new Set();
  let achSet = new Set();
  let skinSet = new Set();

  const num = (v, d = 0) => (typeof v === "number" && isFinite(v) && v >= 0 ? v : d);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
    } catch (_) {
      /* storage blocked or corrupted: start fresh */
    }
    if (!saved || typeof saved !== "object") return;
    const d = defaults();
    const owned = {};
    for (const b of BUILDINGS) owned[b.id] = Math.floor(num(saved.owned && saved.owned[b.id]));
    state = {
      ...d,
      count: num(saved.count),
      totalEarned: num(saved.totalEarned),
      // v1 saves had no runs yet, so the whole history is the current run.
      runEarned: saved.v ? num(saved.runEarned) : num(saved.totalEarned),
      totalClicks: Math.floor(num(saved.totalClicks)),
      owned,
      upgrades: arr(saved.upgrades).filter((id) => UPG[id]),
      achievements: arr(saved.achievements).filter((id) => ACH[id]),
      seenAch: arr(saved.seenAch),
      stars: Math.floor(num(saved.stars)),
      rebirths: Math.floor(num(saved.rebirths)),
      golden: Math.floor(num(saved.golden)),
      crits: Math.floor(num(saved.crits)),
      maxCombo: Math.floor(num(saved.maxCombo)),
      skins: Array.from(new Set([...d.skins, ...arr(saved.skins).filter((k) => D.SKIN_RULES[k])])),
      frame: typeof saved.frame === "string" ? saved.frame : d.frame,
      accessory: typeof saved.accessory === "string" ? saved.accessory : d.accessory,
      milestone: Math.floor(num(saved.milestone)),
      sound: saved.sound !== false,
      music: saved.music !== false,
      vibe: saved.vibe !== false,
      buyAmount: ["1", "10", "max"].includes(saved.buyAmount) ? saved.buyAmount : "1",
      playTime: num(saved.playTime),
      lastSeen: num(saved.lastSeen, Date.now()),
    };
    if (!state.skins.includes("frame:" + state.frame)) state.frame = "gold";
    if (!state.skins.includes("acc:" + state.accessory)) state.accessory = "none";
  }

  function syncSets() {
    upgSet = new Set(state.upgrades);
    achSet = new Set(state.achievements);
    skinSet = new Set(state.skins);
  }

  function save() {
    state.lastSeen = Date.now();
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    } catch (_) {
      /* storage blocked: progress just won't persist */
    }
  }

  const owned = (b) => state.owned[b.id] || 0;

  function earn(n) {
    if (!(n > 0)) return;
    state.count += n;
    state.runEarned += n;
    state.totalEarned += n;
  }

  // ---------------------------------------------------------------
  // Derived numbers
  // ---------------------------------------------------------------
  const R = { perSec: 0, perSecBase: 0, perClick: 1, clickPct: 0, tiers: {}, global: 1 };
  const buffs = {}; // type -> { until, dur } in performance.now() ms

  const buffOn = (type) => Boolean(buffs[type]);
  const has = (id) => upgSet.has(id);
  const unitMult = () => R.global * (1 + ACH_BONUS * state.achievements.length) * (1 + STAR_BONUS * state.stars);

  function recalc() {
    const tiers = {};
    let global = 1;
    let clickPct = 0;
    for (const id of state.upgrades) {
      const u = UPG[id];
      if (!u) continue;
      if (u.kind === "building") tiers[u.target] = (tiers[u.target] || 0) + 1;
      else if (u.kind === "global") global *= u.value;
      else if (u.kind === "clickPct") clickPct += u.value;
    }
    let secBase = 0;
    let clickBase = 1;
    for (const b of BUILDINGS) {
      const n = owned(b);
      if (!n) continue;
      const m = Math.pow(2, tiers[b.id] || 0);
      if (b.sec) secBase += b.sec * n * m;
      if (b.click) clickBase += b.click * n * m;
    }
    const starMult = 1 + STAR_BONUS * state.stars;
    const achMult = 1 + ACH_BONUS * state.achievements.length;
    R.tiers = tiers;
    R.global = global;
    R.clickPct = clickPct;
    R.perSecBase = secBase * global * achMult * starMult;
    R.perSec = R.perSecBase * (buffOn("frenzy") ? FRENZY_MULT : 1);
    R.perClick = (clickBase * starMult + R.perSec * clickPct) * (buffOn("clickfrenzy") ? CLICK_FRENZY_MULT : 1);
  }

  // ---------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------
  const BIG = [
    [1e33, "דציליון"],
    [1e30, "נוניליון"],
    [1e27, "אוקטיליון"],
    [1e24, "ספטיליון"],
    [1e21, "סקסטיליון"],
    [1e18, "קווינטיליון"],
    [1e15, "קוודריליון"],
    [1e12, "טריליון"],
    [1e9, "מיליארד"],
    [1e6, "מיליון"],
  ];
  const intFmt = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });

  // Small non-integers keep one decimal ("2.5 לשנייה"); counts are floored by the caller.
  function fmt(n) {
    if (!isFinite(n)) return "∞";
    if (n >= 1e36) return n.toExponential(2).replace("e+", "e");
    for (const [v, word] of BIG) {
      if (n >= v) return (n / v).toFixed(2).replace(/\.?0+$/, "") + " " + word;
    }
    if (n < 100 && n % 1 > 0.05) return n.toFixed(1);
    return intFmt.format(Math.floor(n));
  }

  // Wrap in LRI/PDI so "+5" stays "+5" inside right-to-left text.
  const ltr = (text) => "⁦" + text + "⁩";
  const plus = (n) => ltr("+" + fmt(n));

  // ---------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const clickerEl = $("clicker");
  const dvir = $("dvir");
  const dvirBody = $("dvirBody");
  const dvirSpin = $("dvirSpin");
  const accessoryEl = $("accessory");
  const countEl = $("count");
  const ratesEl = $("rates");
  const perClickEl = $("perClick");
  const perSecEl = $("perSec");
  const starsRateEl = $("starsRate");
  const starsCountEl = $("starsCount");
  const comboEl = $("combo");
  const hintEl = $("hint");
  const buffsEl = $("buffs");
  const toastEl = $("toast");
  const bannerEl = $("achBanner");
  const goldenLayer = $("goldenLayer");
  const flashEl = $("flash");
  const splashEl = $("splash");
  const soundToggle = $("soundToggle");
  const musicToggle = $("musicToggle");
  const vibeToggle = $("vibeToggle");

  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[(Math.random() * list.length) | 0];

  function restartAnim(node, cls) {
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  // ---------------------------------------------------------------
  // Feedback: sound + vibration
  // ---------------------------------------------------------------
  const sfx = (name, opts) => {
    try {
      Audio.play(name, opts);
    } catch (_) {}
  };

  // Browsers block (and log) vibration before the first user gesture.
  let touched = false;
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, () => (touched = true), { capture: true, passive: true });
  }

  function vibrate(pattern) {
    if (!canVibrate || !state.vibe || (!touched && !nativeApp)) return;
    try {
      if (nativeApp) nativeApp.vibrate(String(pattern));
      else navigator.vibrate(pattern);
    } catch (_) {}
  }

  // ---------------------------------------------------------------
  // Effects canvas: particles, floating numbers, rings, confetti, stars
  // ---------------------------------------------------------------
  const canvas = $("fx");
  const ctx = canvas.getContext("2d");
  const coinImg = new Image();
  coinImg.src = "./coin.png";
  let dpr = 1;
  let W = 0;
  let H = 0;
  const particles = [];
  const MAX_PARTICLES = reduceMotion ? 160 : 800;
  const CONFETTI = ["#ffc42e", "#ff4f8b", "#3ae0ff", "#7cff6b", "#b388ff", "#ffffff", "#ff8a3d"];

  const STAR_PATH = (() => {
    const p = new Path2D();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 0.45 : 1;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      p[i ? "lineTo" : "moveTo"](Math.cos(a) * r, Math.sin(a) * r);
    }
    p.closePath();
    return p;
  })();

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    moveTabIndicator();
  }

  function add(p) {
    if (particles.length >= MAX_PARTICLES) particles.shift();
    particles.push(p);
  }

  function burst(x, y, amount, coins = 0, colors = CONFETTI) {
    for (let i = 0; i < amount; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(180, 520);
      add({
        kind: Math.random() < 0.6 ? "rect" : "dot",
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 120,
        g: 950, drag: 1.6,
        size: rand(5, 10),
        rot: rand(0, Math.PI), vr: rand(-12, 12),
        color: pick(colors),
        life: rand(0.55, 0.95), age: 0,
      });
    }
    for (let i = 0; i < coins; i++) {
      const angle = rand(-Math.PI * 0.85, -Math.PI * 0.15);
      const speed = rand(260, 480);
      add({
        kind: "coin", x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        g: 1100, drag: 1.2,
        size: rand(24, 34), spin: rand(6, 11), phase: rand(0, Math.PI * 2),
        life: rand(0.8, 1.1), age: 0,
      });
    }
    add({ kind: "ring", x, y, life: 0.4, age: 0, size: 70, color: "#fff3c4" });
  }

  function starBurst(x, y, amount, power = 1) {
    for (let i = 0; i < amount; i++) {
      const angle = rand(0, Math.PI * 2);
      const speed = rand(160, 560) * power;
      add({
        kind: "star", x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 80,
        g: 420, drag: 1.4,
        size: rand(7, 15), rot: rand(0, Math.PI), vr: rand(-6, 6),
        color: Math.random() < 0.75 ? "#ffe066" : "#ffffff",
        life: rand(0.8, 1.4), age: 0,
      });
    }
  }

  function sparkle(x, y) {
    add({
      kind: "spark",
      x: x + rand(-46, 46), y: y + rand(-46, 46),
      vx: rand(-20, 20), vy: rand(-50, -10), g: 0, drag: 0.5,
      size: rand(5, 11), color: Math.random() < 0.6 ? "#fff6c9" : "#ffd23f",
      life: rand(0.4, 0.8), age: 0,
    });
  }

  function floatText(x, y, text, opts = {}) {
    add({
      kind: "text",
      x: x + rand(-18, 18), y: y - 10,
      vx: rand(-30, 30), vy: -(opts.speed || rand(140, 190)),
      g: 0, drag: 0.8,
      text,
      size: opts.size || 30,
      fill: opts.fill || "#ffe066",
      stroke: opts.stroke || "#3a1d00",
      dir: opts.dir || "ltr",
      life: opts.life || 1, age: 0,
    });
  }

  function confettiRain(amount, coinsShare = 0.25) {
    for (let i = 0; i < amount; i++) {
      const isCoin = Math.random() < coinsShare;
      add({
        kind: isCoin ? "coin" : "rect",
        spin: rand(3, 7),
        x: rand(0, W), y: rand(-H * 0.4, -10),
        vx: rand(-60, 60), vy: rand(80, 260),
        g: 260, drag: 0.9,
        size: isCoin ? rand(26, 40) : rand(7, 13),
        rot: rand(0, Math.PI), vr: rand(-8, 8),
        sway: rand(1.5, 4), phase: rand(0, Math.PI * 2),
        color: pick(CONFETTI),
        life: rand(2.6, 3.6), age: 0,
      });
    }
  }

  function stepParticles(dt) {
    ctx.clearRect(0, 0, W, H);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        particles.splice(i, 1);
        continue;
      }
      const t = p.age / p.life;

      if (p.kind === "ring") {
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 4 * (1 - t) + 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12 + p.size * (1 - Math.pow(1 - t, 3)), 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      p.vy += p.g * dt;
      p.vx -= p.vx * p.drag * dt;
      p.vy -= p.vy * p.drag * dt * 0.5;
      p.x += p.vx * dt + (p.sway ? Math.sin(p.age * p.sway + p.phase) * 1.2 : 0);
      p.y += p.vy * dt;

      if (p.kind === "text") {
        const pop = t < 0.12 ? 0.6 + (t / 0.12) * 0.55 : 1.15 - Math.min(0.15, (t - 0.12) * 0.6);
        ctx.globalAlpha = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(pop, pop);
        ctx.font = `900 ${p.size}px Rubik, system-ui, sans-serif`;
        ctx.direction = p.dir;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(5, p.size / 5);
        ctx.strokeStyle = p.stroke;
        ctx.strokeText(p.text, 0, 0);
        ctx.fillStyle = p.fill;
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
        continue;
      }

      ctx.globalAlpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;

      if (p.kind === "coin") {
        const half = p.size / 2;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(Math.max(0.08, Math.abs(Math.cos(p.age * p.spin + p.phase))), 1);
        if (coinImg.complete && coinImg.naturalWidth) ctx.drawImage(coinImg, -half, -half, p.size, p.size);
        ctx.restore();
        continue;
      }

      if (p.kind === "star" || p.kind === "spark") {
        ctx.save();
        ctx.translate(p.x, p.y);
        if (p.kind === "star") {
          p.rot += p.vr * dt;
          ctx.rotate(p.rot);
          ctx.scale(p.size, p.size);
          ctx.fillStyle = p.color;
          ctx.fill(STAR_PATH);
        } else {
          // Four-point twinkle that grows then shrinks.
          const s = p.size * Math.sin(Math.PI * t);
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(0, -s);
          ctx.lineTo(s * 0.22, 0);
          ctx.lineTo(0, s);
          ctx.lineTo(-s * 0.22, 0);
          ctx.closePath();
          ctx.moveTo(-s, 0);
          ctx.lineTo(0, s * 0.22);
          ctx.lineTo(s, 0);
          ctx.lineTo(0, -s * 0.22);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        continue;
      }

      ctx.fillStyle = p.color;
      if (p.kind === "dot") {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        p.rot += p.vr * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        // Squash the width over time so confetti looks like it flips.
        ctx.scale(Math.cos(p.age * 9 + p.rot), 1);
        ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  const centerOf = (node) => {
    const r = node.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };

  // ---------------------------------------------------------------
  // Springs (Dvir squish, counter pop) and screen shake
  // ---------------------------------------------------------------
  const squish = { s: 0, v: 0, r: 0, vr: 0 };
  const pop = { s: 0, v: 0 };
  let trauma = 0;

  function stepSprings(dt) {
    // Underdamped springs so rapid clicks pile up and bounce back.
    squish.v += (-520 * squish.s - 20 * squish.v) * dt;
    squish.s = Math.max(-0.2, Math.min(0.15, squish.s + squish.v * dt));
    squish.vr += (-320 * squish.r - 14 * squish.vr) * dt;
    squish.r = Math.max(-12, Math.min(12, squish.r + squish.vr * dt));
    const still = Math.abs(squish.s) < 1e-4 && Math.abs(squish.v) < 1e-3 && Math.abs(squish.r) < 1e-2;
    dvirBody.style.transform = still ? "" : `scale(${1 + squish.s}) rotate(${squish.r}deg)`;

    pop.v += (-600 * pop.s - 22 * pop.v) * dt;
    pop.s = Math.max(-0.1, Math.min(0.35, pop.s + pop.v * dt));
    countEl.style.transform = Math.abs(pop.s) < 1e-3 && Math.abs(pop.v) < 1e-2 ? "" : `scale(${1 + pop.s})`;
  }

  function stepShake(dt) {
    if (reduceMotion || trauma <= 0) {
      if (app.style.transform) app.style.transform = "";
      trauma = 0;
      return;
    }
    trauma = Math.max(0, trauma - dt * 1.5);
    const k = trauma * trauma;
    app.style.transform = `translate(${16 * k * rand(-1, 1)}px, ${16 * k * rand(-1, 1)}px) rotate(${1.4 * k * rand(-1, 1)}deg)`;
  }

  function shake(amount, cap = 1) {
    if (trauma < cap) trauma = Math.min(cap, trauma + amount);
  }

  // ---------------------------------------------------------------
  // Toast, achievement banner, modal
  // ---------------------------------------------------------------
  let toastTimer = 0;
  function toast(text, ms = 2600) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  const bannerQueue = [];
  let bannerBusy = false;
  function banner(icon, small, title, sub) {
    bannerQueue.push({ icon, small, title, sub });
    if (!bannerBusy) nextBanner();
  }
  function nextBanner() {
    const b = bannerQueue.shift();
    if (!b) {
      bannerBusy = false;
      return;
    }
    bannerBusy = true;
    bannerEl.innerHTML = "";
    const ico = el("div", "a-ico");
    ico.textContent = b.icon;
    const txt = el("div");
    txt.style.minWidth = "0";
    const title = el("b");
    const small = el("small");
    small.textContent = b.small + " ";
    title.append(small, document.createTextNode(b.title));
    const sub = el("span");
    sub.textContent = b.sub;
    txt.append(title, sub);
    bannerEl.append(ico, txt);
    restartAnim(bannerEl, "show");
    setTimeout(() => {
      bannerEl.classList.remove("show");
      setTimeout(nextBanner, 550);
    }, 2700);
  }

  const modal = $("modal");
  let modalResolve = null;
  function confirmModal({ icon, title, text, ok, okClass = "primary" }) {
    $("modalIcon").textContent = icon;
    $("modalTitle").textContent = title;
    $("modalText").textContent = text;
    const okBtn = $("modalOk");
    okBtn.textContent = ok;
    okBtn.className = "btn " + okClass;
    modal.classList.add("show");
    setTimeout(() => okBtn.focus(), 50);
    return new Promise((resolve) => {
      modalResolve = resolve;
    });
  }
  function closeModal(result) {
    modal.classList.remove("show");
    if (modalResolve) modalResolve(result);
    modalResolve = null;
  }
  $("modalOk").addEventListener("click", () => closeModal(true));
  $("modalCancel").addEventListener("click", () => closeModal(false));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("show")) closeModal(false);
  });

  // ---------------------------------------------------------------
  // Clicking
  // ---------------------------------------------------------------
  let combo = 0;
  let lastClickAt = 0;
  let comboTimer = 0;
  let lastActiveClick = performance.now();
  const recentClicks = [];
  let burstBest = 0;

  function hit(x, y) {
    const now = performance.now();
    combo = now - lastClickAt < COMBO_WINDOW_MS ? combo + 1 : 1;
    lastClickAt = now;
    lastActiveClick = now;
    if (combo > state.maxCombo) state.maxCombo = combo;
    recentClicks.push(now);
    while (recentClicks[0] < now - 1000) recentClicks.shift();
    burstBest = Math.max(burstBest, recentClicks.length);

    const crit = Math.random() < CRIT_CHANCE;
    const gain = R.perClick * (crit ? CRIT_MULT : 1);
    earn(gain);
    state.totalClicks += 1;
    if (crit) state.crits += 1;

    // Squish + tilt toward the side that was hit.
    const rect = dvir.getBoundingClientRect();
    const dx = (x - (rect.left + rect.width / 2)) / (rect.width / 2);
    squish.v -= crit ? 5 : 3.2;
    squish.vr += dx * (crit ? 180 : 110);
    pop.v += crit ? 7 : 2.4;

    const c = Math.min(combo, 24);
    const clickFrenzy = buffOn("clickfrenzy");
    if (crit) {
      floatText(x, y - 64, "קריטי!", { size: 30, fill: "#fff3c4", stroke: "#3a0d00", speed: 120, life: 1.3, dir: "rtl" });
      floatText(x, y - 20, "+" + fmt(gain), { size: 42, fill: "#ff9a3d", stroke: "#3a0d00", speed: 120, life: 1.3 });
      starBurst(x, y, reduceMotion ? 6 : 22);
      burst(x, y, reduceMotion ? 6 : 26, reduceMotion ? 2 : 8);
      sfx("crit");
      vibrate(30);
      shake(0.45);
    } else {
      floatText(x, y, "+" + fmt(gain), clickFrenzy ? { size: 36, fill: "#ff8fc0", stroke: "#4a0020" } : { size: combo >= 15 ? 38 : 30 });
      burst(x, y, reduceMotion ? 4 : 8 + Math.round(c / 2), reduceMotion ? 1 : 2 + Math.round(c / 8));
      sfx("pop", { combo });
      vibrate(combo >= 10 ? 18 : 10);
    }

    if (combo >= 6) shake(0.05 + c * 0.006, 0.5);

    if (combo >= 5) {
      comboEl.textContent = `🔥 קומבו x${combo}`;
      comboEl.classList.add("show");
      comboEl.classList.toggle("hot", combo >= 25);
    }
    clearTimeout(comboTimer);
    comboTimer = setTimeout(() => {
      comboEl.classList.remove("show");
      combo = 0;
    }, 700);

    if (!hintEl.classList.contains("gone")) hintEl.classList.add("gone");
    renderScore();
  }

  dvir.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    Audio.init();
    hit(e.clientX, e.clientY);
  });

  // Keyboard players: Space / Enter, one hit per key press.
  dvir.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (e.repeat) return;
    const r = dvir.getBoundingClientRect();
    hit(r.left + r.width / 2 + rand(-r.width / 5, r.width / 5), r.top + r.height / 2 + rand(-r.height / 5, r.height / 5));
  });
  dvir.addEventListener("click", (e) => e.preventDefault());
  dvir.addEventListener("contextmenu", (e) => e.preventDefault());

  // ---------------------------------------------------------------
  // Buffs (from golden Dvir)
  // ---------------------------------------------------------------
  const BUFF_INFO = {
    frenzy: { icon: "🔥", label: `טירוף ×${FRENZY_MULT}`, cls: "" },
    clickfrenzy: { icon: "⚡", label: `לחיצות ×${CLICK_FRENZY_MULT}`, cls: "click" },
  };
  const buffEls = {};

  function addBuff(type, seconds) {
    const dur = seconds * 1000 * (has("gold-long") ? 2 : 1);
    buffs[type] = { until: performance.now() + dur, dur };
    recalc();
    applyMood();
    renderBuffs();
    renderRates();
  }

  function updateBuffs(now) {
    let changed = false;
    for (const type of Object.keys(buffs)) {
      if (now >= buffs[type].until) {
        delete buffs[type];
        changed = true;
      }
    }
    if (changed) {
      recalc();
      applyMood();
      renderRates();
    }
  }

  function applyMood() {
    const mode = buffOn("clickfrenzy") ? "clickfrenzy" : buffOn("frenzy") ? "frenzy" : "normal";
    BG.setMode(mode);
    Audio.setIntensity(mode === "normal" ? 0 : 1);
    clickerEl.classList.toggle("boosted", mode !== "normal");
    ratesEl.classList.toggle("boosted", mode !== "normal");
  }

  function renderBuffs() {
    const now = performance.now();
    for (const type of Object.keys(BUFF_INFO)) {
      const b = buffs[type];
      let node = buffEls[type];
      if (!b) {
        if (node) {
          node.remove();
          delete buffEls[type];
        }
        continue;
      }
      if (!node) {
        const info = BUFF_INFO[type];
        node = el("div", "buff " + info.cls, `<span>${info.icon}</span><span>${info.label}</span><span class="t"></span><i class="buff-bar"></i>`);
        buffsEl.appendChild(node);
        buffEls[type] = node;
      }
      const left = Math.max(0, b.until - now);
      node.querySelector(".t").textContent = Math.ceil(left / 1000) + "s";
      node.querySelector(".buff-bar").style.transform = `scaleX(${left / b.dur})`;
    }
  }

  // ---------------------------------------------------------------
  // Golden Dvir + coin rain
  // ---------------------------------------------------------------
  let golden = null;
  let goldenTimer = rand(25, 45);
  const rainCoins = [];
  let rainLeft = 0;
  let rainSpawnTimer = 0;

  const nextGoldenDelay = () => rand(55, 130) / (has("gold-luck") ? 2 : 1);

  function spawnGolden() {
    const node = el("button", "golden", '<img src="./coin.png" alt="" draggable="false" />');
    node.setAttribute("aria-label", "דביר זהב! ללחוץ מהר");
    const margin = 70;
    golden = {
      node,
      bx: rand(margin, Math.max(margin + 1, W - margin)),
      by: rand(Math.max(margin, H * 0.15), Math.max(margin + 1, H * 0.78)),
      age: 0,
      life: 13 * (has("gold-stay") ? 2 : 1),
      phase: rand(0, Math.PI * 2),
      sparkT: 0,
      x: 0,
      y: 0,
    };
    node.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      catchGolden();
    });
    node.addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        catchGolden();
      }
    });
    goldenLayer.appendChild(node);
    sfx("goldenSpawn");
  }

  function stepGolden(dt) {
    if (!golden) {
      if (splashEl && !splashEl.classList.contains("out")) return;
      goldenTimer -= dt;
      if (goldenTimer <= 0) spawnGolden();
      return;
    }
    const g = golden;
    g.age += dt;
    if (g.age >= g.life) {
      g.node.remove();
      golden = null;
      goldenTimer = nextGoldenDelay();
      return;
    }
    const appear = Math.min(1, g.age / 0.55);
    // Ease-out-back for the entrance, then a gentle breathing scale.
    const back = 1 + 2.2 * Math.pow(appear - 1, 3) + 1.2 * Math.pow(appear - 1, 2);
    const scale = back * (1 + 0.06 * Math.sin(g.age * 4));
    const leaving = g.life - g.age < 2;
    const alpha = leaving ? 0.35 + 0.65 * Math.abs(Math.cos(g.age * 9)) : 1;
    g.x = g.bx + Math.sin(g.age * 0.9 + g.phase) * 26;
    g.y = g.by + Math.cos(g.age * 1.3 + g.phase) * 18;
    g.node.style.transform = `translate(${g.x}px, ${g.y}px) scale(${scale}) rotate(${Math.sin(g.age * 2.2) * 12}deg)`;
    g.node.style.opacity = alpha;
    g.sparkT -= dt;
    if (g.sparkT <= 0 && !reduceMotion) {
      g.sparkT = 0.09;
      sparkle(g.x, g.y);
    }
  }

  function catchGolden() {
    if (!golden) return;
    Audio.init();
    const { x, y, node } = golden;
    node.remove();
    golden = null;
    goldenTimer = nextGoldenDelay();
    state.golden += 1;

    starBurst(x, y, reduceMotion ? 8 : 30, 1.2);
    burst(x, y, reduceMotion ? 8 : 30, reduceMotion ? 3 : 12, ["#ffc42e", "#fff3c4", "#ffe066", "#ff9a1f"]);
    sfx("goldenCatch");
    vibrate([30, 40, 60]);
    shake(0.5);
    BG.pulse(0.45);

    const pool = [
      ["lucky", 50],
      ["frenzy", R.perSecBase >= 1 ? 25 : 0],
      ["clickfrenzy", 15],
      ["rain", 10],
    ];
    let roll = Math.random() * pool.reduce((s, p) => s + p[1], 0);
    let effect = "lucky";
    for (const [name, w] of pool) {
      if ((roll -= w) < 0) {
        effect = name;
        break;
      }
    }

    if (effect === "lucky") {
      const gain = Math.max(R.perClick * 30, Math.min(state.count * 0.15, R.perSecBase * 900)) + 13;
      earn(gain);
      floatText(x, y, "+" + fmt(gain), { size: 44, speed: 110, life: 1.5 });
      toast(`🍀 מזל! ${plus(gain)} דבירים`);
      restartAnim(countEl, "flash-gold");
      pop.v += 8;
    } else if (effect === "frenzy") {
      addBuff("frenzy", 30);
      sfx("frenzyStart");
      toast(`🔥 טירוף! הייצור פי ${FRENZY_MULT}`);
    } else if (effect === "clickfrenzy") {
      addBuff("clickfrenzy", 15);
      sfx("frenzyStart");
      toast(`⚡ טירוף לחיצות! כל לחיצה פי ${CLICK_FRENZY_MULT}`);
    } else {
      rainLeft = 26;
      rainSpawnTimer = 0;
      toast("🪙 גשם מטבעות! תפסו כמה שיותר");
    }
    renderScore();
  }

  function spawnRainCoin() {
    const node = el("button", "rain-coin", '<img src="./coin.png" alt="" draggable="false" />');
    node.setAttribute("aria-label", "מטבע");
    const c = {
      node,
      x: rand(30, Math.max(31, W - 30)),
      y: -40,
      vy: rand(130, 210),
      phase: rand(0, Math.PI * 2),
      spin: rand(3, 6),
      age: 0,
    };
    node.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      collectRainCoin(c);
    });
    goldenLayer.appendChild(node);
    rainCoins.push(c);
  }

  function collectRainCoin(c) {
    const i = rainCoins.indexOf(c);
    if (i < 0) return;
    rainCoins.splice(i, 1);
    c.node.remove();
    const gain = Math.max(R.perSecBase * 4, R.perClick * 4) + 5;
    earn(gain);
    floatText(c.x, c.y, "+" + fmt(gain), { size: 30 });
    burst(c.x, c.y, reduceMotion ? 3 : 10, 0, ["#ffc42e", "#fff3c4", "#ffe066"]);
    sfx("pop", { combo: 22 });
    vibrate(12);
    pop.v += 2;
    renderScore();
  }

  function stepRain(dt) {
    if (rainLeft > 0) {
      rainSpawnTimer -= dt;
      if (rainSpawnTimer <= 0) {
        rainSpawnTimer = 0.24;
        rainLeft -= 1;
        spawnRainCoin();
      }
    }
    for (let i = rainCoins.length - 1; i >= 0; i--) {
      const c = rainCoins[i];
      c.age += dt;
      c.y += c.vy * dt;
      const x = c.x + Math.sin(c.age * 2 + c.phase) * 22;
      const flip = Math.max(0.15, Math.abs(Math.cos(c.age * c.spin + c.phase)));
      c.node.style.transform = `translate(${x}px, ${c.y}px) scaleX(${flip})`;
      if (c.y > H + 50) {
        c.node.remove();
        rainCoins.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------
  // Shop (buildings)
  // ---------------------------------------------------------------
  const itemsEl = $("items");
  const itemEls = {};

  const unitCost = (b) => b.base * Math.pow(COST_GROWTH, owned(b));
  const costFor = (b, n) => Math.ceil((unitCost(b) * (Math.pow(COST_GROWTH, n) - 1)) / (COST_GROWTH - 1));
  const maxAffordable = (b) =>
    Math.max(0, Math.floor(Math.log(1 + (state.count * (COST_GROWTH - 1)) / unitCost(b)) / Math.log(COST_GROWTH)));

  function buyCount(b) {
    if (state.buyAmount === "max") return Math.max(1, maxAffordable(b));
    return Number(state.buyAmount);
  }

  const isRevealed = (b, i) => i < 2 || owned(b) > 0 || state.totalEarned >= b.base * 0.5;

  for (const b of BUILDINGS) {
    const li = el("li");
    const btn = el(
      "button",
      "card",
      `<span class="card-icon" aria-hidden="true"></span>
       <span><span class="card-name"></span><span class="card-desc"></span>
       <span class="card-cost"><img class="coin" src="./coin.png" alt="" /><span class="c"></span><span class="amt"></span></span></span>
       <span class="card-owned"></span>`
    );
    btn.type = "button";
    btn.addEventListener("click", () => buyBuilding(b, btn));
    li.appendChild(btn);
    itemsEl.appendChild(li);
    itemEls[b.id] = {
      btn,
      icon: btn.querySelector(".card-icon"),
      name: btn.querySelector(".card-name"),
      desc: btn.querySelector(".card-desc"),
      cost: btn.querySelector(".c"),
      amt: btn.querySelector(".amt"),
      owned: btn.querySelector(".card-owned"),
    };
  }

  let shopKey = "";
  function renderShop(force) {
    const key = BUILDINGS.map((b, i) => {
      const n = buyCount(b);
      return [owned(b), n, state.count >= costFor(b, n), isRevealed(b, i), R.tiers[b.id] || 0].join();
    }).join("|") + state.buyAmount + state.stars + state.achievements.length + R.global;
    if (!force && key === shopKey) return;
    shopKey = key;
    const mult = unitMult();
    BUILDINGS.forEach((b, i) => {
      const e = itemEls[b.id];
      const revealed = isRevealed(b, i);
      const n = buyCount(b);
      const cost = costFor(b, n);
      const can = revealed && state.count >= cost;
      e.btn.classList.toggle("locked", !revealed);
      e.btn.classList.toggle("can", can);
      e.btn.disabled = !revealed;
      e.icon.textContent = b.icon;
      e.name.textContent = revealed ? b.name : "???";
      if (!revealed) {
        e.desc.textContent = "ממשיכים לאסוף כדי לגלות";
      } else {
        const m = Math.pow(2, R.tiers[b.id] || 0);
        const per = b.click ? b.click * m * (1 + STAR_BONUS * state.stars) : b.sec * m * mult;
        let text = `${plus(per)} ${b.click ? "ללחיצה" : "לשנייה"}`;
        if (owned(b)) text += ` · סה״כ ${fmt(per * owned(b))}`;
        e.desc.textContent = text;
      }
      e.cost.textContent = fmt(cost);
      e.amt.textContent = n > 1 ? ltr(` ×${n}`) : "";
      e.owned.textContent = owned(b) || "";
    });
  }

  function buyBuilding(b, btn) {
    const n = state.buyAmount === "max" ? maxAffordable(b) : Number(state.buyAmount);
    const cost = n > 0 ? costFor(b, n) : Infinity;
    if (n < 1 || state.count < cost) {
      restartAnim(btn, "deny");
      sfx("error");
      return;
    }
    Audio.init();
    state.count -= cost;
    state.owned[b.id] = owned(b) + n;
    recalc();
    sfx("buy");
    vibrate(25);
    restartAnim(btn, "bought");
    restartAnim(itemEls[b.id].owned, "pop");
    const [x, y] = centerOf(itemEls[b.id].icon);
    burst(x, y, reduceMotion ? 4 : 14, reduceMotion ? 0 : 3);
    renderShop(true);
    renderScore();
    renderRates();
    save();
  }

  const segEl = $("buyAmount");
  const segThumb = segEl.querySelector(".seg-thumb");
  function renderSeg() {
    const btns = [...segEl.querySelectorAll("button")];
    btns.forEach((b, i) => {
      const on = b.dataset.amt === state.buyAmount;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on);
      if (on) segThumb.style.transform = `translateX(${i * 100}%)`;
    });
  }
  segEl.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.buyAmount = b.dataset.amt;
    sfx("tab");
    renderSeg();
    renderShop(true);
  });

  // ---------------------------------------------------------------
  // Upgrades
  // ---------------------------------------------------------------
  const upgradesEl = $("upgrades");
  const upgradesEmpty = $("upgradesEmpty");
  const ROMAN = ["", "I", "II", "III", "IV", "V"];
  let upgListKey = "";
  let upgCards = [];

  const availableUpgrades = () =>
    UPGRADES.filter((u) => !upgSet.has(u.id) && u.unlock(state)).sort((a, b) => a.cost - b.cost);

  function renderUpgrades(force) {
    const list = availableUpgrades();
    const key = list.map((u) => u.id).join();
    if (force || key !== upgListKey) {
      upgListKey = key;
      upgradesEl.innerHTML = "";
      upgCards = list.map((u) => {
        const li = el("li");
        const btn = el(
          "button",
          "card",
          `<span class="card-icon" aria-hidden="true"></span>
           <span><span class="card-name"></span><span class="card-desc"></span>
           <span class="card-cost"><img class="coin" src="./coin.png" alt="" /><span class="c"></span></span></span>
           <span></span>`
        );
        btn.type = "button";
        btn.querySelector(".card-icon").textContent = u.icon;
        if (u.tier) btn.querySelector(".card-icon").appendChild(el("span", "tier", ROMAN[u.tier]));
        btn.querySelector(".card-name").textContent = u.name;
        btn.querySelector(".card-desc").textContent = u.desc;
        btn.querySelector(".c").textContent = fmt(u.cost);
        btn.addEventListener("click", () => buyUpgrade(u, btn));
        li.appendChild(btn);
        upgradesEl.appendChild(li);
        return { u, btn };
      });
      upgradesEmpty.hidden = list.length > 0;
    }
    for (const { u, btn } of upgCards) btn.classList.toggle("can", state.count >= u.cost);
  }

  function buyUpgrade(u, btn) {
    if (upgSet.has(u.id)) return;
    if (state.count < u.cost) {
      restartAnim(btn, "deny");
      sfx("error");
      return;
    }
    Audio.init();
    state.count -= u.cost;
    state.upgrades.push(u.id);
    upgSet.add(u.id);
    recalc();
    const [x, y] = centerOf(btn.querySelector(".card-icon"));
    starBurst(x, y, reduceMotion ? 4 : 14, 0.7);
    burst(x, y, reduceMotion ? 4 : 12, 0, ["#ffe066", "#fff3c4", "#3ae0ff"]);
    sfx("upgrade");
    vibrate(25);
    pop.v += 3;
    renderUpgrades(true);
    renderShop(true);
    renderScore();
    renderRates();
    save();
  }

  // ---------------------------------------------------------------
  // Achievements
  // ---------------------------------------------------------------
  const achGrid = $("achGrid");
  const achDetail = $("achDetail");
  const achBadges = {};
  let selectedAch = null;
  const freshAch = new Set();

  for (const a of ACHS) {
    const b = el("button", "badge", '<span class="b-ico"></span>');
    b.type = "button";
    b.addEventListener("click", () => {
      selectedAch = a.id;
      sfx("tab");
      renderAchievements();
    });
    achGrid.appendChild(b);
    achBadges[a.id] = b;
  }

  function achContext() {
    let buildings = 0;
    for (const b of BUILDINGS) buildings += owned(b);
    return {
      perSec: R.perSecBase,
      buildings,
      upgrades: state.upgrades.length,
      skins: state.skins.length,
      skinsTotal: SKIN_KEYS.length,
      idle: (performance.now() - lastActiveClick) / 1000,
      burst: burstBest,
    };
  }

  function checkAchievements() {
    const c = achContext();
    let got = false;
    for (const a of ACHS) {
      if (achSet.has(a.id)) continue;
      let ok = false;
      try {
        ok = a.test(state, c);
      } catch (_) {}
      if (!ok) continue;
      state.achievements.push(a.id);
      achSet.add(a.id);
      freshAch.add(a.id);
      got = true;
      banner(a.icon, "🏆 הישג חדש:", a.name, `${a.desc} · ${ltr("+1%")} ייצור`);
      sfx("achievement");
      vibrate([20, 30, 20]);
    }
    if (got) {
      recalc();
      renderRates();
      save();
    }
  }

  function renderAchievements() {
    const total = ACHS.length;
    const n = state.achievements.length;
    $("achSummary").textContent = `${n}/${total} · ${ltr("+" + n + "%")} ייצור`;
    $("achProgress").style.width = (n / total) * 100 + "%";
    for (const a of ACHS) {
      const b = achBadges[a.id];
      const got = achSet.has(a.id);
      b.classList.toggle("got", got);
      b.classList.toggle("fresh", freshAch.has(a.id));
      b.classList.toggle("selected", selectedAch === a.id);
      const ico = got || !a.secret ? a.icon : "❓";
      const icoEl = b.firstChild;
      if (icoEl.textContent !== ico) icoEl.textContent = ico;
      b.setAttribute("aria-label", got || !a.secret ? a.name : "הישג סודי");
    }
    if (selectedAch) {
      const a = ACH[selectedAch];
      const got = achSet.has(a.id);
      const hidden = a.secret && !got;
      achDetail.innerHTML = "";
      const t = el("b");
      t.textContent = (got ? "✅ " : "🔒 ") + (hidden ? "הישג סודי" : a.name);
      const d = el("span");
      d.textContent = hidden ? "צריך לגלות לבד…" : a.desc + (got ? " · הושג!" : "");
      achDetail.append(t, d);
    }
    renderStats();
  }

  function renderStats() {
    const rows = [
      ["דבירים בריצה הנוכחית", fmt(state.runEarned)],
      ["סה״כ דבירים מאז ומעולם", fmt(state.totalEarned)],
      ["סה״כ לחיצות", fmt(state.totalClicks)],
      ["לחיצות קריטיות", fmt(state.crits)],
      ["קומבו הכי גבוה", fmt(state.maxCombo)],
      ["דבירי זהב שנתפסו", fmt(state.golden)],
      ["לידות מחדש", fmt(state.rebirths)],
      ["זמן משחק", fmtTime(state.playTime)],
    ];
    const statsEl = $("stats");
    if (statsEl.children.length !== rows.length) {
      statsEl.innerHTML = "";
      for (let i = 0; i < rows.length; i++) statsEl.appendChild(el("div", "stat", "<span></span><b></b>"));
    }
    rows.forEach(([label, value], i) => {
      const s = statsEl.children[i];
      s.firstChild.textContent = label;
      s.lastChild.textContent = value;
    });
  }

  function fmtTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h} שע׳ ${m} דק׳` : `${m} דק׳`;
  }

  // ---------------------------------------------------------------
  // Skins
  // ---------------------------------------------------------------
  const frameGrid = $("frameGrid");
  const accGrid = $("accGrid");
  const skinCards = [];

  function skinRuleText(rule) {
    if (rule.ach) return "🔒 הישג: " + (ACH[rule.ach] ? ACH[rule.ach].name : "");
    if (rule.rebirths) return rule.rebirths === 1 ? "🔒 אחרי לידה מחדש" : `🔒 אחרי ${rule.rebirths} לידות מחדש`;
    return "";
  }

  function skinHowText(rule) {
    if (rule.ach) return `🔒 נפתח עם ההישג "${ACH[rule.ach] ? ACH[rule.ach].name : ""}"`;
    return rule.rebirths === 1 ? "🔒 נפתח אחרי לידה מחדש" : `🔒 נפתח אחרי ${rule.rebirths} לידות מחדש`;
  }

  function makePreview(frameId, accId) {
    const p = el("div", "skin-preview");
    Skins.applyFrame(p, frameId);
    const body = el("div", "dvir-body");
    const circle = el("span", "dvir", '<img src="./dvir.webp" alt="" draggable="false" />');
    const acc = el("div", "accessory");
    body.append(circle, acc);
    p.appendChild(body);
    if (accId) Skins.renderAccessory(acc, accId);
    return p;
  }

  function buildSkins() {
    for (const [type, list, grid] of [
      ["frame", Skins.frames, frameGrid],
      ["acc", Skins.accessories, accGrid],
    ]) {
      for (const s of list) {
        const key = `${type}:${s.id}`;
        const rule = D.SKIN_RULES[key];
        if (!rule) continue;
        const card = el("button", "skin-card");
        card.type = "button";
        const preview = type === "frame" ? makePreview(s.id, null) : makePreview(state.frame, s.id);
        const name = el("span", "skin-name");
        name.textContent = s.name;
        const st = el("span", "skin-state");
        card.append(preview, name, st);
        card.addEventListener("click", () => onSkin(type, s, card));
        grid.appendChild(card);
        skinCards.push({ type, s, key, rule, card, preview, st });
      }
    }
  }

  function ownsSkin(key) {
    return skinSet.has(key);
  }

  // Achievement / rebirth unlocks are granted automatically.
  function checkSkinUnlocks() {
    for (const key of SKIN_KEYS) {
      if (skinSet.has(key)) continue;
      const rule = D.SKIN_RULES[key];
      const ok = (rule.ach && achSet.has(rule.ach)) || (rule.rebirths && state.rebirths >= rule.rebirths) || rule.free;
      if (!ok) continue;
      state.skins.push(key);
      skinSet.add(key);
      const item = skinCards.find((c) => c.key === key);
      if (item) banner("🎨", "סקין חדש:", item.s.name, "אפשר לבחור אותו בטאב הסקינים");
      sfx("unlock");
      save();
    }
  }

  function renderSkins() {
    for (const c of skinCards) {
      const own = ownsSkin(c.key);
      const equipped = c.type === "frame" ? state.frame === c.s.id : state.accessory === c.s.id;
      const can = !own && c.rule.cost && state.count >= c.rule.cost;
      c.card.classList.toggle("equipped", equipped);
      c.card.classList.toggle("locked", !own);
      c.card.classList.toggle("can", Boolean(can));
      let html;
      if (equipped) html = "בשימוש";
      else if (own) html = "לבחור";
      else if (c.rule.cost) html = `<img class="coin" src="./coin.png" alt="" style="width:15px;height:15px" />${fmt(c.rule.cost)}`;
      else html = skinRuleText(c.rule);
      if (c.st.dataset.html !== html) {
        c.st.dataset.html = html;
        c.st.innerHTML = html;
      }
      // Accessory thumbnails show the frame you're wearing.
      if (c.type === "acc" && c.preview.dataset.frame !== state.frame) {
        c.preview.dataset.frame = state.frame;
        Skins.applyFrame(c.preview, state.frame);
      }
    }
  }

  function onSkin(type, s, card) {
    const key = `${type}:${s.id}`;
    const rule = D.SKIN_RULES[key];
    Audio.init();
    if (!ownsSkin(key)) {
      if (rule.cost && state.count >= rule.cost) {
        state.count -= rule.cost;
        state.skins.push(key);
        skinSet.add(key);
        const [x, y] = centerOf(card);
        starBurst(x, y, reduceMotion ? 4 : 18, 0.8);
        burst(x, y, reduceMotion ? 4 : 16, 0);
        sfx("unlock");
        vibrate([20, 30, 40]);
      } else {
        restartAnim(card, "deny");
        sfx("error");
        if (!rule.cost) toast(skinHowText(rule));
        return;
      }
    } else {
      sfx("equip");
      vibrate(15);
    }
    if (type === "frame") state.frame = s.id;
    else state.accessory = s.id;
    applySkin(true);
    renderSkins();
    renderScore();
    save();
  }

  function applySkin(animate) {
    Skins.applyFrame(clickerEl, state.frame);
    Skins.renderAccessory(accessoryEl, state.accessory);
    if (animate) {
      restartAnim(accessoryEl, "pop");
      const [x, y] = centerOf(dvir);
      starBurst(x, y, reduceMotion ? 4 : 16, 0.8);
      pop.v += 2;
      squish.v -= 2.5;
    }
    BG.setAccent(D.FRAME_ACCENTS[state.frame] || D.FRAME_ACCENTS.gold);
  }

  // ---------------------------------------------------------------
  // Rebirth
  // ---------------------------------------------------------------
  const starsFor = (total) => Math.floor(Math.sqrt(total / STAR_UNIT));
  const rebirthGain = () => Math.max(0, starsFor(state.totalEarned) - state.stars);

  function renderRebirth() {
    const gain = rebirthGain();
    $("rebStars").textContent = fmt(state.stars);
    $("rebBonus").textContent =
      state.stars > 0
        ? `הכוכבים נותנים ${ltr("+" + fmt(state.stars * STAR_BONUS * 100) + "%")} לייצור וללחיצות.`
        : `כל כוכב נותן ${ltr("+10%")} לייצור וללחיצות, לתמיד.`;
    $("rebGain").textContent = `${fmt(gain)} ⭐`;
    const have = state.stars + gain;
    const from = have * have * STAR_UNIT;
    const to = (have + 1) * (have + 1) * STAR_UNIT;
    const frac = Math.max(0, Math.min(1, (state.totalEarned - from) / (to - from)));
    $("rebProgress").style.width = frac * 100 + "%";
    $("rebNext").textContent = `עוד ${fmt(Math.max(0, to - state.totalEarned))} דבירים לכוכב הבא`;
    $("rebirthBtn").disabled = gain < 1;
  }

  $("rebirthBtn").addEventListener("click", async () => {
    const gain = rebirthGain();
    if (gain < 1) return;
    sfx("tab");
    const ok = await confirmModal({
      icon: "🌟",
      title: "לידה מחדש?",
      text: `תקבלו ${fmt(gain)} כוכבים (${ltr("+" + fmt(gain * STAR_BONUS * 100) + "%")} לתמיד). הדבירים, המבנים והשדרוגים יתאפסו.`,
      ok: "✨ כן, לידה מחדש!",
      okClass: "star",
    });
    if (ok) doRebirth(gain);
  });

  function doRebirth(gain) {
    sfx("rebirth");
    vibrate([60, 60, 120, 60, 200]);
    restartAnim(flashEl, "go");
    restartAnim(dvirSpin, "reborn");
    BG.pulse(1);
    shake(0.6);
    setTimeout(() => {
      state.stars += gain;
      state.rebirths += 1;
      state.count = 0;
      state.runEarned = 0;
      state.owned = {};
      state.upgrades = [];
      for (const k of Object.keys(buffs)) delete buffs[k];
      syncSets();
      recalc();
      applyMood();
      renderAll(true);
      save();
    }, 650);
    setTimeout(() => {
      const [x, y] = centerOf(dvir);
      starBurst(x, y, reduceMotion ? 10 : 60, 1.6);
      confettiRain(reduceMotion ? 30 : 140, 0.3);
      toast(`✨ נולדתם מחדש! ${ltr("+" + fmt(gain))} ⭐`, 3600);
    }, 1050);
    setTimeout(() => dvirSpin.classList.remove("reborn"), 1700);
  }

  // ---------------------------------------------------------------
  // Tabs, toggles, reset
  // ---------------------------------------------------------------
  const tabsEl = $("tabs");
  const tabIndicator = $("tabIndicator");
  let activeTab = "shop";

  function moveTabIndicator() {
    const tab = tabsEl.querySelector(`.tab[data-tab="${activeTab}"]`);
    if (!tab) return;
    tabIndicator.style.width = tab.offsetWidth + "px";
    tabIndicator.style.transform = `translateX(${tab.offsetLeft}px)`;
  }

  function setTab(name) {
    if (name === activeTab) return;
    if (activeTab === "achievements") {
      freshAch.clear();
      state.seenAch = state.achievements.slice();
    }
    activeTab = name;
    for (const t of tabsEl.querySelectorAll(".tab")) {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on);
    }
    for (const v of document.querySelectorAll(".view")) v.classList.toggle("active", v.id === "view-" + name);
    moveTabIndicator();
    sfx("tab");
    if (name === "achievements") state.seenAch = state.achievements.slice();
    renderActive(true);
  }

  tabsEl.addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) setTab(t.dataset.tab);
  });

  function renderDots() {
    const dot = (name, on) => tabsEl.querySelector(`.tab[data-tab="${name}"]`).classList.toggle("has-dot", Boolean(on));
    dot("upgrades", activeTab !== "upgrades" && availableUpgrades().some((u) => state.count >= u.cost));
    const seen = new Set(state.seenAch);
    dot("achievements", activeTab !== "achievements" && state.achievements.some((id) => !seen.has(id)));
    dot("skins", activeTab !== "skins" && SKIN_KEYS.some((k) => !skinSet.has(k) && D.SKIN_RULES[k].cost && state.count >= D.SKIN_RULES[k].cost));
    dot("rebirth", activeTab !== "rebirth" && rebirthGain() >= 1);
  }

  function renderToggles() {
    soundToggle.setAttribute("aria-pressed", state.sound);
    soundToggle.textContent = state.sound ? "🔊" : "🔇";
    musicToggle.setAttribute("aria-pressed", state.music);
    vibeToggle.hidden = !canVibrate;
    vibeToggle.setAttribute("aria-pressed", state.vibe);
  }

  soundToggle.addEventListener("click", () => {
    state.sound = !state.sound;
    Audio.setSfxEnabled(state.sound);
    Audio.init();
    renderToggles();
    sfx("equip");
    save();
  });

  musicToggle.addEventListener("click", () => {
    state.music = !state.music;
    Audio.setMusicEnabled(state.music);
    Audio.init();
    renderToggles();
    sfx("tab");
    save();
  });

  vibeToggle.addEventListener("click", () => {
    state.vibe = !state.vibe;
    renderToggles();
    vibrate(30);
    save();
  });

  $("reset").addEventListener("click", async () => {
    const ok = await confirmModal({
      icon: "⚠️",
      title: "לאפס הכול?",
      text: "כל הדבירים, המבנים, השדרוגים, ההישגים, הכוכבים והסקינים יימחקו לתמיד.",
      ok: "למחוק הכול",
      okClass: "danger",
    });
    if (!ok) return;
    const keep = { sound: state.sound, music: state.music, vibe: state.vibe };
    state = { ...defaults(), ...keep };
    for (const k of Object.keys(buffs)) delete buffs[k];
    freshAch.clear();
    selectedAch = null;
    syncSets();
    recalc();
    applyMood();
    applySkin(false);
    hintEl.classList.remove("gone");
    renderAll(true);
    save();
  });

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  let shownCount = -1;
  function renderScore() {
    const c = Math.floor(state.count);
    if (c !== shownCount) {
      shownCount = c;
      countEl.textContent = fmt(c);
    }
  }

  function renderRates() {
    perClickEl.textContent = fmt(R.perClick);
    perSecEl.textContent = fmt(R.perSec);
    starsRateEl.hidden = state.stars < 1;
    starsCountEl.textContent = fmt(state.stars);
  }

  function renderActive(force) {
    if (activeTab === "shop") renderShop(force);
    else if (activeTab === "upgrades") renderUpgrades(force);
    else if (activeTab === "achievements") renderAchievements();
    else if (activeTab === "skins") renderSkins();
    else if (activeTab === "rebirth") renderRebirth();
  }

  function renderAll(force) {
    shownCount = -1;
    renderScore();
    renderRates();
    renderSeg();
    renderToggles();
    renderBuffs();
    renderShop(force);
    renderUpgrades(force);
    renderAchievements();
    renderSkins();
    renderRebirth();
    renderDots();
  }

  // ---------------------------------------------------------------
  // Milestones
  // ---------------------------------------------------------------
  function checkMilestones() {
    let hitOne = false;
    while (state.milestone < D.MILESTONES.length && state.totalEarned >= D.MILESTONES[state.milestone]) {
      state.milestone += 1;
      hitOne = true;
    }
    if (!hitOne) return;
    toast(`🎉 ${fmt(D.MILESTONES[state.milestone - 1])} דבירים! 🎉`);
    confettiRain(reduceMotion ? 40 : 170);
    shake(0.85);
    BG.pulse(0.6);
    sfx("milestone");
    vibrate([40, 50, 40, 50, 80]);
  }

  // ---------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------
  let last = performance.now();
  let uiTimer = 0;
  let slowTimer = 0;
  let titleTimer = 0;

  function frame(now) {
    const elapsed = Math.max(0, (now - last) / 1000);
    last = now;

    // Expire buffs first, so time spent in the background after a buff ended
    // is paid at the normal rate.
    updateBuffs(now);
    const gained = R.perSec * Math.min(elapsed, OFFLINE_CAP_SECONDS);
    earn(gained);
    if (elapsed > 30 && gained >= 1) {
      toast(`ברוכים השבים! בזמן שלא הייתם נאספו ${fmt(gained)} דבירים 💰`, 4200);
    }
    state.playTime += Math.min(elapsed, 1);

    // Physics uses a clamped step so nothing explodes after a pause.
    const dt = Math.min(elapsed, 1 / 30);
    stepSprings(dt);
    stepShake(dt);
    stepGolden(dt);
    stepRain(dt);
    try {
      BG.step(dt);
    } catch (_) {}
    stepParticles(dt);
    renderScore();

    uiTimer += elapsed;
    if (uiTimer > 0.1) {
      uiTimer = 0;
      checkMilestones();
      renderBuffs();
      renderActive(false);
      renderRates();
    }

    slowTimer += elapsed;
    if (slowTimer > 0.5) {
      slowTimer = 0;
      checkAchievements();
      checkSkinUnlocks();
      renderDots();
      BG.setProduction(R.perSec);
    }

    titleTimer += elapsed;
    if (titleTimer > 1) {
      titleTimer = 0;
      document.title = `${fmt(Math.floor(state.count))} דבירים · Dvir Clicker`;
    }

    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  load();
  syncSets();
  recalc();

  // Earnings while the game was closed (production only, buffs don't carry over).
  const away = Math.min(OFFLINE_CAP_SECONDS, Math.max(0, (Date.now() - state.lastSeen) / 1000));
  const offline = R.perSecBase * away;
  if (offline >= 1) earn(offline);

  // Don't replay milestones that were already passed before this visit.
  while (state.milestone < D.MILESTONES.length && state.totalEarned >= D.MILESTONES[state.milestone]) state.milestone += 1;
  // Achievements earned with the old version unlock quietly.
  {
    const c = achContext();
    for (const a of ACHS) {
      if (achSet.has(a.id) || a.secret) continue;
      try {
        if (a.test(state, c)) {
          state.achievements.push(a.id);
          achSet.add(a.id);
          state.seenAch.push(a.id);
        }
      } catch (_) {}
    }
    recalc();
  }

  try {
    BG.init($("bg"), { coinSrc: "./coin.png" });
  } catch (_) {}
  buildSkins();
  applySkin(false);
  applyMood();
  BG.setProduction(R.perSec);
  if (state.totalClicks > 0) hintEl.classList.add("gone");
  Audio.setSfxEnabled(state.sound);
  Audio.setMusicEnabled(state.music);

  resize();
  window.addEventListener("resize", resize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveTabIndicator).catch(noop);
  renderAll(true);

  function startGame() {
    if (splashEl.classList.contains("out")) return;
    Audio.init();
    splashEl.classList.add("out");
    restartAnim(dvirSpin, "intro");
    setTimeout(() => dvirSpin.classList.remove("intro"), 800);
    setTimeout(() => splashEl.remove(), 700);
    if (offline >= 1) {
      setTimeout(() => toast(`ברוכים השבים! בזמן שלא הייתם נאספו ${fmt(offline)} דבירים 💰`, 4200), 650);
    }
    moveTabIndicator();
  }
  splashEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startGame();
  });
  document.addEventListener("keydown", (e) => {
    if (document.body.contains(splashEl) && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      startGame();
    }
  });
  // Any first touch also unlocks audio (some browsers need a gesture).
  window.addEventListener("pointerdown", () => Audio.init(), { capture: true, passive: true });

  setInterval(save, 5000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  window.addEventListener("pagehide", save);

  // Test hooks for QA (only with ?debug in the URL).
  if (/[?&]debug\b/.test(location.search)) {
    window.__dc = {
      state: () => state,
      R,
      buffs,
      earn: (n) => (earn(n), renderAll(true)),
      spawnGolden: () => !golden && spawnGolden(),
      catchGolden,
      addBuff,
      rain: () => ((rainLeft = 26), (rainSpawnTimer = 0)),
      setTab,
      particles: () => particles.length,
    };
  }

  // Called by the Android app around onPause / onResume.
  window.dvirSave = save;
  window.dvirPause = () => {
    save();
    Audio.pause();
  };
  window.dvirResume = () => Audio.resume();

  requestAnimationFrame((t) => {
    last = t;
    requestAnimationFrame(frame);
  });
})();
