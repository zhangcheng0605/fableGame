// 20-fx.js — PI.FX : the entire particle / effect layer (DESIGN.md §11 + §11.5).
//
// Design constraints honoured here:
//  * ONE flat pool of particle records (kind tag + union of fields) reused across
//    every kind, plus small dedicated pools for beams / popups / rings.
//    Everything is pre-allocated at load: 900 particles, 64 beams, 48 popups,
//    32 rings. When a pool is exhausted the OLDEST live record is recycled —
//    we never allocate mid-run.
//  * update() iterates with a manual index and swap-removes dead records.
//  * draw() is a single pass grouped by composite mode: all additive
//    ('lighter') geometry first, then normal-composite text. ctx.font /
//    fillStyle / strokeStyle are only assigned when the value actually changes.
//  * Fade is done with ctx.globalAlpha (a number) instead of building
//    'rgba(...)' strings, so the draw loop allocates nothing.
//  * No ctx.filter, no shadowBlur anywhere — bloom is faked with 2–3 layered
//    strokes of decreasing alpha / increasing width (§11.5 perf guardrail).
PI.FX = (function () {
  const U = PI.U;
  const T  = (PI.TUNING && PI.TUNING.fx)    || {};
  const TS = (PI.TUNING && PI.TUNING.score) || {};
  const TC = (PI.TUNING && PI.TUNING.combo) || {};
  const TB = (PI.TUNING && PI.TUNING.boss)  || {};
  const VIEW = (PI.TUNING && PI.TUNING.view) || { W: 1280, H: 720 };

  const CFG_KILL    = T.killSpark       || {};
  const CFG_LETTER  = T.letterExplosion || {};
  const CFG_RING    = T.ring            || {};
  const CFG_BEAM    = T.beam            || {};
  const CFG_GLYPH   = T.glyph           || {};
  const CFG_CONV    = T.converge        || {};
  const CFG_AFTER   = T.afterimage      || {};
  const CFG_SHARD   = T.shard           || {};
  const CFG_POPUP   = T.popup           || {};

  const TAU = Math.PI * 2;
  const POP_TIME = 0.12;          // §11 scale-pop 1.0 -> 1.4 -> 1.0 over 120ms
  const DISP_DECAY = num(T.displaceDecay, 1.4);
  const WHITE = (PI.C && PI.C.white) || '#e6e6e6';
  const INK   = (PI.C && PI.C.ink)   || '#0a0e14';

  // kind tags. Ordered so that "additive geometry" is a single <= compare.
  const K_SPARK = 0, K_TRAIL = 1, K_GLYPH = 2, K_CONVERGE = 3, K_AFTER = 4;

  // ---------------------------------------------------------------- helpers
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  // Accepts a number, a [lo,hi] pair, or undefined -> falls back to `d`
  // (which may itself be a number or a [lo,hi] pair).
  function rng(v, d) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (v && v.length >= 2) return U.rand(v[0], v[1]);
    if (typeof d === 'number') return d;
    if (d && d.length >= 2) return U.rand(d[0], d[1]);
    return 0;
  }
  function rngInt(v, d) { return Math.round(rng(v, d)); }

  // ---------------------------------------------------------------- pools
  const P_CAP = Math.max(64, num(T.maxParticles, 900) | 0);
  const BEAM_CAP = 64, POPUP_CAP = 48, RING_CAP = 32;

  function newParticle() {
    return {
      kind: K_SPARK,
      x: 0, y: 0, x0: 0, y0: 0, x1: 0, y1: 0,
      vx: 0, vy: 0, g: 0, drag: 0,
      rot: 0, spin: 0,
      t: 0, life: 1, invLife: 1, delay: 0,
      size: 2, a0: 1, color: WHITE, ch: '', trailLen: 0.03
    };
  }
  function newBeam() {
    return { x0: 0, y0: 0, x1: 0, y1: 0, t: 0, life: 0.03, invLife: 33,
             width: 2.5, bloom: 9, a0: 1, color: WHITE };
  }
  function newPopup() {
    return { x: 0, y: 0, t: 0, life: 0.85, invLife: 1.17, vy: -46,
             size: 20, pop: 1.35, a0: 1, color: WHITE, text: '' };
  }
  function newRing() {
    return { x: 0, y: 0, r: 0, r0: 6, r1: 74, t: 0, life: 0.42, invLife: 2.38,
             width: 3, a0: 1, color: WHITE, strength: 0, disp: null };
  }

  const parts  = new Array(P_CAP);     let pLive = 0;
  const beams  = new Array(BEAM_CAP);  let bLive = 0;
  const popups = new Array(POPUP_CAP); let uLive = 0;
  const rings  = new Array(RING_CAP);  let rLive = 0;
  for (let i = 0; i < P_CAP; i++)     parts[i]  = newParticle();
  for (let i = 0; i < BEAM_CAP; i++)  beams[i]  = newBeam();
  for (let i = 0; i < POPUP_CAP; i++) popups[i] = newPopup();
  for (let i = 0; i < RING_CAP; i++)  rings[i]  = newRing();

  // Live radial-displacement records, read by the background (§11.5).
  const displacements = [];
  const dispFree = new Array(RING_CAP);
  for (let i = 0; i < RING_CAP; i++) dispFree[i] = { x: 0, y: 0, r: 0, strength: 0 };

  // Pool acquisition. Full pool => recycle the most-progressed (oldest) record.
  // Only reachable when live === CAP, so the whole array is live and the scan
  // can never hand back a dead slot.
  function grab(arr, live, cap) {
    if (live < cap) return arr[live];
    let bi = 0, best = -1;
    for (let i = 0; i < cap; i++) {
      const a = arr[i].t * arr[i].invLife;
      if (a > best) { best = a; bi = i; }
    }
    return arr[bi];
  }
  function allocP() { const p = grab(parts, pLive, P_CAP); if (pLive < P_CAP) pLive++; return p; }
  function allocB() { const p = grab(beams, bLive, BEAM_CAP); if (bLive < BEAM_CAP) bLive++; return p; }
  function allocU() { const p = grab(popups, uLive, POPUP_CAP); if (uLive < POPUP_CAP) uLive++; return p; }
  function allocR() {
    const p = grab(rings, rLive, RING_CAP);
    if (rLive < RING_CAP) rLive++; else releaseDisp(p);   // recycled ring: drop its displacement
    return p;
  }

  function swapOut(arr, i, live) { live--; if (i !== live) { const t = arr[i]; arr[i] = arr[live]; arr[live] = t; } return live; }

  function releaseDisp(r) {
    const d = r.disp;
    if (!d) return;
    r.disp = null;
    for (let i = 0; i < displacements.length; i++) {
      if (displacements[i] === d) {
        displacements[i] = displacements[displacements.length - 1];
        displacements.pop();
        break;
      }
    }
    dispFree.push(d);
  }

  // ---------------------------------------------------------------- spawners
  // spark(x,y,{color,count,speed,life,size,spread,angle,gravity,drag,alpha})
  // Additive dot with velocity, drag and fade. `spread` is the total cone width
  // in radians around `angle` (0 = +x, +y is down); omit for a full circle.
  function spark(x, y, o) {
    o = o || {};
    const n = rngInt(o.count, CFG_KILL.count || [12, 18]);
    const color = o.color || WHITE;
    const spread = num(o.spread, TAU);
    const base = num(o.angle, 0);
    const g = num(o.gravity, 0);
    const drag = num(o.drag, 3.4);
    const a0 = num(o.alpha, 1);
    const half = spread * 0.5;
    for (let i = 0; i < n; i++) {
      const p = allocP();
      const ang = (spread >= TAU) ? Math.random() * TAU : base + U.rand(-half, half);
      const sp = rng(o.speed, CFG_KILL.speed || [120, 340]);
      const life = rng(o.life, CFG_KILL.life || [0.28, 0.62]);
      p.kind = K_SPARK;
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
      p.g = g; p.drag = drag;
      p.rot = 0; p.spin = 0; p.delay = 0;
      p.t = 0; p.life = life > 0.01 ? life : 0.01; p.invLife = 1 / p.life;
      p.size = num(o.size, num(CFG_KILL.size, 2.6));
      p.a0 = a0; p.color = color; p.ch = '';
    }
  }

  // trail(x,y,{color,vx,vy,life,size,len,drag}) — short additive streak drawn
  // along its own velocity (jailbreak dash streaks, speed lines, flow wake).
  function trail(x, y, o) {
    o = o || {};
    const p = allocP();
    p.kind = K_TRAIL;
    p.x = x; p.y = y;
    p.vx = num(o.vx, U.rand(-40, 40)); p.vy = num(o.vy, U.rand(60, 220));
    p.g = num(o.gravity, 0); p.drag = num(o.drag, 1.6);
    p.rot = 0; p.spin = 0; p.delay = num(o.delay, 0);
    const life = rng(o.life, 0.3);
    p.t = 0; p.life = life > 0.01 ? life : 0.01; p.invLife = 1 / p.life;
    p.size = num(o.size, 2.4);
    p.a0 = num(o.alpha, 1);
    p.color = o.color || WHITE;
    p.ch = '';
    p.trailLen = num(o.len, 0.045);
    return p;
  }

  // glyph(x,y,char,{color,vx,vy,life,size,spin,gravity,alpha,delay})
  // A character with gravity + spin + fade — kill letter-explosions and shards.
  function glyph(x, y, char, o) {
    o = o || {};
    const p = allocP();
    p.kind = K_GLYPH;
    p.x = x; p.y = y;
    p.vx = rng(o.vx, CFG_LETTER.vx || [-190, 190]);
    p.vy = rng(o.vy, CFG_LETTER.vy || [-330, -60]);
    p.g = num(o.gravity, num(CFG_GLYPH.gravity, 760));
    p.drag = num(o.drag, 0.15);
    p.rot = num(o.rot, 0);
    p.spin = num(o.spin, U.rand(-1, 1) * num(CFG_GLYPH.spin, 8));
    p.delay = num(o.delay, 0);
    const life = rng(o.life, CFG_GLYPH.life || [0.5, 1.0]);
    p.t = 0; p.life = life > 0.01 ? life : 0.01; p.invLife = 1 / p.life;
    p.size = num(o.size, num(CFG_GLYPH.size, 18));
    p.a0 = num(o.alpha, 1);
    p.color = o.color || WHITE;
    p.ch = (char === undefined || char === null || char === '') ? U.pick(U.GLYPHS) : String(char);
    return p;
  }

  // converge(x,y,char,{color,life,size,dist,angle,x0,y0,spin,alpha,delay})
  // Glyph flying from an offset INTO (x,y) over its life on easeOutCubic —
  // enemy materialize (§11.5) and the title-logo assembly.
  function converge(x, y, char, o) {
    o = o || {};
    const p = allocP();
    const dist = num(o.dist, num(CFG_CONV.jitter, 120));
    const ang = num(o.angle, Math.random() * TAU);
    p.kind = K_CONVERGE;
    p.x0 = num(o.x0, x + Math.cos(ang) * dist);
    p.y0 = num(o.y0, y + Math.sin(ang) * dist);
    p.x1 = x; p.y1 = y;
    p.x = p.x0; p.y = p.y0;
    p.vx = 0; p.vy = 0; p.g = 0; p.drag = 0;
    p.spin = num(o.spin, U.rand(-1, 1) * 2.2);
    p.rot = p.spin;
    p.delay = num(o.delay, 0);
    const life = rng(o.life, num(CFG_CONV.life, 0.25));
    p.t = 0; p.life = life > 0.01 ? life : 0.01; p.invLife = 1 / p.life;
    p.size = num(o.size, num(CFG_CONV.size, 17));
    p.a0 = num(o.alpha, 1);
    p.color = o.color || WHITE;
    p.ch = (char === undefined || char === null || char === '') ? U.pick(U.GLYPHS) : String(char);
    return p;
  }

  // afterimage(x,y,text,{color,size,life,alpha,rot,vx,vy}) — fading ghost of
  // text: flow-state turret trails, banner motion blur (§11.5).
  function afterimage(x, y, text, o) {
    o = o || {};
    const p = allocP();
    p.kind = K_AFTER;
    p.x = x; p.y = y;
    p.vx = num(o.vx, 0); p.vy = num(o.vy, 0);
    p.g = num(o.gravity, 0); p.drag = 0;
    p.rot = num(o.rot, 0); p.spin = num(o.spin, 0);
    p.delay = num(o.delay, 0);
    const life = rng(o.life, num(CFG_AFTER.life, 0.24));
    p.t = 0; p.life = life > 0.01 ? life : 0.01; p.invLife = 1 / p.life;
    p.size = num(o.size, 22);
    p.a0 = num(o.alpha, num(CFG_AFTER.alpha, 0.42));
    p.color = o.color || WHITE;
    p.ch = (text === undefined || text === null) ? '' : String(text);
    return p;
  }

  // shard(x,y,{color,count,size,life,text,spin,gravity}) — the combo counter
  // physically cracking: 2–3 chunks of `text` dropping with gravity (§11.5).
  function shard(x, y, o) {
    o = o || {};
    const n = Math.max(1, rngInt(o.count, num(TC.breakShards, 3)));
    const txt = (o.text === undefined || o.text === null) ? '' : String(o.text);
    const life = rng(o.life, num(TC.breakShardLife, num(CFG_SHARD.life, 1.0)));
    const g = num(o.gravity, num(TC.breakShardGravity, num(CFG_SHARD.gravity, 900)));
    const size = num(o.size, num(CFG_SHARD.size, 22));
    const chunk = txt.length ? Math.max(1, Math.ceil(txt.length / n)) : 0;
    for (let i = 0; i < n; i++) {
      const piece = chunk ? txt.substr(i * chunk, chunk) : U.pick(U.GLYPHS);
      const spanX = (n > 1) ? (i / (n - 1) - 0.5) * 2 : 0;
      glyph(x + spanX * size * 0.6, y, (piece === '' ? U.pick(U.GLYPHS) : piece), {
        color: o.color || WHITE,
        vx: spanX * U.rand(60, 190) + U.rand(-30, 30),
        vy: U.rand(-260, -110),
        life: life, size: size, gravity: g,
        spin: U.rand(-1, 1) * num(CFG_SHARD.spin, 5),
        alpha: num(o.alpha, 1)
      });
    }
  }

  // beam(x0,y0,x1,y1,{color,life,width,bloom}) — laser tracer: bright core plus
  // faked additive bloom (3 layered strokes, no shadowBlur / no filter).
  function beam(x0, y0, x1, y1, o) {
    o = o || {};
    const p = allocB();
    p.x0 = x0; p.y0 = y0; p.x1 = x1; p.y1 = y1;
    const life = rng(o.life, num(CFG_BEAM.life, 0.03));
    p.t = 0; p.life = life > 0.005 ? life : 0.005; p.invLife = 1 / p.life;
    p.width = num(o.width, num(CFG_BEAM.width, 2.5));
    p.bloom = num(o.bloom, num(CFG_BEAM.bloom, 9));
    p.a0 = num(o.alpha, 1);
    p.color = o.color || WHITE;
    return p;
  }

  // popup(x,y,text,{color,size,life,vy,scalePop,alpha}) — floating score text:
  // rises on ease-out, scale-pops 1.0->1.4->1.0 over 120ms, then fades.
  function popup(x, y, text, o) {
    o = o || {};
    const p = allocU();
    p.x = x; p.y = y;
    const life = rng(o.life, num(CFG_POPUP.life, num(TS.popupLife, 0.85)));
    p.t = 0; p.life = life > 0.02 ? life : 0.02; p.invLife = 1 / p.life;
    p.vy = num(o.vy, num(CFG_POPUP.vy, num(TS.popupVy, -46)));
    p.size = num(o.size, num(CFG_POPUP.size, num(TS.popupSize, 20)));
    p.pop = num(o.scalePop, num(TS.popupScalePop, 1.35));
    p.a0 = num(o.alpha, 1);
    p.color = o.color || WHITE;
    p.text = (text === undefined || text === null) ? '' : String(text);
    return p;
  }

  // ring(x,y,{color,r0,r1,life,width,displace,strength,alpha}) — expanding
  // shockwave with width falloff. displace:true also registers a live record in
  // PI.FX.displacements for the background's radial warp; retired on death.
  function ring(x, y, o) {
    o = o || {};
    const p = allocR();
    p.x = x; p.y = y;
    p.r0 = num(o.r0, num(CFG_RING.r0, 6));
    p.r1 = num(o.r1, num(CFG_RING.r1, 74));
    p.r = p.r0;
    const life = rng(o.life, num(CFG_RING.life, 0.42));
    p.t = 0; p.life = life > 0.02 ? life : 0.02; p.invLife = 1 / p.life;
    p.width = num(o.width, num(CFG_RING.width, 3));
    p.a0 = num(o.alpha, 1);
    p.color = o.color || WHITE;
    p.strength = num(o.strength, num((TB.death && TB.death.displaceStrength), 40));
    if (o.displace && dispFree.length) {
      const d = dispFree.pop();
      d.x = x; d.y = y; d.r = p.r0; d.strength = p.strength;
      p.disp = d;
      displacements.push(d);
    }
    return p;
  }

  // stress(n): perf harness — n cheap sparks with random velocities.
  function stress(n) {
    const c = Math.max(0, n | 0);
    for (let i = 0; i < c; i++) {
      const p = allocP();
      const ang = Math.random() * TAU, sp = U.rand(40, 320);
      p.kind = K_SPARK;
      p.x = U.rand(40, VIEW.W - 40); p.y = U.rand(40, VIEW.H - 60);
      p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
      p.g = 90; p.drag = 1.2; p.rot = 0; p.spin = 0; p.delay = 0;
      const life = rng(T.stressLife, [0.4, 1.2]);
      p.t = 0; p.life = life > 0.01 ? life : 0.01; p.invLife = 1 / p.life;
      p.size = 2.4; p.a0 = 0.9; p.color = WHITE; p.ch = '';
    }
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    if (!(dt > 0)) dt = 0;

    let i = 0;
    while (i < pLive) {
      const p = parts[i];
      if (p.delay > 0) { p.delay -= dt; i++; continue; }
      p.t += dt;
      if (p.t >= p.life) { pLive = swapOut(parts, i, pLive); continue; }
      if (p.kind === K_CONVERGE) {
        const e = U.easeOutCubic(p.t * p.invLife);
        p.x = p.x0 + (p.x1 - p.x0) * e;
        p.y = p.y0 + (p.y1 - p.y0) * e;
        p.rot = p.spin * (1 - e);
      } else {
        p.vy += p.g * dt;
        if (p.drag !== 0) {
          let f = 1 - p.drag * dt;
          if (f < 0) f = 0;
          p.vx *= f; p.vy *= f;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.spin !== 0) p.rot += p.spin * dt;
      }
      i++;
    }

    i = 0;
    while (i < bLive) {
      const b = beams[i];
      b.t += dt;
      if (b.t >= b.life) { bLive = swapOut(beams, i, bLive); continue; }
      i++;
    }

    i = 0;
    while (i < uLive) {
      const u = popups[i];
      u.t += dt;
      if (u.t >= u.life) { uLive = swapOut(popups, i, uLive); continue; }
      i++;
    }

    i = 0;
    while (i < rLive) {
      const r = rings[i];
      r.t += dt;
      if (r.t >= r.life) { releaseDisp(r); rLive = swapOut(rings, i, rLive); continue; }
      const pr = r.t * r.invLife;
      r.r = r.r0 + (r.r1 - r.r0) * U.easeOutCubic(pr);
      if (r.disp) {
        const d = r.disp;
        d.x = r.x; d.y = r.y; d.r = r.r;
        d.strength = r.strength * Math.pow(1 - pr, DISP_DECAY);
      }
      i++;
    }
  }

  // ---------------------------------------------------------------- drawing
  let lastFont = null, lastFill = null, lastStroke = null;
  const fontCache = [];
  function fontFor(px) {
    let s = px | 0;
    if (s < 1) s = 1; else if (s > 220) s = 220;
    let f = fontCache[s];
    if (f === undefined) { f = s + 'px ' + (PI.FONT || 'monospace'); fontCache[s] = f; }
    return f;
  }
  function setFont(ctx, f)   { if (f !== lastFont)   { ctx.font = f;         lastFont = f; } }
  function setFill(ctx, c)   { if (c !== lastFill)   { ctx.fillStyle = c;    lastFill = c; } }
  function setStroke(ctx, c) { if (c !== lastStroke) { ctx.strokeStyle = c;  lastStroke = c; } }

  function draw(ctx) {
    // Other modules own ctx state between frames — invalidate the caches.
    lastFont = null; lastFill = null; lastStroke = null;

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    // --- beams: widest / faintest layer first, bright core last ------------
    for (let i = 0; i < bLive; i++) {
      const b = beams[i];
      const a = b.a0 * (1 - b.t * b.invLife);
      if (a <= 0.002) continue;
      setStroke(ctx, b.color);
      const bw = b.bloom;
      ctx.globalAlpha = a * 0.10; ctx.lineWidth = b.width + bw;
      strokeSeg(ctx, b);
      ctx.globalAlpha = a * 0.24; ctx.lineWidth = b.width + bw * 0.45;
      strokeSeg(ctx, b);
      ctx.globalAlpha = a;        ctx.lineWidth = b.width;
      strokeSeg(ctx, b);
    }

    // --- rings: soft outer halo + core stroke, width falls off with age ----
    for (let i = 0; i < rLive; i++) {
      const r = rings[i];
      const pr = r.t * r.invLife;
      const a = r.a0 * (1 - pr) * (1 - pr * 0.35);
      if (a <= 0.002 || r.r <= 0.5) continue;
      const w = r.width * (1 - pr * 0.82);
      setStroke(ctx, r.color);
      ctx.globalAlpha = a * 0.28; ctx.lineWidth = Math.max(0.5, w * 3);
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
      ctx.globalAlpha = a;        ctx.lineWidth = Math.max(0.6, w);
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
    }

    // --- additive particles: sparks (dots) + trails (streaks) -------------
    for (let i = 0; i < pLive; i++) {
      const p = parts[i];
      if (p.kind > K_TRAIL || p.delay > 0) continue;
      const pr = p.t * p.invLife;
      const f = 1 - pr;
      const a = p.a0 * f;
      if (a <= 0.004) continue;
      if (p.kind === K_SPARK) {
        const s = p.size * (0.35 + 0.65 * f);
        setFill(ctx, p.color);
        ctx.globalAlpha = a;
        ctx.fillRect(p.x - s * 0.5, p.y - s * 0.5, s, s);
      } else {
        setStroke(ctx, p.color);
        ctx.globalAlpha = a;
        ctx.lineWidth = Math.max(0.5, p.size * f);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * p.trailLen, p.y - p.vy * p.trailLen);
        ctx.stroke();
      }
    }

    // --- normal-composite text: glyphs, converges, afterimages, popups -----
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < pLive; i++) {
      const p = parts[i];
      if (p.kind <= K_TRAIL || p.delay > 0) continue;
      const pr = p.t * p.invLife;
      let a = p.a0;
      if (p.kind === K_GLYPH) {
        const f = 1 - pr;
        a *= f < 0.45 ? f * 2.22 : 1;
      } else if (p.kind === K_CONVERGE) {
        const inA = pr * 6, outA = (1 - pr) * 4.5;
        a *= (inA < 1 ? inA : 1) * (outA < 1 ? outA : 1);
      } else { // afterimage: quadratic fade
        const f = 1 - pr;
        a *= f * f;
      }
      if (a <= 0.004 || p.ch === '') continue;
      setFont(ctx, fontFor(p.kind === K_CONVERGE ? p.size * (1.25 - 0.25 * pr) : p.size));
      setFill(ctx, p.color);
      ctx.globalAlpha = a;
      const rot = p.rot;
      if (rot > 0.008 || rot < -0.008) {
        ctx.translate(p.x, p.y);
        ctx.rotate(rot);
        ctx.fillText(p.ch, 0, 0);
        ctx.rotate(-rot);
        ctx.translate(-p.x, -p.y);
      } else {
        ctx.fillText(p.ch, p.x, p.y);
      }
    }

    for (let i = 0; i < uLive; i++) {
      const u = popups[i];
      const pr = u.t * u.invLife;
      // hold, then fade over the last 40% of life (ease-in so it lingers)
      let a = u.a0;
      if (pr > 0.6) a *= 1 - U.easeInCubic((pr - 0.6) / 0.4);
      if (a <= 0.004 || u.text === '') continue;
      // rise: velocity integrated through an ease-out so it decelerates
      const y = u.y + u.vy * u.life * U.easeOutCubic(pr);
      // 120ms scale-pop 1.0 -> pop -> 1.0 (sine gives a smooth there-and-back)
      const s = u.t < POP_TIME
        ? 1 + (u.pop - 1) * Math.sin(Math.PI * (u.t / POP_TIME))
        : 1;
      setFont(ctx, fontFor(u.size));
      ctx.globalAlpha = a;
      if (s !== 1) {
        // Core owns the outer camera transform, so the scale is applied and then
        // inverted in place (no save/restore, which would also drop our
        // fillStyle/font caches).
        ctx.translate(u.x, y);
        ctx.scale(s, s);
        setFill(ctx, INK);
        ctx.fillText(u.text, 1.5, 2);
        setFill(ctx, u.color);
        ctx.fillText(u.text, 0, 0);
        ctx.scale(1 / s, 1 / s);
        ctx.translate(-u.x, -y);
      } else {
        setFill(ctx, INK);
        ctx.fillText(u.text, u.x + 1.5, y + 2);
        setFill(ctx, u.color);
        ctx.fillText(u.text, u.x, y);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  function strokeSeg(ctx, b) {
    ctx.beginPath();
    ctx.moveTo(b.x0, b.y0);
    ctx.lineTo(b.x1, b.y1);
    ctx.stroke();
  }

  // ---------------------------------------------------------------- lifecycle
  function clear() {
    pLive = 0; bLive = 0; uLive = 0;
    for (let i = 0; i < rLive; i++) releaseDisp(rings[i]);
    rLive = 0;
    displacements.length = 0;
  }
  function count() { return pLive + bLive + uLive + rLive; }

  return {
    spark: spark, glyph: glyph, ring: ring, beam: beam, popup: popup,
    shard: shard, converge: converge, afterimage: afterimage, trail: trail,
    update: update, draw: draw, clear: clear, count: count,
    stress: stress,
    displacements: displacements,
    // introspection for the debug harness / tuning
    capacity: P_CAP,
    live: function () { return { parts: pLive, beams: bLive, popups: uLive, rings: rLive }; }
  };
})();
