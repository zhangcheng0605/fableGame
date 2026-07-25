// 05-util.js — PI.U : pure, allocation-light math / easing / random / glyph helpers.
// Only assignments onto PI. Everything private lives inside the IIFE.
PI.U = (function () {

  // ---------------------------------------------------------------- glyph sets
  // Dense code-ish set for the falling code-rain (latin, digits, brackets,
  // operators + a few half-width katakana for the Matrix flavour).
  // Half-width katakana is used deliberately: full-width forms break the
  // monospace column grid the rain is drawn on.
  const ASCII_GLYPHS =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
    '{}[]()<>/\\|!@#$%^&*+-=_~;:.,?\'"`';
  const KATAKANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
  const GLYPHS = ASCII_GLYPHS + KATAKANA;
  // scramble/decode uses the ascii-only subset so every substituted character
  // is guaranteed the same advance width as the letter it stands in for.
  const SCRAMBLE_SET = ASCII_GLYPHS;

  // ---------------------------------------------------------------- random
  function rand(a, b) { if (b === undefined) { b = a; a = 0; } return a + Math.random() * (b - a); }
  function randInt(a, b) { if (b === undefined) { b = a; a = 0; } return Math.floor(a + Math.random() * (b - a + 1)); }
  function pick(arr) { return (arr && arr.length) ? arr[(Math.random() * arr.length) | 0] : undefined; }
  function chance(p) { return Math.random() < p; }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  // weightFn(item, index) -> non-negative weight. Returns undefined for empty input.
  function weightedPick(items, weightFn) {
    if (!items || !items.length) return undefined;
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      const w = weightFn ? weightFn(items[i], i) : (items[i] && items[i].weight) || 0;
      if (w > 0) total += w;
    }
    if (total <= 0) return items[(Math.random() * items.length) | 0];
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
      const w = weightFn ? weightFn(items[i], i) : (items[i] && items[i].weight) || 0;
      if (w <= 0) continue;
      r -= w;
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  // ---------------------------------------------------------------- math
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // frame-rate independent exponential smoothing toward b
  function damp(a, b, lambda, dt) { return b + (a - b) * Math.exp(-lambda * dt); }
  function approach(cur, tgt, step) {
    if (cur < tgt) { cur += step; return cur > tgt ? tgt : cur; }
    if (cur > tgt) { cur -= step; return cur < tgt ? tgt : cur; }
    return tgt;
  }
  // smoothstep(t) or smoothstep(edge0, edge1, x)
  function smoothstep(a, b, x) {
    let t;
    if (b === undefined) t = clamp(a, 0, 1);
    else t = clamp((x - a) / (b - a || 1e-9), 0, 1);
    return t * t * (3 - 2 * t);
  }
  // squared distance (no sqrt) — cheap for radius comparisons
  function dist2(x0, y0, x1, y1) { const dx = x1 - x0, dy = y1 - y0; return dx * dx + dy * dy; }
  function dist(x0, y0, x1, y1) { return Math.sqrt(dist2(x0, y0, x1, y1)); }
  // rotate (x,y) by ang radians. Pass `out` to avoid allocation in hot paths.
  function rotate2(x, y, ang, out) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const rx = x * c - y * s, ry = x * s + y * c;
    if (out) { out.x = rx; out.y = ry; return out; }
    return { x: rx, y: ry };
  }
  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() / 1000 : Date.now() / 1000;
  }

  // ---------------------------------------------------------------- easing
  // DESIGN.md 11.5: nothing moves linearly. Standard Penner constants.
  const BACK_C1 = 1.70158, BACK_C3 = BACK_C1 + 1, ELASTIC_C4 = (2 * Math.PI) / 3;
  function easeOutCubic(t) { t = clamp(t, 0, 1); const u = 1 - t; return 1 - u * u * u; }
  function easeInCubic(t) { t = clamp(t, 0, 1); return t * t * t; }
  function easeInOutQuad(t) {
    t = clamp(t, 0, 1);
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
  function easeOutQuint(t) { t = clamp(t, 0, 1); const u = 1 - t; return 1 - u * u * u * u * u; }
  function easeOutBack(t) {
    t = clamp(t, 0, 1);
    const u = t - 1;
    return 1 + BACK_C3 * u * u * u + BACK_C1 * u * u;
  }
  function easeOutElastic(t) {
    t = clamp(t, 0, 1);
    if (t === 0) return 0;
    if (t === 1) return 1;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_C4) + 1;
  }

  // ---------------------------------------------------------------- spring
  // Semi-implicit Euler spring. state = {v, vel} and is MUTATED; returns state.v.
  // Sub-stepped at 1/240s so it stays stable at 60fps and at the 50ms dt clamp
  // even with stiff settings.
  function spring(state, target, dt, stiffness, damping) {
    if (!state) return target;
    if (typeof state.v !== 'number' || !isFinite(state.v)) state.v = target || 0;
    if (typeof state.vel !== 'number' || !isFinite(state.vel)) state.vel = 0;
    const k = (stiffness === undefined || stiffness === null) ? 180 : stiffness;
    const d = (damping === undefined || damping === null) ? 18 : damping;
    let remaining = clamp(dt || 0, 0, 0.05);
    const MAX_H = 1 / 240;
    while (remaining > 0) {
      const h = remaining > MAX_H ? MAX_H : remaining;
      remaining -= h;
      const accel = (target - state.v) * k - state.vel * d;
      state.vel += accel * h;
      state.v += state.vel * h;
    }
    if (!isFinite(state.v)) { state.v = target; state.vel = 0; }
    return state.v;
  }

  // ---------------------------------------------------------------- counter
  // Tweened number for score / integrity. .value eases toward .target over
  // TUNING.juice.counterMs (default 300ms, cubic ease-out). Writing .target
  // directly also re-triggers the tween on the next update().
  function counterDurationSeconds() {
    const j = PI.TUNING && PI.TUNING.juice;
    const ms = (j && typeof j.counterMs === 'number') ? j.counterMs : 300;
    return ms / 1000;
  }
  function counter(initial) {
    const start = (typeof initial === 'number' && isFinite(initial)) ? initial : 0;
    let from = start, elapsed = 0, dur = 0, seen = start;
    function retrigger() {
      from = c.value;
      seen = c.target;
      elapsed = 0;
      dur = counterDurationSeconds();
      if (dur <= 0) { c.value = c.target; }
    }
    const c = {
      value: start,
      target: start,
      set: function (n) {
        if (typeof n !== 'number' || !isFinite(n)) return c.value;
        if (n === c.target) return c.value;
        c.target = n;
        retrigger();
        return c.value;
      },
      add: function (n) { return c.set(c.target + ((typeof n === 'number' && isFinite(n)) ? n : 0)); },
      snap: function (n) {
        if (typeof n === 'number' && isFinite(n)) c.target = n;
        c.value = c.target; from = c.target; seen = c.target; elapsed = 0; dur = 0;
        return c.value;
      },
      update: function (dt) {
        if (c.target !== seen) retrigger();
        if (dur <= 0) { c.value = c.target; return c.value; }
        elapsed += (typeof dt === 'number' && dt > 0) ? dt : 0;
        if (elapsed >= dur) { c.value = c.target; dur = 0; return c.value; }
        c.value = from + (c.target - from) * easeOutCubic(elapsed / dur);
        return c.value;
      },
      done: function () { return dur <= 0 && c.value === c.target; }
    };
    return c;
  }

  // ---------------------------------------------------------------- scramble
  // Left-to-right decode. Unresolved characters show random glyphs that re-roll
  // ~16 times/sec (bucketed), so the text churns without strobing per frame.
  const SCRAMBLE_HZ = 16;
  const scrambleCache = new Map();
  function hash32(a, b, c) {
    let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ b, 0xc2b2ae35);
    h = Math.imul(h ^ c, 0x27d4eb2f);
    h ^= h >>> 15;
    return h >>> 0;
  }
  function strHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  function scramble(target, progress) {
    if (typeof target !== 'string' || target.length === 0) return '';
    const p = clamp(progress, 0, 1);
    if (p >= 1) return target;
    const len = target.length;
    const resolved = Math.floor(p * len);
    const bucket = Math.floor(now() * SCRAMBLE_HZ);
    const seed = strHash(target);
    const key = seed + '|' + resolved + '|' + bucket;
    const hit = scrambleCache.get(key);
    if (hit !== undefined) return hit;
    let out = '';
    for (let i = 0; i < len; i++) {
      const ch = target.charAt(i);
      if (i < resolved || ch === ' ' || ch === '\n') { out += ch; continue; }
      const h = hash32(seed, i, bucket);
      out += SCRAMBLE_SET.charAt(h % SCRAMBLE_SET.length);
    }
    if (scrambleCache.size > 256) scrambleCache.clear();
    scrambleCache.set(key, out);
    return out;
  }

  // ---------------------------------------------------------------- colors
  const hexCache = new Map();
  function hexA(hex, alpha) {
    if (typeof hex !== 'string' || hex.charAt(0) !== '#') return hex;
    const a = clamp(typeof alpha === 'number' ? alpha : 1, 0, 1);
    const key = hex + '|' + (Math.round(a * 1000) / 1000);
    const hit = hexCache.get(key);
    if (hit !== undefined) return hit;
    let r = 0, g = 0, b = 0;
    if (hex.length === 4) {
      r = parseInt(hex.charAt(1) + hex.charAt(1), 16);
      g = parseInt(hex.charAt(2) + hex.charAt(2), 16);
      b = parseInt(hex.charAt(3) + hex.charAt(3), 16);
    } else {
      r = parseInt(hex.substring(1, 3), 16);
      g = parseInt(hex.substring(3, 5), 16);
      b = parseInt(hex.substring(5, 7), 16);
    }
    if (!isFinite(r)) r = 0; if (!isFinite(g)) g = 0; if (!isFinite(b)) b = 0;
    const out = 'rgba(' + r + ',' + g + ',' + b + ',' + (Math.round(a * 1000) / 1000) + ')';
    if (hexCache.size > 512) hexCache.clear();
    hexCache.set(key, out);
    return out;
  }

  // ---------------------------------------------------------------- text
  // wrapText(ctx, text, maxWidthPx) when given a canvas context,
  // wrapText(text, maxChars) otherwise. Returns an array of lines.
  function wrapText(a, b, c) {
    let measure = null, text, limit;
    if (a && typeof a.measureText === 'function') {
      measure = a; text = b; limit = c;
    } else {
      text = a; limit = b;
    }
    if (typeof text !== 'string' || !text.length) return [];
    if (!(limit > 0)) return text.split('\n');
    const lines = [];
    const paras = text.split('\n');
    for (let pi = 0; pi < paras.length; pi++) {
      const words = paras[pi].split(' ');
      let line = '';
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (!w.length && line.length) continue;
        const test = line.length ? line + ' ' + w : w;
        const size = measure ? measure.measureText(test).width : test.length;
        if (size > limit && line.length) { lines.push(line); line = w; }
        else line = test;
      }
      lines.push(line);
    }
    return lines;
  }

  function formatInt(n) {
    let v = (typeof n === 'number' && isFinite(n)) ? Math.round(n) : 0;
    const neg = v < 0;
    if (neg) v = -v;
    let s = String(v), out = '';
    let count = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++count % 3 === 0 && i > 0) out = ',' + out;
    }
    return neg ? '-' + out : out;
  }

  return {
    // random
    rand: rand, randInt: randInt, pick: pick, chance: chance, shuffle: shuffle,
    weightedPick: weightedPick,
    // math
    clamp: clamp, lerp: lerp, damp: damp, approach: approach, smoothstep: smoothstep,
    dist2: dist2, dist: dist, rotate2: rotate2, now: now,
    // easing
    easeOutCubic: easeOutCubic, easeInCubic: easeInCubic, easeInOutQuad: easeInOutQuad,
    easeOutBack: easeOutBack, easeOutElastic: easeOutElastic, easeOutQuint: easeOutQuint,
    // motion helpers
    spring: spring, counter: counter,
    // glyphs / text
    GLYPHS: GLYPHS, GLYPHS_ASCII: ASCII_GLYPHS, KATAKANA: KATAKANA,
    scramble: scramble, wrapText: wrapText, formatInt: formatInt,
    // color
    hexA: hexA
  };
})();
