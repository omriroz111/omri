/* ==========================================================================
   Dvir Clicker - sound effects + original chiptune music (window.DCAudio)
   --------------------------------------------------------------------------
   Everything is synthesised live with WebAudio: no audio files at all.

   Signal flow (built the same way for the live context and for offline
   test renders, so both run exactly the same synthesis code):

     sfx voices ──► effect trim ──► sfx bus (0.5) ──────────┐
         └─(wet)─► reverb sends ──► convolver ──────────────┤
     music voices ──► musicIn ──► fade ──► level (0.15) ────┼──► mix
         lead ──► dotted-8th echo ──► musicIn   └─► reverb  │
                                                            ▼
                mix ──► compressor ──► unmakeup ──► soft clip ──► out

   The compressor tames stacked sounds and the soft clipper after it caps the
   output below 0.91, so nothing can ever hard-clip.

   Music: an original 16-bar loop in C major at 120 BPM (A section 8 bars,
   B section 8 bars). Notes are scheduled ~0.12 s ahead on the audio clock by
   a 25 ms setInterval ("two clocks" pattern); the timer only runs while music
   is audible. Over three passes the arrangement changes (lead rests, then
   switches to a softer flute voice) so the loop does not wear thin.

   API:
     DCAudio.init()                 create/resume the context (call from gestures)
     DCAudio.setSfxEnabled(bool)
     DCAudio.setMusicEnabled(bool)  fades in (1.5 s) / out (0.4 s)
     DCAudio.setIntensity(level)    0 normal, 1 frenzy; switches on the next bar
     DCAudio.pause() / resume()     app background / foreground
     DCAudio.play(name, opts)       sound effect, see SFX below
     DCAudio._renderOffline(sec[, keepBuffers])
                                    test hook -> Promise<{peak, rms, perSoundPeaks, ...}>
     DCAudio._meter()               test hook: live output peak (lazy analyser)
     DCAudio._debug()               test hook: engine state snapshot
   ========================================================================== */
(function () {
  "use strict";

  const AC = window.AudioContext || window.webkitAudioContext;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  // ---------------------------------------------------------------
  // Tunables
  // ---------------------------------------------------------------
  const SFX_LEVEL = 0.5;
  const MUSIC_LEVEL = 0.15;
  const BPM = 120;
  const STEP = 60 / BPM / 4; // one 16th note, seconds
  const LOOKAHEAD = 0.12; // how far ahead the scheduler books notes
  const TICK_MS = 25;
  const FADE_IN = 1.5;
  const FADE_OUT = 0.4;
  const POP_VOICES = 5; // overlapping click sounds before the oldest is cut
  const MAX_VOICES = 80; // sfx oscillator budget; low-priority sounds drop past it

  // Minimum time between two triggers of the same sound (seconds). Stops a
  // "buy max" loop from stacking 100 identical ka-chings in one frame.
  const MIN_GAP = {
    pop: 0.03, crit: 0.06, buy: 0.05, upgrade: 0.08, error: 0.12, milestone: 0.3,
    achievement: 0.35, goldenSpawn: 0.3, goldenCatch: 0.2, frenzyStart: 0.5,
    rebirth: 1, tab: 0.03, unlock: 0.15, equip: 0.06,
  };
  const LOW_PRIORITY = { pop: 1, tab: 1, goldenSpawn: 1, equip: 1 };

  const noop = () => {};
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const C5 = 523.25;
  const hz = (semi) => C5 * Math.pow(2, semi / 12); // semitones above C5

  // Small seeded PRNG so offline test renders are reproducible.
  let seed = (Date.now() ^ 0x9e3779b9) >>> 0;
  function rnd() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------
  // Per-context "kit": mixing chain + cached buffers and waves
  // ---------------------------------------------------------------
  function buildKit(c) {
    const k = { c, popVoices: [], voiceEnds: [], last: {}, buyStep: 0, lastBuy: -9 };

    // Limiter-ish compressor. WebAudio compressors add automatic makeup gain
    // ((1 / full-range gain) ^ 0.6, about x1.44 for these settings), so
    // "unmakeup" brings quiet material back to unity: the chain is then
    // transparent below ~0.4 and levels off around 0.6 for loud stacks.
    const mix = c.createGain();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 6;
    comp.ratio.value = 10;
    comp.attack.value = 0.002;
    comp.release.value = 0.2;
    const unmakeup = c.createGain();
    unmakeup.gain.value = 1 / 1.44;
    const clip = c.createWaveShaper();
    clip.curve = softClipCurve();
    const out = c.createGain();
    mix.connect(comp);
    comp.connect(unmakeup);
    unmakeup.connect(clip);
    clip.connect(out);
    out.connect(c.destination);
    k.out = out;

    // Shared room reverb (generated impulse response).
    const verb = c.createConvolver();
    verb.buffer = makeImpulse(c, 1.25);
    verb.connect(mix);
    const send = (level) => {
      const g = c.createGain();
      g.gain.value = level;
      g.connect(verb);
      return g;
    };
    k.sends = [null, send(0.05), send(0.1), send(0.18)];

    k.sfxIn = c.createGain();
    k.sfxIn.gain.value = SFX_LEVEL;
    k.sfxIn.connect(mix);

    k.musicIn = c.createGain();
    k.musicFade = c.createGain();
    k.musicFade.gain.value = 0;
    const musicLevel = c.createGain();
    musicLevel.gain.value = MUSIC_LEVEL;
    k.musicIn.connect(k.musicFade);
    k.musicFade.connect(musicLevel);
    musicLevel.connect(mix);
    musicLevel.connect(send(0.3));

    // Dotted-8th echo for the lead, darkened a little on every repeat.
    k.echoIn = c.createGain();
    const delay = c.createDelay(1);
    delay.delayTime.value = STEP * 3;
    const damp = c.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2200;
    const fb = c.createGain();
    fb.gain.value = 0.3;
    const echoOut = c.createGain();
    echoOut.gain.value = 0.32;
    k.echoIn.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(echoOut);
    echoOut.connect(k.musicIn);

    k.noise = makeNoise(c);
    k.waves = {
      square: makeWave(c, 0.5, 10),
      pulse25: makeWave(c, 0.25, 12),
      pulse12: makeWave(c, 0.125, 14),
    };
    return k;
  }

  // Linear up to 0.7, then a tanh knee that never exceeds ~0.91.
  function softClipCurve() {
    const n = 2049;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const ax = Math.abs(x);
      const y = ax < 0.7 ? ax : 0.7 + 0.25 * Math.tanh((ax - 0.7) / 0.25);
      curve[i] = x < 0 ? -y : y;
    }
    return curve;
  }

  // Decaying stereo noise that gets darker as it fades: a small, soft room.
  function makeImpulse(c, seconds) {
    const rate = c.sampleRate;
    const len = Math.floor(rate * seconds);
    const pre = Math.floor(rate * 0.012);
    const buf = c.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const p = i / len;
        const a = 0.2 + 0.7 * p;
        lp = lp * a + (rnd() * 2 - 1) * (1 - a);
        d[i] = lp * Math.pow(1 - p, 3);
      }
    }
    return buf;
  }

  function makeNoise(c) {
    const len = c.sampleRate;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = rnd() * 2 - 1;
    return buf;
  }

  // Band-limited pulse wave with a gentle harmonic roll-off ("soft" sets
  // where it starts), so chip voices stay warm instead of buzzy.
  function makeWave(c, duty, soft) {
    const n = 32;
    const real = new Float32Array(n + 1);
    const imag = new Float32Array(n + 1);
    for (let h = 1; h <= n; h++) {
      real[h] = ((2 / (h * Math.PI)) * Math.sin(h * Math.PI * duty)) / (1 + (h / soft) * (h / soft));
    }
    return c.createPeriodicWave(real, imag);
  }

  // ---------------------------------------------------------------
  // Voice primitives. All take (kit, destination, startTime, options)
  // ---------------------------------------------------------------

  // One sound effect's voices share a group: a trim gain (plus matching
  // reverb sends) that disconnects itself when the last voice ends.
  function group(k, dest, gain) {
    const level = gain === undefined ? 1 : gain;
    const node = k.c.createGain();
    node.gain.value = level;
    node.connect(dest);
    const sends = [];
    let n = 0;
    return {
      node,
      send(i) {
        if (!sends[i]) {
          sends[i] = k.c.createGain();
          sends[i].gain.value = level;
          sends[i].connect(k.sends[i]);
        }
        return sends[i];
      },
      hold() {
        n++;
      },
      release() {
        if (--n > 0) return;
        try {
          node.disconnect();
          sends.forEach((g) => g && g.disconnect());
        } catch (_) {}
      },
    };
  }

  // Percussive: 0 -> vol in atk, exponential fall to silence at t + dur.
  // Sustained (o.sus set): settle to vol * sus, release over o.rel after dur.
  // Returns the time the voice is silent.
  function envelope(p, t, o) {
    const vol = Math.max(o.vol || 0.2, 0.0002);
    const atk = o.atk || 0.004;
    const dur = Math.max(o.dur || 0.2, atk + 0.01);
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(vol, t + atk);
    if (o.sus !== undefined) {
      const rel = o.rel || 0.06;
      p.setTargetAtTime(vol * o.sus, t + atk, o.dec || 0.08);
      p.setTargetAtTime(0, t + dur, rel / 4);
      return t + dur + rel * 1.6;
    }
    p.exponentialRampToValueAtTime(0.0001, t + dur);
    return t + dur + 0.01;
  }

  // Wire a voice's amp to its destination (+ pan, reverb send, extra send)
  // and arrange for every node to be disconnected when the source ends.
  function finish(k, src, amp, nodes, dest, o, t, end, offset) {
    let outNode = amp;
    if (o.pan && k.c.createStereoPanner) {
      const p = k.c.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      amp.connect(p);
      outNode = p;
      nodes.push(p);
    }
    const grp = dest.node ? dest : null;
    outNode.connect(grp ? grp.node : dest);
    if (o.wet && k.sends[o.wet]) outNode.connect(grp ? grp.send(o.wet) : k.sends[o.wet]);
    if (o.also) outNode.connect(o.also);
    if (grp) grp.hold();
    src.onended = () => {
      for (let i = 0; i < nodes.length; i++) {
        try {
          nodes[i].disconnect();
        } catch (_) {}
      }
      if (grp) grp.release();
    };
    if (offset) src.start(t, offset);
    else src.start(t);
    src.stop(end);
    if (dest !== k.musicIn) k.voiceEnds.push(end);
  }

  // Oscillator voice: osc -> (lowpass) -> amp.
  //  f, f2 (+glide): pitch and optional exponential slide
  //  type | wave ("square" | "pulse25" | "pulse12"), detune (cents)
  //  lp, lp2 (+lpTime), q: lowpass and optional sweep
  //  vib: { rate, depth (cents), delay }
  function tone(k, dest, t, o) {
    const c = k.c;
    const osc = c.createOscillator();
    if (o.wave) osc.setPeriodicWave(k.waves[o.wave]);
    else osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide || o.dur));
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    const nodes = [osc];
    let head = osc;
    if (o.lp) {
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.setValueAtTime(o.lp, t);
      if (o.lp2) f.frequency.exponentialRampToValueAtTime(o.lp2, t + (o.lpTime || o.dur));
      f.Q.value = o.q || 0.7;
      head.connect(f);
      head = f;
      nodes.push(f);
    }
    const amp = c.createGain();
    head.connect(amp);
    nodes.push(amp);
    const end = envelope(amp.gain, t, o);
    if (o.vib) {
      // Delayed vibrato: an LFO on detune that fades in after the attack.
      const lfo = c.createOscillator();
      const depth = c.createGain();
      lfo.frequency.value = o.vib.rate;
      depth.gain.setValueAtTime(0, t);
      depth.gain.setValueAtTime(0, t + o.vib.delay);
      depth.gain.linearRampToValueAtTime(o.vib.depth, t + o.vib.delay + 0.15);
      lfo.connect(depth);
      depth.connect(osc.detune);
      lfo.start(t);
      lfo.stop(end);
      nodes.push(lfo, depth);
    }
    finish(k, osc, amp, nodes, dest, o, t, end);
    return amp;
  }

  // Filtered noise voice. ft: filter type, f/f2 (+sweep): cutoff and slide.
  function noise(k, dest, t, o) {
    const c = k.c;
    const src = c.createBufferSource();
    src.buffer = k.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.ft || "bandpass";
    f.frequency.setValueAtTime(o.f || 2000, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + (o.sweep || o.dur));
    f.Q.value = o.q || 0.8;
    const amp = c.createGain();
    src.connect(f);
    f.connect(amp);
    const end = envelope(amp.gain, t, o);
    // Random read offset so repeated hits never sound identical.
    finish(k, src, amp, [src, f, amp], dest, o, t, end, rnd() * 0.8);
  }

  // Two-operator FM bell: bright metallic attack melting into a pure tone.
  // ratio: modulator/carrier (2 = glassy, 3.5 = coin-like), index: brightness.
  function bell(k, dest, t, o) {
    const c = k.c;
    const car = c.createOscillator();
    const mod = c.createOscillator();
    const mg = c.createGain();
    const amp = c.createGain();
    const ratio = o.ratio || 2;
    const index = o.index || 1;
    car.frequency.setValueAtTime(o.f, t);
    mod.frequency.setValueAtTime(o.f * ratio, t);
    mg.gain.setValueAtTime(o.f * index, t);
    mg.gain.exponentialRampToValueAtTime(o.f * index * 0.03 + 0.01, t + o.dur * 0.5);
    mod.connect(mg);
    mg.connect(car.frequency);
    car.connect(amp);
    const end = envelope(amp.gain, t, { vol: o.vol, atk: o.atk || 0.002, dur: o.dur });
    mod.start(t);
    mod.stop(end);
    finish(k, car, amp, [car, mod, mg, amp], dest, o, t, end);
  }

  // A scatter of tiny bell "tings" on high pentatonic notes.
  const SPARK = [84, 86, 88, 91, 93, 96, 98]; // C6 .. D7
  function sparkles(k, dest, t, o) {
    const fade = o.fade === undefined ? 0.5 : o.fade;
    for (let i = 0; i < o.n; i++) {
      const at = t + (i / o.n) * o.span + rnd() * 0.015;
      const note = o.notes ? o.notes[i % o.notes.length] : SPARK[Math.floor(rnd() * SPARK.length)];
      bell(k, dest, at, {
        f: mtof(note),
        ratio: o.ratio || 3.5,
        index: 0.7,
        dur: o.dur || 0.28,
        vol: o.vol * (1 - (i / o.n) * fade),
        pan: (rnd() * 2 - 1) * 0.6,
        wet: o.wet,
      });
    }
  }

  // ---------------------------------------------------------------
  // Sound effects: fn(kit, destination, time, opts)
  // ---------------------------------------------------------------
  const PENTA = [0, 2, 4, 7, 9, 12, 14]; // C major pentatonic, matches the music

  // Per-effect output trim, balanced by measured peak and by ear-weighting:
  // bright bells read louder than low bloops at the same peak.
  const LEVEL = {
    pop: 0.9, crit: 1.15, buy: 1.8, upgrade: 1.2, error: 1.5, milestone: 1.5, achievement: 1.8,
    goldenSpawn: 2.6, goldenCatch: 2.6, frenzyStart: 1.85, rebirth: 1.75, tab: 3, unlock: 2.1, equip: 1.5,
  };

  const SFX = {
    // Click: a soft water-drop "plip". Combo climbs the pentatonic scale
    // (one step per 5 combo, capped at 30) and adds sparkle on top.
    pop(k, dest, t, o) {
      const combo = clamp(Math.floor(+o.combo || 1), 1, 30);
      // Voice cap: fade out the oldest click instead of piling up.
      k.popVoices = k.popVoices.filter((v) => v.end > t);
      while (k.popVoices.length >= POP_VOICES) {
        const v = k.popVoices.shift();
        v.node.gain.setTargetAtTime(0, t, 0.005);
      }
      const g = group(k, dest, LEVEL.pop);
      g.node.gain.value = LEVEL.pop / (1 + 0.2 * k.popVoices.length);
      const step = Math.min(PENTA.length - 1, Math.floor((combo - 1) / 5) + (rnd() < 0.3 ? 1 : 0));
      const f = hz(PENTA[step]) * Math.pow(2, (rnd() - 0.5) / 80);
      const bright = combo / 30;
      tone(k, g, t, { f: f * 0.62, f2: f, glide: 0.02, dur: 0.12, vol: 0.5, atk: 0.002 });
      tone(k, g, t, { type: "triangle", f: f * 2, f2: f * 2.03, dur: 0.06, vol: 0.08 + 0.17 * bright, atk: 0.002 });
      tone(k, g, t, { f: 190, f2: 80, dur: 0.06, vol: 0.25, atk: 0.002 });
      noise(k, g, t, { ft: "highpass", f: 3200, dur: 0.018, vol: 0.1 + 0.08 * bright, atk: 0.001 });
      k.popVoices.push({ node: g.node, end: t + 0.13 });
    },

    // Lucky x10 click: a thump, a big plip, a bell and a burst of sparkles.
    crit(k, dest, t) {
      const g = group(k, dest, LEVEL.crit);
      tone(k, g, t, { f: 240, f2: 50, dur: 0.28, vol: 0.5, atk: 0.003 });
      tone(k, g, t, { f: hz(12) * 0.6, f2: hz(12), glide: 0.025, dur: 0.2, vol: 0.38 });
      tone(k, g, t, { type: "triangle", f: hz(19), dur: 0.3, vol: 0.1, atk: 0.003, wet: 2 });
      noise(k, g, t, { ft: "lowpass", f: 600, f2: 4000, sweep: 0.08, dur: 0.16, vol: 0.22 });
      bell(k, g, t + 0.04, { f: hz(24), ratio: 2, index: 1.2, dur: 0.6, vol: 0.1, wet: 3, pan: 0.2 });
      sparkles(k, g, t + 0.06, { n: 7, span: 0.36, vol: 0.08, wet: 3 });
      noise(k, g, t + 0.02, { ft: "highpass", f: 7000, dur: 0.45, vol: 0.04, wet: 2 });
    },

    // Building bought: drawer "ka" + two-note metallic "ching". Quick repeat
    // purchases climb a little ladder instead of repeating the same pitch.
    buy(k, dest, t) {
      const g = group(k, dest, LEVEL.buy);
      k.buyStep = t - k.lastBuy < 1.2 ? (k.buyStep + 1) % 4 : 0;
      k.lastBuy = t;
      const s = [0, 2, 4, 7][k.buyStep];
      noise(k, g, t, { ft: "bandpass", f: 2200, q: 1.4, dur: 0.05, vol: 0.3 });
      tone(k, g, t, { type: "triangle", f: 360, f2: 170, dur: 0.07, vol: 0.28 });
      bell(k, g, t + 0.06, { f: hz(12 + s), ratio: 3.5, index: 1.3, dur: 0.45, vol: 0.17, wet: 2, pan: -0.15 });
      bell(k, g, t + 0.1, { f: hz(19 + s), ratio: 3.5, index: 1.1, dur: 0.55, vol: 0.14, wet: 2, pan: 0.15 });
      sparkles(k, g, t + 0.13, { n: 3, span: 0.12, vol: 0.045, wet: 1 });
    },

    // One-time upgrade: rising fifth (G5 -> D6) then an ascending sparkle.
    upgrade(k, dest, t) {
      const g = group(k, dest, LEVEL.upgrade);
      tone(k, g, t, { wave: "square", f: hz(7) * 0.94, f2: hz(7), glide: 0.03, dur: 0.13, vol: 0.12, lp: 3000 });
      tone(k, g, t, { f: hz(19), dur: 0.13, vol: 0.05 });
      tone(k, g, t + 0.1, {
        wave: "square", f: hz(14) * 0.94, f2: hz(14), glide: 0.03, dur: 0.24, vol: 0.12, lp: 3200,
        sus: 0.6, rel: 0.2, vib: { rate: 6, depth: 10, delay: 0.08 }, wet: 1,
      });
      tone(k, g, t + 0.1, { f: hz(26), dur: 0.3, vol: 0.04 });
      sparkles(k, g, t + 0.18, { n: 5, span: 0.25, notes: [88, 91, 93, 96, 98], vol: 0.065, fade: 0.2, ratio: 2, wet: 3 });
    },

    // Can't afford: two soft, low descending bloops ("uh-uh").
    error(k, dest, t) {
      const g = group(k, dest, LEVEL.error);
      tone(k, g, t, { type: "triangle", f: 300, f2: 240, dur: 0.12, vol: 0.3, lp: 1400 });
      tone(k, g, t, { f: 150, f2: 120, dur: 0.12, vol: 0.18 });
      tone(k, g, t + 0.12, { type: "triangle", f: 225, f2: 165, dur: 0.2, vol: 0.3, lp: 1100 });
      tone(k, g, t + 0.12, { f: 112, f2: 85, dur: 0.2, vol: 0.18 });
    },

    // Big number milestone: brassy C-E-G-C run into a held chord + cymbal.
    milestone(k, dest, t) {
      const g = group(k, dest, LEVEL.milestone);
      [0, 4, 7, 12].forEach((n, i) => {
        const at = t + i * 0.075;
        tone(k, g, at, { wave: "square", f: hz(n), dur: 0.14, vol: 0.1, lp: 2600, pan: (i - 1.5) * 0.15 });
        tone(k, g, at, { type: "triangle", f: hz(n), dur: 0.14, vol: 0.12 });
      });
      const tc = t + 0.3;
      [-12, 0, 4, 7, 12].forEach((n, i) => {
        tone(k, g, tc, {
          wave: i < 2 ? "square" : "pulse25", f: hz(n), dur: 0.5, vol: 0.065, sus: 0.6, rel: 0.3, lp: 2800,
          detune: (rnd() - 0.5) * 10, vib: { rate: 5.5, depth: 9, delay: 0.12 }, wet: 2,
        });
      });
      noise(k, g, t, { ft: "bandpass", f: 1800, dur: 0.1, vol: 0.1 });
      tone(k, g, tc, { f: 130, f2: 50, dur: 0.25, vol: 0.35 });
      noise(k, g, tc, { ft: "highpass", f: 6000, dur: 0.9, vol: 0.05, wet: 2 });
    },

    // Achievement: bell-like G-C-E-G jingle, then a shimmer.
    achievement(k, dest, t) {
      const g = group(k, dest, LEVEL.achievement);
      [[7, 0], [12, 0.09], [16, 0.18], [19, 0.3]].forEach((p, i) => {
        const last = i === 3;
        tone(k, g, t + p[1], { type: "triangle", f: hz(p[0]), dur: last ? 0.7 : 0.16, vol: 0.18, wet: 2 });
        bell(k, g, t + p[1], { f: hz(p[0] + 12), ratio: 2, index: 1, dur: last ? 0.9 : 0.3, vol: 0.07, wet: 3 });
      });
      sparkles(k, g, t + 0.32, { n: 9, span: 0.6, vol: 0.055, ratio: 2, wet: 3 });
      noise(k, g, t + 0.3, { ft: "highpass", f: 5000, f2: 9000, dur: 0.8, vol: 0.04, atk: 0.05, wet: 3 });
    },

    // Golden coin appeared: a soft harp-like twinkle drifting left to right.
    goldenSpawn(k, dest, t) {
      const g = group(k, dest, LEVEL.goldenSpawn);
      [12, 14, 16, 19, 21, 24].forEach((n, i) => {
        bell(k, g, t + i * 0.05, { f: hz(n), ratio: 2, index: 0.5, dur: 0.6, vol: 0.055, pan: -0.5 + i * 0.2, wet: 3 });
      });
    },

    // Golden coin caught: bright upward glide, then a shower of coins.
    goldenCatch(k, dest, t) {
      const g = group(k, dest, LEVEL.goldenCatch);
      tone(k, g, t, { type: "triangle", f: hz(-5), f2: hz(24), glide: 0.22, dur: 0.26, vol: 0.18, atk: 0.01 });
      tone(k, g, t, { f: hz(-17), f2: hz(12), glide: 0.22, dur: 0.26, vol: 0.14, atk: 0.01 });
      bell(k, g, t + 0.2, { f: hz(24), ratio: 3.5, index: 1, dur: 0.7, vol: 0.1, wet: 2 });
      sparkles(k, g, t + 0.16, { n: 12, span: 0.6, vol: 0.1, fade: 0.8, wet: 2 });
    },

    // Frenzy buff: filtered saw sweep + noise riser landing on a chord.
    frenzyStart(k, dest, t) {
      const g = group(k, dest, LEVEL.frenzyStart);
      [-8, 8].forEach((d) => {
        tone(k, g, t, {
          type: "sawtooth", f: 110, f2: 440, glide: 0.5, dur: 0.52, vol: 0.08, atk: 0.02, sus: 1, rel: 0.08,
          lp: 350, lp2: 3200, lpTime: 0.5, q: 4, detune: d, pan: d / 20,
        });
      });
      noise(k, g, t, { ft: "bandpass", f: 700, f2: 7000, sweep: 0.5, q: 1.2, dur: 0.56, vol: 0.09, atk: 0.42 });
      const ts = t + 0.5;
      [0, 4, 7, 12].forEach((n, i) => {
        tone(k, g, ts, { wave: "square", f: hz(n), dur: 0.36, vol: 0.06, lp: 3000, sus: 0.5, rel: 0.25, wet: 2, pan: (i - 1.5) * 0.2 });
      });
      sparkles(k, g, ts, { n: 5, span: 0.2, vol: 0.05, wet: 3 });
    },

    // Rebirth: ~1.7 s rising whoosh, then a boom, a big C chord and chimes.
    rebirth(k, dest, t) {
      const g = group(k, dest, LEVEL.rebirth);
      const rise = 1.7;
      noise(k, g, t, { ft: "bandpass", f: 180, f2: 6000, sweep: rise, q: 1.6, dur: rise + 0.3, vol: 0.28, atk: rise * 0.9, wet: 3 });
      [-10, 0, 10].forEach((d) => {
        tone(k, g, t, {
          type: "sawtooth", f: 65.4, f2: 523, glide: rise, dur: rise, vol: 0.05, atk: rise * 0.85, sus: 1, rel: 0.1,
          lp: 300, lp2: 3500, lpTime: rise, q: 3, detune: d, pan: d / 25,
        });
      });
      const th = t + rise;
      tone(k, g, th, { f: 110, f2: 38, dur: 0.7, vol: 0.45 });
      noise(k, g, th, { ft: "lowpass", f: 3000, f2: 300, sweep: 0.6, dur: 0.8, vol: 0.18, wet: 3 });
      [-12, -5, 0, 4, 7, 12].forEach((n, i) => {
        tone(k, g, th, {
          wave: i < 3 ? "square" : undefined, type: "triangle", f: hz(n), dur: 1.3, vol: i < 3 ? 0.055 : 0.09,
          sus: 0.55, dec: 0.3, rel: 0.6, lp: i < 3 ? 2400 : 0, detune: (rnd() - 0.5) * 12,
          vib: i === 5 ? { rate: 5.5, depth: 12, delay: 0.3 } : null, pan: (i - 2.5) * 0.12, wet: 3,
        });
      });
      [12, 16, 19, 24].forEach((n, i) => {
        bell(k, g, th + 0.1 + i * 0.08, { f: hz(n), ratio: 2, index: 1.2, dur: 1.1, vol: 0.09, pan: -0.3 + i * 0.2, wet: 3 });
      });
      sparkles(k, g, th + 0.3, { n: 8, span: 0.8, vol: 0.045, wet: 3 });
    },

    // UI tab switch: a tiny, quiet tick.
    tab(k, dest, t) {
      const g = group(k, dest, LEVEL.tab);
      tone(k, g, t, { f: 1500, f2: 1100, dur: 0.035, vol: 0.06, atk: 0.001 });
      noise(k, g, t, { ft: "highpass", f: 5000, dur: 0.01, vol: 0.035, atk: 0.0005 });
    },

    // Skin unlocked: quick ascending sparkle ending on a bell.
    unlock(k, dest, t) {
      const g = group(k, dest, LEVEL.unlock);
      [12, 14, 16, 19, 21, 24].forEach((n, i) => {
        tone(k, g, t + i * 0.04, { type: "triangle", f: hz(n), dur: 0.16, vol: 0.09, pan: -0.4 + i * 0.16 });
      });
      bell(k, g, t + 0.24, { f: hz(24), ratio: 2, index: 1.5, dur: 0.8, vol: 0.11, wet: 3 });
      tone(k, g, t + 0.24, { f: hz(12), dur: 0.5, vol: 0.1, wet: 2 });
      sparkles(k, g, t + 0.26, { n: 6, span: 0.45, vol: 0.05, ratio: 2, wet: 3 });
      noise(k, g, t + 0.2, { ft: "highpass", f: 7000, dur: 0.5, vol: 0.035, wet: 3 });
    },

    // Skin equipped: a soft "clk-pop".
    equip(k, dest, t) {
      const g = group(k, dest, LEVEL.equip);
      noise(k, g, t, { ft: "bandpass", f: 3000, q: 1, dur: 0.015, vol: 0.1, atk: 0.001 });
      tone(k, g, t, { f: 520, f2: 820, glide: 0.03, dur: 0.1, vol: 0.28, atk: 0.002 });
      tone(k, g, t + 0.055, { f: 1040, f2: 1240, glide: 0.02, dur: 0.08, vol: 0.1 });
    },
  };
  const SFX_NAMES = Object.keys(SFX);

  // ---------------------------------------------------------------
  // Music: instruments
  // ---------------------------------------------------------------
  const INST = {
    // timbre 0: soft square with delayed vibrato; 1: mellow triangle "flute"
    lead(k, t, note, dur, timbre) {
      const flute = timbre === 1;
      tone(k, k.musicIn, t, {
        wave: flute ? undefined : "square", type: "triangle", f: mtof(note), dur, vol: flute ? 0.3 : 0.17,
        atk: 0.008, sus: 0.7, dec: 0.1, rel: 0.08, lp: flute ? 0 : 3000,
        vib: dur > 0.24 ? { rate: 5.6, depth: flute ? 16 : 11, delay: 0.12 } : null, also: k.echoIn,
      });
    },
    harmony(k, t, note, dur) {
      tone(k, k.musicIn, t, { type: "triangle", f: mtof(note), dur, vol: 0.13, atk: 0.01, sus: 0.6, rel: 0.08, pan: -0.25 });
    },
    bass(k, t, note, dur) {
      tone(k, k.musicIn, t, { type: "triangle", f: mtof(note), dur, vol: 0.27, atk: 0.004, sus: 0.65, dec: 0.1, rel: 0.03 });
    },
    arp(k, t, note, vol, pan) {
      tone(k, k.musicIn, t, { wave: "pulse25", f: mtof(note), dur: 0.13, vol, lp: 2400, pan });
    },
    stab(k, t, note) {
      tone(k, k.musicIn, t, { wave: "pulse12", f: mtof(note), dur: 0.08, vol: 0.06, lp: 3000 });
    },
    sparkle(k, t, note, pan) {
      tone(k, k.musicIn, t, { f: mtof(note), dur: 0.09, vol: 0.04, atk: 0.002, pan });
    },
    kick(k, t, v) {
      tone(k, k.musicIn, t, { f: 150, f2: 45, glide: 0.09, dur: 0.2, vol: 0.5 * v, atk: 0.002 });
      tone(k, k.musicIn, t, { type: "triangle", f: 700, f2: 150, dur: 0.02, vol: 0.12 * v, atk: 0.001 });
    },
    snare(k, t, v) {
      noise(k, k.musicIn, t, { ft: "bandpass", f: 1900, q: 0.7, dur: 0.14, vol: 0.3 * v, atk: 0.001 });
      tone(k, k.musicIn, t, { type: "triangle", f: 200, f2: 150, dur: 0.07, vol: 0.18 * v, atk: 0.001 });
    },
    hat(k, t, v, open) {
      noise(k, k.musicIn, t, { ft: "highpass", f: 7500, dur: open ? 0.16 : 0.035, vol: 0.07 * v, atk: 0.001, pan: 0.2 });
    },
    crash(k, t) {
      noise(k, k.musicIn, t, { ft: "highpass", f: 4500, dur: 1.4, vol: 0.07, atk: 0.002, pan: -0.15 });
    },
  };

  // ---------------------------------------------------------------
  // Music: the composition (original). C major, 16 bars.
  // ---------------------------------------------------------------
  // Chord -> [bass root (MIDI), arpeggio tones low..high]
  const CHORDS = {
    C: [48, [60, 64, 67, 72]],
    F: [41, [60, 65, 69, 72]],
    G: [43, [59, 62, 67, 71]],
    Am: [45, [60, 64, 69, 72]],
    Em: [40, [59, 64, 67, 71]],
    Dm: [50, [62, 65, 69, 74]],
    Dm7: [50, [60, 62, 65, 69]],
  };
  // Chord for each half bar. A = bars 1-8, B = bars 9-16.
  const FORM = [
    ["C", "C"], ["F", "F"], ["Am", "Am"], ["G", "G"], ["C", "C"], ["F", "F"], ["Dm7", "G"], ["C", "C"],
    ["F", "F"], ["G", "G"], ["Em", "Em"], ["Am", "Am"], ["Dm", "Dm"], ["G", "G"], ["F", "F"], ["G", "G"],
  ];
  // Lead melody per bar: [16th step, MIDI note, length in 16ths]. Kept sparse:
  // a hook plus an answer, with space for the arpeggios to breathe.
  const LEAD = [
    [[0, 72, 3], [3, 76, 3], [6, 79, 6], [12, 81, 2], [14, 79, 2]],
    [[0, 77, 3], [3, 76, 3], [6, 72, 6]],
    [[0, 72, 3], [3, 76, 3], [6, 81, 6], [12, 79, 2], [14, 76, 2]],
    [[0, 74, 6], [6, 71, 2], [8, 67, 5], [14, 71, 2]],
    [[0, 72, 3], [3, 76, 3], [6, 79, 6], [12, 81, 2], [14, 79, 2]],
    [[0, 81, 3], [3, 79, 3], [6, 77, 2], [8, 76, 2], [10, 77, 2], [12, 81, 4]],
    [[0, 77, 3], [3, 76, 3], [6, 74, 2], [8, 71, 3], [11, 74, 3], [14, 79, 2]],
    [[0, 76, 2], [2, 72, 6]],
    // B: a sequence that climbs through the chords, different rhythm to A
    [[0, 69, 2], [2, 72, 2], [4, 77, 6], [12, 76, 2], [14, 77, 2]],
    [[0, 79, 4], [4, 74, 4], [8, 71, 6]],
    [[0, 67, 2], [2, 71, 2], [4, 76, 6], [12, 74, 2], [14, 76, 2]],
    [[0, 76, 4], [4, 72, 4], [8, 69, 6]],
    [[0, 69, 2], [2, 74, 2], [4, 77, 6], [12, 76, 2], [14, 77, 2]],
    [[0, 79, 4], [4, 77, 2], [6, 74, 2], [8, 71, 6]],
    [[0, 69, 3], [3, 72, 3], [6, 77, 2], [8, 81, 6], [14, 79, 2]],
    [[0, 79, 8], [8, 74, 4]],
  ].map(bySteps);

  // Bass patterns: [step, semitones above root, length in 16ths]
  const BASS_A = bySteps([[0, 0, 3], [3, 0, 1], [4, 12, 2], [6, 0, 2], [8, 0, 3], [11, 0, 1], [12, 12, 2], [14, 7, 2]]);
  const BASS_HALF = bySteps([[0, 0, 6], [6, 0, 2], [8, 12, 4], [12, 7, 4]]);
  const BASS_DRIVE = bySteps([[0, 0, 2], [2, 0, 2], [4, 12, 2], [6, 0, 2], [8, 0, 2], [10, 7, 2], [12, 12, 2], [14, 7, 2]]);
  const BASS_PUMP = bySteps([[0, 0, 1], [2, 12, 1], [4, 0, 1], [6, 12, 1], [8, 0, 1], [10, 12, 1], [12, 0, 1], [14, 12, 1]]);

  const ARP_A = [0, 1, 2, 3, 2, 1, 2, 3]; // 8th-note up/down figure
  const SPARK_ORDER = [3, 2, 1, 2, 3, 1, 2, 0, 3, 2, 1, 2, 3, 2, 1, 0];

  // [[step, ...rest], ...] -> 16-slot array of rest (or undefined)
  function bySteps(list) {
    const slots = new Array(16);
    list.forEach((e) => (slots[e[0]] = e.slice(1)));
    return slots;
  }

  // Diatonic third below (C major), for the frenzy harmony line.
  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  function thirdBelow(n) {
    const pc = n % 12;
    let i = SCALE.indexOf(pc);
    if (i < 0) return n - 3;
    let base = n - pc;
    i -= 2;
    if (i < 0) {
      i += 7;
      base -= 12;
    }
    return base + SCALE[i];
  }

  // Schedule everything that happens on one 16th step at time t.
  // s = { step, intensity, pending }. Layers change only on bar lines.
  function scheduleStep(k, s, t) {
    const st = s.step % 16;
    const bar = Math.floor(s.step / 16) % 16;
    const pass = Math.floor(s.step / 256) % 3; // 3 passes with different arrangements
    if (st === 0) s.intensity = s.pending;
    const hot = s.intensity > 0;
    const B = bar >= 8;
    const chord = CHORDS[FORM[bar][st < 8 ? 0 : 1]];
    const root = chord[0];
    const tones = chord[1];

    // Drums --------------------------------------------------------
    const fill = (bar === 7 && st >= 14) || (bar === 15 && st >= 12);
    if (fill) INST.snare(k, t, bar === 7 ? 0.55 + (st - 14) * 0.25 : 0.35 + (st - 12) * 0.2);
    if ((bar === 0 || bar === 8) && st === 0) INST.crash(k, t);
    if (hot) {
      if (st % 4 === 0) INST.kick(k, t, 1);
      if (!fill && (st === 4 || st === 12)) INST.snare(k, t, 1);
      INST.hat(k, t, st % 2 ? 0.6 : st % 4 ? 1 : 0.7, st === 14);
    } else if (B && bar < 12) {
      // half-time feel for the first half of B
      if (st === 0 || st === 11) INST.kick(k, t, st ? 0.7 : 1);
      if (st === 8) INST.snare(k, t, 0.9);
      if (st % 2 === 0) INST.hat(k, t, st % 4 ? 1 : 0.55, false);
    } else {
      if (st === 0 || st === 8 || (st === 10 && bar % 2 === 1)) INST.kick(k, t, st ? 0.8 : 1);
      if (!fill && (st === 4 || st === 12)) INST.snare(k, t, 1);
      if (st % 4 === 2) INST.hat(k, t, 1, B && st === 14);
      if (B && st % 4 === 0) INST.hat(k, t, 0.45, false);
    }

    // Bass ---------------------------------------------------------
    const bp = (hot ? BASS_PUMP : !B ? BASS_A : bar < 12 ? BASS_HALF : BASS_DRIVE)[st];
    if (bp) INST.bass(k, t, root + bp[0], bp[1] * STEP * 0.9);

    // Lead (+ harmony in frenzy) -----------------------------------
    let leadOn = true;
    let timbre = 0;
    if (!hot) {
      if (!B && pass === 1 && bar < 4) leadOn = false; // let the arps carry it
      if ((!B && pass === 2) || (B && pass === 1 && bar >= 12)) timbre = 1;
    }
    const ln = LEAD[bar][st];
    if (ln && leadOn) {
      const dur = Math.max(0.07, ln[1] * STEP - 0.02);
      INST.lead(k, t, ln[0], dur, timbre);
      if (hot) INST.harmony(k, t, thirdBelow(ln[0]), dur);
    }

    // Arpeggios ----------------------------------------------------
    if (!B) {
      if (st % 2 === 0) INST.arp(k, t, tones[ARP_A[st / 2]], leadOn ? 0.085 : 0.11, st % 4 ? 0.25 : -0.25);
    } else if (bar < 12) {
      if (st % 4 === 2) {
        INST.stab(k, t, tones[1]);
        INST.stab(k, t, tones[2]);
      }
    } else {
      INST.arp(k, t, tones[st % 4], 0.055, st % 2 ? 0.3 : -0.3); // 16th build-up
    }
    if (hot) INST.sparkle(k, t, tones[SPARK_ORDER[st]] + 24, st % 2 ? 0.5 : -0.5);
  }

  // ---------------------------------------------------------------
  // Live engine
  // ---------------------------------------------------------------
  let ctx = null;
  let kit = null;
  let sfxOn = true;
  let musicOn = true;
  let musicState = "off"; // "off" | "on" | "stopping"
  let appPaused = false;
  let hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  let timer = 0;
  let stopTimer = 0;
  let lastGestureResume = 0; // when init() last asked a suspended context to resume
  let analyser = null;
  let meterBuf = null;
  const seq = { step: 0, nextTime: 0, intensity: 0, pending: 0 };

  const paused = () => appPaused || hidden;

  function tick() {
    try {
      if (!ctx || ctx.state !== "running") return;
      const now = ctx.currentTime;
      // Fell far behind (throttled timer)? Skip ahead rather than burst.
      if (seq.nextTime < now - 0.1) seq.nextTime = now + 0.02;
      while (seq.nextTime < now + LOOKAHEAD) {
        scheduleStep(kit, seq, seq.nextTime);
        seq.step++;
        seq.nextTime += STEP;
      }
    } catch (_) {}
  }

  function runScheduler() {
    if (timer || !ctx || ctx.state !== "running" || paused() || musicState === "off") return;
    seq.nextTime = ctx.currentTime + 0.05;
    timer = setInterval(tick, TICK_MS);
    tick();
  }

  function haltScheduler() {
    if (timer) clearInterval(timer);
    timer = 0;
  }

  function fadeTo(v, dur) {
    const p = kit.musicFade.gain;
    const now = ctx.currentTime;
    const from = p.value;
    p.cancelScheduledValues(now);
    p.setValueAtTime(from, now);
    p.linearRampToValueAtTime(v, now + dur);
  }

  function startMusic() {
    if (!kit) return;
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = 0;
    if (musicState === "off") {
      seq.step = 0;
      seq.intensity = seq.pending;
      kit.musicFade.gain.cancelScheduledValues(ctx.currentTime);
      kit.musicFade.gain.setValueAtTime(0, ctx.currentTime);
      fadeTo(1, FADE_IN);
    } else if (musicState === "stopping") {
      fadeTo(1, FADE_IN * 0.5);
    }
    musicState = "on";
    runScheduler();
  }

  function stopMusic() {
    if (!kit || musicState !== "on") return;
    musicState = "stopping";
    fadeTo(0, FADE_OUT);
    stopTimer = setTimeout(() => {
      stopTimer = 0;
      haltScheduler();
      musicState = "off";
    }, FADE_OUT * 1000 + 80);
  }

  // Re-evaluate whether the scheduler should be running.
  function sync() {
    if (!ctx) return;
    if (paused()) haltScheduler();
    else if (ctx.state === "running" && musicState !== "off") runScheduler();
  }

  function askResume() {
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    try {
      const p = ctx.resume();
      if (p && p.then) p.then(sync, noop);
    } catch (_) {}
  }

  function applyPause() {
    if (!ctx) return;
    if (paused()) {
      haltScheduler();
      try {
        if (ctx.state === "running") {
          const p = ctx.suspend();
          if (p && p.catch) p.catch(noop);
        }
      } catch (_) {}
    } else {
      askResume();
      sync();
    }
  }

  function createContext() {
    try {
      ctx = new AC({ latencyHint: "interactive" });
    } catch (_) {
      ctx = new AC();
    }
    kit = buildKit(ctx);
    ctx.onstatechange = () => {
      try {
        sync();
      } catch (_) {}
    };
  }

  // iOS needs a sound started inside the gesture to fully unlock output.
  function unlockTick() {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch (_) {}
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
      try {
        hidden = document.visibilityState === "hidden";
        applyPause();
      } catch (_) {}
    });
  }

  // ---------------------------------------------------------------
  // Offline rendering (test hook)
  // ---------------------------------------------------------------
  const SFX_LEN = { rebirth: 4.2, achievement: 2.2, goldenCatch: 2, milestone: 2, crit: 1.8, unlock: 2 };

  function measure(buf) {
    let peak = 0;
    let sum = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const v = d[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
      }
    }
    return { peak, rms: Math.sqrt(sum / (buf.length * buf.numberOfChannels)) };
  }

  function renderJob(seconds, rate, build, keep) {
    const oc = new OAC(2, Math.ceil(seconds * rate), rate);
    const k = buildKit(oc);
    build(k);
    return new Promise((resolve, reject) => {
      let done = false;
      const finishWith = (b) => {
        if (done) return;
        done = true;
        const m = measure(b);
        if (keep) m.buffer = b;
        resolve(m);
      };
      oc.oncomplete = (e) => finishWith(e.renderedBuffer);
      const p = oc.startRendering();
      if (p && p.then) p.then(finishWith, reject);
    });
  }

  function bookMusic(k, from, to, frenzyAt) {
    k.musicFade.gain.value = 1;
    const s = { step: 0, intensity: 0, pending: 0 };
    for (let t = from; t < to; t += STEP) {
      if (t >= frenzyAt) s.pending = 1;
      scheduleStep(k, s, t);
      s.step++;
    }
  }

  function playAt(k, name, t, opts) {
    if (allow(k, name, t)) SFX[name](k, k.sfxIn, t, opts || {});
  }

  function renderOffline(seconds, keepBuffers) {
    if (!OAC) return Promise.resolve({ error: "OfflineAudioContext unsupported" });
    const secs = clamp(+seconds || 20, 1, 120);
    const rate = 44100;
    const savedSeed = seed;
    seed = 20261006;
    try {
      // 1) music alone; frenzy layers from halfway
      const music = renderJob(secs, rate, (k) => bookMusic(k, 0.05, secs, secs / 2), keepBuffers);
      // 2) each effect alone. Effects start at WARM s: a fresh compressor
      // starts with its gain pulled down and needs ~0.3 s to settle.
      const WARM = 0.5;
      const each = SFX_NAMES.map((name) =>
        renderJob(WARM + (SFX_LEN[name] || 1.5), rate, (k) => playAt(k, name, WARM, { combo: 12 }), keepBuffers),
      );
      // 3) stress: 200 clicks in 4 s with a rising combo
      const burst = renderJob(WARM + 4.6, rate, (k) => {
        for (let i = 0; i < 200; i++) playAt(k, "pop", WARM + i * 0.02, { combo: i + 1 });
      });
      // 4) everything at once: music + every effect in turn + a click burst
      let at = 0.4;
      const plan = SFX_NAMES.map((name) => {
        const e = [name, at];
        at += Math.min(SFX_LEN[name] || 1.5, 2.2) * 0.7;
        return e;
      });
      const mixLen = Math.max(secs, at + 3);
      const all = renderJob(mixLen, rate, (k) => {
        bookMusic(k, 0.05, secs, secs / 2);
        for (let i = 0; i < 120; i++) playAt(k, "pop", 1 + i * 0.033, { combo: i + 1 });
        plan.forEach((p) => playAt(k, p[0], p[1], { combo: 20 }));
        playAt(k, "crit", 2.2);
        playAt(k, "buy", 2.25);
      }, keepBuffers);
      return Promise.all([music, burst, all].concat(each)).then((r) => {
        const perSoundPeaks = {};
        const perSoundRms = {};
        SFX_NAMES.forEach((name, i) => {
          perSoundPeaks[name] = r[3 + i].peak;
          perSoundRms[name] = r[3 + i].rms;
        });
        const res = {
          peak: r[2].peak,
          rms: r[2].rms,
          musicPeak: r[0].peak,
          musicRms: r[0].rms,
          popBurstPeak: r[1].peak,
          popBurstRms: r[1].rms,
          perSoundPeaks,
          perSoundRms,
          seconds: secs,
          mixSeconds: mixLen,
          sampleRate: rate,
        };
        if (keepBuffers) {
          res.buffers = { music: r[0].buffer, mix: r[2].buffer, sfx: {} };
          SFX_NAMES.forEach((name, i) => (res.buffers.sfx[name] = r[3 + i].buffer));
        }
        return res;
      }, (e) => ({ error: String(e) }));
    } catch (e) {
      return Promise.resolve({ error: String(e) });
    } finally {
      seed = savedSeed;
    }
  }

  // Rate limit + voice budget, shared by live and offline playback.
  function allow(k, name, t) {
    if (t - (k.last[name] === undefined ? -99 : k.last[name]) < (MIN_GAP[name] || 0.03)) return false;
    k.voiceEnds = k.voiceEnds.filter((e) => e > t);
    if (k.voiceEnds.length > MAX_VOICES && LOW_PRIORITY[name]) return false;
    k.last[name] = t;
    return true;
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------
  window.DCAudio = {
    init() {
      try {
        if (!AC) return;
        if (!ctx) createContext();
        if (!paused() && ctx.state !== "running") {
          lastGestureResume = Date.now();
          unlockTick();
          askResume();
        }
        if (musicOn && musicState !== "on") startMusic();
        else sync();
      } catch (_) {}
    },

    setSfxEnabled(on) {
      try {
        sfxOn = !!on;
      } catch (_) {}
    },

    setMusicEnabled(on) {
      try {
        musicOn = !!on;
        if (!ctx) return;
        if (musicOn) startMusic();
        else stopMusic();
      } catch (_) {}
    },

    setIntensity(level) {
      try {
        seq.pending = +level > 0 ? 1 : 0;
      } catch (_) {}
    },

    pause() {
      try {
        appPaused = true;
        applyPause();
      } catch (_) {}
    },

    resume() {
      try {
        appPaused = false;
        applyPause();
      } catch (_) {}
    },

    play(name, opts) {
      try {
        if (!sfxOn || !kit || paused()) return;
        const fn = SFX[name];
        if (!fn) return;
        // Sounds booked on a suspended clock all burst out on resume, so only
        // allow that right after a gesture-driven init() (the first tap).
        if (ctx.state !== "running" && Date.now() - lastGestureResume > 500) return;
        const t = ctx.currentTime + 0.005;
        if (!allow(kit, name, t)) return;
        fn(kit, kit.sfxIn, t, opts || {});
      } catch (_) {}
    },

    // Test hook: render music + every effect offline with the same synthesis
    // code. Resolves { peak, rms, musicPeak, musicRms, popBurstPeak,
    // perSoundPeaks, perSoundRms, ... } (or { error }).
    _renderOffline(seconds, keepBuffers) {
      try {
        return renderOffline(seconds, keepBuffers);
      } catch (e) {
        return Promise.resolve({ error: String(e) });
      }
    },

    // Test hook: peak of the last ~46 ms of live output (0 if no context).
    _meter() {
      try {
        if (!kit) return 0;
        if (!analyser) {
          analyser = ctx.createAnalyser();
          analyser.fftSize = 2048;
          meterBuf = new Float32Array(analyser.fftSize);
          kit.out.connect(analyser);
        }
        analyser.getFloatTimeDomainData(meterBuf);
        let peak = 0;
        for (let i = 0; i < meterBuf.length; i++) peak = Math.max(peak, Math.abs(meterBuf[i]));
        return peak;
      } catch (_) {
        return 0;
      }
    },

    // Test hook: engine state snapshot.
    _debug() {
      try {
        return {
          context: ctx ? ctx.state : "none",
          time: ctx ? ctx.currentTime : 0,
          sfx: sfxOn,
          music: musicOn,
          musicState,
          scheduler: !!timer,
          step: seq.step,
          intensity: seq.intensity,
          pendingIntensity: seq.pending,
          paused: paused(),
        };
      } catch (_) {
        return {};
      }
    },
  };
})();
