// ============================================================================
// 30-entities.js — PI.Entities
// Enemies (DESIGN.md §6), the wave director (§8), the Prompt Injection boss (§7)
// and the system-command power-ups (§10). Every number is read from PI.TUNING;
// nothing is drawn here (50-render owns pixels), nothing scores here (40-typing
// owns score) — this module owns *what exists and where it is*.
// ============================================================================
PI.Entities = (function () {
  const U = PI.U, T = PI.TUNING, C = PI.C, FX = PI.FX, Core = PI.Core;
  const EN = T.enemy, EC = EN.common;
  const TW = T.wave, TB = T.boss, TCM = T.commands, TJ = T.juice;
  const W = T.view.W, H = T.view.H;
  const TAU = Math.PI * 2;

  // §6: an enemy "reaches the context window" when its capsule touches the leak
  // line. TUNING.player.leakLine (652) sits just above the context bar strip
  // (bar top = 664, H - barHeight = 680), so it is the authoritative line here.
  const LEAK_Y = num(T.player && T.player.leakLine, H - num(T.hud && T.hud.contextBar && T.hud.contextBar.h, 40));
  const TURRET_X = num(T.player && T.player.turretX, W * 0.5);
  const TURRET_Y = num(T.player && T.player.turretY, H - 86);

  // ------------------------------------------------------------------ state
  const list = [];                 // stable array reference (debug hook maps it)
  let nextId = 1;
  let wave = 0, pendingWave = 1;
  let bossTier = 0, boss = null, bossesDefeated = 0;
  // director phases: idle | spawning | clearing | breather | bossintro | boss | bossdeath
  let phase = 'idle', phaseT = 0;
  let budget = 0, spawnedCount = 0, spawnTimer = 0;
  let bannerShownFor = -1, idleGrace = 0;
  let freezeT = 0;
  const purgeQueue = [];
  let purgeTimer = 0;
  let commandOnScreen = null, cmdTimer = 0, commandFiredAt = -99;

  // ------------------------------------------------------------------ helpers
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function cfgOf(type) { return EN[type] || EN.token; }
  function snd(fn, a, b) {
    const A = PI.Audio;
    if (A && typeof A[fn] === 'function') { try { A[fn](a, b); } catch (_) { } }
  }
  function banner(text, opts) {
    const R = PI.Render;
    if (R && typeof R.showBanner === 'function') { try { R.showBanner(text, opts); } catch (_) { } }
  }
  function integrity() {
    const g = PI.Game;
    const v = g ? g.integrity : 100;
    return (typeof v === 'number' && isFinite(v)) ? v : 100;
  }
  // Kill through PI.Game so score / fx / audio stay in one place; fall back to a
  // bare removal if Game is not wired yet (unit-style harness runs).
  function killVia(e) {
    const g = PI.Game;
    if (g && typeof g.killEnemy === 'function') { g.killEnemy(e); if (list.indexOf(e) >= 0) remove(e); return; }
    FX.spark(e.x, e.y, { color: e.color, count: 14 });
    remove(e);
  }
  function nextChar(e) {
    if (!e || typeof e.word !== 'string') return '';
    return (e.typed < e.word.length) ? e.word.charAt(e.typed) : '';
  }

  // ------------------------------------------------------------------ measuring
  // No ctx exists until Core.boot(), so widths start as a 0.6*fontSize estimate
  // and are re-measured (once, cached) as soon as a real 2d context shows up.
  const measCache = new Map();
  let lastMeasureExact = false;
  function textWidth(word, fs) {
    const key = fs + '|' + word;
    const hit = measCache.get(key);
    if (hit !== undefined) { lastMeasureExact = true; return hit; }
    const c = Core && Core.ctx;
    if (c && typeof c.measureText === 'function') {
      let v = 0;
      try {
        const prev = c.font;
        c.font = fs + 'px ' + (PI.FONT || 'monospace');
        v = c.measureText(word).width;
        c.font = prev;
      } catch (_) { v = 0; }
      if (v > 0) {
        if (measCache.size > 512) measCache.clear();
        measCache.set(key, v);
        lastMeasureExact = true;
        return v;
      }
    }
    lastMeasureExact = false;
    return word.length * fs * 0.6;
  }
  function sizeEnemy(e) {
    const pad = EC.capsulePadX * (e.fontSize / EC.fontSize);
    e.textW = textWidth(e.word, e.fontSize);
    e.charW = e.word.length ? e.textW / e.word.length : e.fontSize * 0.6;
    e.w = e.textW + pad * 2;
    e.h = e.fontSize + EC.capsulePadY * 2;
    e.measured = lastMeasureExact;
  }
  // Render may call this on first draw with its own ctx (contract note) — the
  // update loop already re-measures lazily, so this is just belt and braces.
  function measureEnemy(e, ctx) {
    if (!e) return e;
    if (ctx && typeof ctx.measureText === 'function' && !e.measured) {
      try {
        const prev = ctx.font;
        ctx.font = e.fontSize + 'px ' + (PI.FONT || 'monospace');
        const v = ctx.measureText(e.word).width;
        ctx.font = prev;
        if (v > 0) {
          const key = e.fontSize + '|' + e.word;
          if (measCache.size > 512) measCache.clear();
          measCache.set(key, v);
        }
      } catch (_) { }
    }
    if (!e.measured) { sizeEnemy(e); clampX(e); }
    return e;
  }
  // Centre of letter i — used for laser tracers and per-letter particles.
  function letterPos(e, i, out) {
    const o = out || { x: 0, y: 0 };
    const n = e.word.length || 1;
    const cw = (e.charW || e.fontSize * 0.6) * (e.scale || 1);
    o.x = e.x - (n * cw) * 0.5 + cw * (i + 0.5);
    o.y = e.y;
    return o;
  }

  // ------------------------------------------------------------------ placement
  function wordOnScreen(word, pending) {
    for (let i = 0; i < list.length; i++) if (list[i].word === word) return true;
    if (pending) for (let i = 0; i < pending.length; i++) if (pending[i] === word) return true;
    return false;
  }
  // §5/§6: two live enemies expecting the same next character make lock-on
  // ambiguous, so the spawner avoids it when it can.
  function firstLetterClash(word, pending) {
    const ch = word.charAt(0);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || e.dying) continue;
      if (nextChar(e) === ch) return true;
    }
    if (pending) for (let i = 0; i < pending.length; i++) if (pending[i].charAt(0) === ch) return true;
    return false;
  }
  function chooseWord(type, pending) {
    const pool = (PI.WORDS && PI.WORDS[type]) || null;
    if (!pool || !pool.length) return type + '' + nextId;
    const rerolls = Math.max(0, num(EN.firstLetterRerolls, 5));
    let fallback = null;
    for (let i = 0; i <= rerolls; i++) {
      const w = U.pick(pool);
      if (EN.noDupWords !== false && wordOnScreen(w, pending)) continue;
      if (fallback === null) fallback = w;
      if (!firstLetterClash(w, pending)) return w;      // clean pick
    }
    if (fallback !== null) return fallback;             // rerolls exhausted: allow clash
    for (let i = 0; i < pool.length; i++) {             // last resort: any non-duplicate
      if (!wordOnScreen(pool[i], pending)) return pool[i];
    }
    return U.pick(pool);
  }

  // 6 candidate x positions, keep the whole word on screen, avoid overlapping the
  // rect of anything already near that spawn band.
  function clearance(x, halfW, y, h) {
    let worst = 1e9;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) continue;
      const eh = (e.h * (e.scale || 1)) * 0.5 + h * 0.5 + 10;
      if (Math.abs(e.y - y) > eh) continue;             // no vertical overlap
      const gap = Math.abs(e.x - x) - (halfW + e.w * (e.scale || 1) * 0.5 + 14);
      if (gap < worst) worst = gap;
    }
    return worst;
  }
  function placeX(width, y, h, extra) {
    const half = width * 0.5 + num(extra, 0);
    const margin = num(EC.spawnMarginX, 84);
    let lo = Math.max(margin, half + 6);
    let hi = Math.min(W - margin, W - half - 6);
    if (hi <= lo) { lo = hi = W * 0.5; }
    let best = U.rand(lo, hi), bestScore = -1e9;
    for (let i = 0; i < 6; i++) {
      const x = (i === 0) ? best : U.rand(lo, hi);
      const s = clearance(x, width * 0.5, y, h);
      if (s > 0) return x;                              // clean slot
      if (s > bestScore) { bestScore = s; best = x; }
    }
    return best;
  }
  function clampX(e) {
    const half = e.w * (e.scale || 1) * 0.5 + (e.type === 'halluc' ? num(EN.halluc.amplitude, 60) : 0);
    const lo = Math.max(6, half + 4), hi = Math.min(W - 6, W - half - 4);
    if (hi <= lo) { e.baseX = W * 0.5; }
    else e.baseX = U.clamp(e.baseX, lo, hi);
    e.x = e.baseX;
  }

  // ------------------------------------------------------------------ factory
  function makeEnemy(type, word) {
    const cfg = cfgOf(type);
    const kind = (type === 'command') ? 'command' : (type === 'bossword' ? 'bossword' : 'enemy');
    const e = {
      // ---- contract fields -------------------------------------------------
      id: nextId++, kind: kind, type: type,
      word: word, typed: 0,
      x: W * 0.5, y: num(EC.spawnY, -46), vy: 0,
      w: 0, h: 0,
      color: C.forType(type),
      alive: true, dying: false,
      damage: num(cfg.damage, 0),
      scale: num(cfg.scale, 1), alpha: 1,
      spawnT: 0,
      effect: null, boss: null, index: -1,
      // ---- shared internals (one monomorphic shape for every type) ---------
      fontSize: num(cfg.fontSize, EC.fontSize),
      baseScale: num(cfg.scale, 1),
      baseSpeed: num(cfg.speed, 30),
      speedMul: 1,
      baseX: W * 0.5, textW: 0, charW: 0, measured: false,
      ageT: 0, dieT: 0, leaked: false, snapped: false,
      wobblePhase: U.rand(0, TAU),
      wobbleFreq: U.rand(num(EC.wobbleFreqMin, 0.35), num(EC.wobbleFreqMax, 0.85)),
      jitter: false, jitterPx: 0,                 // halluc: renderer letter jitter
      sinePhase: U.rand(0, TAU), sineAmp: 0,      // halluc drift
      dashT: 0, dashTimer: 0, dashing: false, dashProg: 0, dashPrev: 0,
      dashDX: 0, dashDY: 0, dashDir: (Math.random() < 0.5 ? -1 : 1),
      dashX0: 0, dashY0: 0,
      pulse: 0, sparkT: 0,
      popIndex: -1, popT: 99, typedSeen: 0,       // per-letter consume pop (§11)
      shakeT: 0,                                  // Game.typo(e) may set this
      targetable: false, tutorial: false,
      effectFired: false, deathHandled: false, offsetX: 0
    };
    sizeEnemy(e);
    if (type === 'halluc') { e.jitter = true; e.sineAmp = num(EN.halluc.amplitude, 60); }
    return e;
  }

  // §11.5: enemies materialize — 6–10 stray glyphs converge into the word.
  function materialize(e) {
    e.spawnT = 0;
    const g = EC.materializeGlyphs || [6, 10];
    const n = U.randInt(num(g[0], 6), num(g[1], 10));
    const life = num(EC.materialize, 0.25);
    const half = e.w * 0.5;
    for (let i = 0; i < n; i++) {
      FX.converge(e.x + U.rand(-half, half), e.y + U.rand(-e.h * 0.4, e.h * 0.4),
        U.pick(U.GLYPHS), {
          color: e.color, life: life * U.rand(0.8, 1.0),
          size: e.fontSize * 0.85, dist: U.rand(70, num(EC.materializeGlyphs && 160, 160)),
          alpha: 0.9
        });
    }
  }

  // ------------------------------------------------------------------ spawning
  function currentSpeedMul() {
    const s = TW.speedMul || {};
    return Math.min(num(s.cap, 2.2), num(s.base, 1) + num(s.per, 0.045) * (Math.max(1, wave) - 1));
  }
  function currentInterval() {
    const si = TW.spawnInterval || {};
    let iv = Math.max(num(si.floor, 0.55), num(si.base, 2.2) * Math.pow(num(si.decay, 0.93), Math.max(1, wave)));
    const m = TW.mercy || {};
    // §8 intensity valve: under 30% integrity the effective spawn rate drops 25%.
    if (integrity() < num(m.below, 30)) iv = iv / Math.max(0.1, 1 - num(m.reduce, 0.25));
    return iv;
  }
  function unlockedTypes() {
    const roster = TW.roster || ['token'];
    const out = [];
    for (let i = 0; i < roster.length; i++) {
      const t = roster[i];
      if (!PI.WORDS[t] || !PI.WORDS[t].length) continue;
      if (wave >= num(cfgOf(t).firstWave, 1)) out.push(t);
    }
    if (!out.length) out.push('token');
    return out;
  }
  function pickType() {
    const types = unlockedTypes();
    const t = U.weightedPick(types, function (n2) { return num(cfgOf(n2).weight, 1); });
    return t || 'token';
  }

  function spawnEnemy(type, o) {
    o = o || {};
    const cfg = cfgOf(type);
    const word = o.word || chooseWord(type, o.pending);
    const e = makeEnemy(type, word);
    e.baseSpeed = num(o.speed, num(cfg.speed, 30));
    e.speedMul = num(o.speedMul, currentSpeedMul());
    e.y = num(o.y, num(EC.spawnY, -46));
    const extra = (type === 'halluc') ? num(EN.halluc.amplitude, 60) : 0;
    e.baseX = (o.x !== undefined && o.x !== null) ? o.x : placeX(e.w, e.y, e.h, extra);
    clampX(e);
    if (o.dampen) e.speedMul *= o.dampen;
    list.push(e);
    materialize(e);
    return e;
  }

  // §6 Token Swarm: a cluster of 3 tiny words within 150px of each other.
  function spawnSwarm() {
    const cfg = EN.swarm;
    const n = Math.max(1, num(cfg.count, 3));
    const spread = num(cfg.spread, 150), spreadY = num(cfg.spreadY, 90);
    const pending = [];
    const cx = U.rand(num(EC.spawnMarginX, 84) + spread * 0.5, W - num(EC.spawnMarginX, 84) - spread * 0.5);
    let first = null;
    for (let i = 0; i < n; i++) {
      const word = chooseWord('swarm', pending);
      pending.push(word);
      const off = (n > 1) ? (i / (n - 1) - 0.5) * spread : 0;
      const e = spawnEnemy('swarm', {
        word: word,
        x: cx + off + U.rand(-12, 12),
        y: num(EC.spawnY, -46) - U.rand(0, spreadY),
        pending: pending
      });
      if (!first) first = e;
    }
    return first;
  }

  function spawnFromRoster() {
    const type = pickType();
    if (type === 'swarm') return spawnSwarm();
    return spawnEnemy(type);
  }

  // Public force-spawn (debug hook / harassment / Game).
  function spawn(type) {
    let t = (typeof type === 'string' && type) ? type.toLowerCase() : 'token';
    if (t === 'command' || t === 'cmd') return spawnCommand(true);
    if (t === 'boss') { startWave(nextBossWave()); return boss; }
    if (t === 'swarm') return spawnSwarm();
    if (!EN[t] || !PI.WORDS[t] || !PI.WORDS[t].length) t = 'token';
    return spawnEnemy(t);
  }

  function spawnTutorial() {
    const tut = TW.tutorial || {};
    const e = spawnEnemy(tut.type || 'token', {
      word: tut.word || 'start',
      x: num(tut.x, W * 0.5), y: num(tut.y, 40),
      speed: num(tut.speed, 13), speedMul: 1
    });
    e.tutorial = true;
    e.damage = 0;
    return e;
  }

  function nextBossWave() {
    const every = Math.max(1, num(TW.bossEvery, 5));
    return (Math.floor(Math.max(0, wave) / every) + 1) * every;
  }

  // ------------------------------------------------------------------ commands
  function commandFirstLetterFree(word) {
    const ch = word.charAt(0);
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || e.dying) continue;
      if (nextChar(e) === ch) return false;
    }
    return true;
  }
  // §10: golden word, 20 px/s, unique first letter where possible.
  function spawnCommand(force) {
    if (commandOnScreen && !force) return null;
    if (commandOnScreen && force) { remove(commandOnScreen); }
    const defs = PI.COMMANDS || [];
    if (!defs.length) return null;
    let def = null;
    const weights = TCM.weights || {};
    for (let i = 0; i < 5; i++) {
      const cand = U.weightedPick(defs, function (d) { return num(weights[d.effect], num(d.weight, 1)); });
      if (!cand) break;
      if (def === null) def = cand;
      if (TCM.uniqueFirstLetter === false || commandFirstLetterFree(cand.word)) { def = cand; break; }
    }
    if (!def) def = defs[0];
    const e = makeEnemy('command', def.word);
    e.effect = def.effect;
    e.baseSpeed = num(EN.command.speed, 20);
    e.speedMul = 1;
    e.damage = 0;
    e.y = num(EC.spawnY, -46);
    e.baseX = placeX(e.w, e.y, e.h, 0);
    clampX(e);
    list.push(e);
    materialize(e);
    commandOnScreen = e;
    cmdTimer = commandDelay();
    snd('command');
    return e;
  }
  function commandDelay() {
    return Math.max(3, num(TCM.interval, 25) + U.rand(-num(TCM.jitter, 5), num(TCM.jitter, 5)));
  }

  // temp=0 — all enemies halt for 4s.
  function freeze(seconds) {
    commandFiredAt = U.now();
    const d = (typeof seconds === 'number' && seconds > 0) ? seconds : num(TCM.freeze.duration, 4);
    freezeT = Math.max(freezeT, d);
    snd('freeze');
    if (Core.addTrauma) Core.addTrauma(num(TJ.trauma.freeze, 0.18));
    // frost crystals over the frozen enemies
    let bud = Math.max(0, num(TCM.freeze.crystals, 26));
    const tint = TCM.freeze.tint || C.cyan;
    for (let i = 0; i < list.length && bud > 0; i++) {
      const e = list[i];
      if (!e.alive || e.kind === 'command') continue;
      const n = Math.min(bud, 6);
      bud -= n;
      FX.spark(e.x, e.y, { color: tint, count: n, speed: [20, 110], life: [0.35, 0.8], size: 2.2, drag: 5 });
    }
    if (bud > 0) FX.spark(W * 0.5, H * 0.4, { color: tint, count: bud, speed: [40, 220], life: [0.4, 0.9], size: 2 });
    return freezeT;
  }

  // rlhf — destroy every non-boss enemy, 60ms apart (popcorn cascade).
  function purge() {
    commandFiredAt = U.now();
    purgeQueue.length = 0;
    const skipBoss = TCM.purge.skipBoss !== false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || e.dying) continue;
      if (e.kind === 'command') continue;
      if (e.kind === 'bossword' && skipBoss) continue;
      purgeQueue.push(e);
    }
    // lowest (most dangerous) first
    purgeQueue.sort(function (a, b) { return b.y - a.y; });
    purgeTimer = 0;
    snd('purge');
    if (Core.addTrauma) Core.addTrauma(num(TJ.trauma.purge, 0.24));
    FX.ring(W * 0.5, H * 0.55, {
      color: C.gold, r0: 20, r1: 620, life: 0.7, width: 6, displace: true, strength: 22
    });
    return purgeQueue.length;
  }
  function updatePurge(udt) {
    if (!purgeQueue.length) return;
    purgeTimer -= udt;
    const stagger = Math.max(0.01, num(TCM.purge.stagger, 0.06));
    let guard = 64;
    while (purgeQueue.length && purgeTimer <= 0 && guard-- > 0) {
      const e = purgeQueue.shift();
      purgeTimer += stagger;
      if (!e.alive || e.dying || list.indexOf(e) < 0) continue;
      if (Core.addTrauma) Core.addTrauma(num(TCM.purge.traumaEach, 0.09));
      killVia(e);
    }
  }

  // stop — destroy the enemy nearest the bottom.
  function stopSeq() {
    commandFiredAt = U.now();
    snd('stopSeq');
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || e.dying || e.kind !== 'enemy') continue;
      if (e.spawnT < 0.2) continue;
      if (!best || e.y > best.y) best = e;
    }
    if (!best) {
      FX.spark(TURRET_X, TURRET_Y, { color: C.gold, count: 10, speed: [80, 220], life: [0.2, 0.4] });
      return null;
    }
    FX.beam(TURRET_X, TURRET_Y, best.x, best.y, {
      color: C.gold, life: num(TCM.stopseq.beamLife, 0.22), width: 4.5, bloom: 16
    });
    if (Core.addTrauma) Core.addTrauma(num(TJ.trauma.command, 0.16));
    killVia(best);
    return best;
  }

  // Dispatcher — PI.Game.killEnemy(command) should call this (or the individual
  // effect); remove() also auto-fires it as a safety net (see remove()).
  function applyCommand(effect, e) {
    if (e) e.effectFired = true;
    switch (effect) {
      case 'freeze': freeze(); break;
      case 'purge': purge(); break;
      case 'stopseq': stopSeq(); break;
      default: return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ boss (§7)
  function bossFontSize(words) {
    const cfg = EN.bossword;
    const base = num(cfg.fontSize, 30);
    const maxW = W - 96;
    for (let fs = base; fs >= 14; fs--) {
      const k = fs / base;
      const gap = num(cfg.gap, 22) * k;
      const pad = EC.capsulePadX * (fs / EC.fontSize) * 2;
      let total = gap * (words.length - 1);
      for (let i = 0; i < words.length; i++) total += textWidth(words[i], fs) + pad;
      if (total <= maxW) return fs;
    }
    return 14;
  }
  function layoutBoss(b, words) {
    const cfg = EN.bossword;
    const fs = b.fontSize;
    const k = fs / num(cfg.fontSize, 30);
    const gap = num(cfg.gap, 22) * k;
    let total = gap * (words.length - 1);
    const ws = [];
    for (let i = 0; i < words.length; i++) {
      const e = makeEnemy('bossword', words[i]);
      e.fontSize = fs;
      sizeEnemy(e);
      e.boss = b; e.index = i;
      e.damage = 0;
      e.baseSpeed = 0; e.speedMul = 0;
      ws.push(e);
      total += e.w;
    }
    let cx = -total * 0.5;
    for (let i = 0; i < ws.length; i++) {
      const e = ws[i];
      e.offsetX = cx + e.w * 0.5;
      cx += e.w + gap;
      e.baseX = b.x + e.offsetX;
      e.x = e.baseX;
      e.y = b.y;
      b.words.push(e);
      list.push(e);
      materialize(e);
    }
    b.w = total; b.h = ws.length ? ws[0].h : 40;
  }

  function beginBoss(w) {
    bossTier = Math.max(1, Math.round(w / Math.max(1, num(TW.bossEvery, 5))));
    const pools = PI.BOSS_PHRASES || [[]];
    const tierIdx = Math.min(pools.length, Math.max(1, bossTier)) - 1;
    const pool = pools[tierIdx] && pools[tierIdx].length ? pools[tierIdx] : pools[0];
    const phrase = U.pick(pool) || 'ignore all previous instructions';
    const words = String(phrase).split(' ');
    const clean = [];
    for (let i = 0; i < words.length; i++) if (words[i].length) clean.push(words[i]);

    boss = {
      // ---- contract fields ------------------------------------------------
      phrase: phrase, words: [], x: W * 0.5, y: num(TB.entryY, -70),
      tier: bossTier, alive: true, wordIndex: 0,
      // ---- generic enemy-ish fields so PI.Game.leak(boss) just works -------
      id: nextId++, kind: 'boss', type: 'boss', word: phrase, typed: 0,
      damage: num(TB.damage, 50), color: C.forType('boss'),
      scale: 1, alpha: 1, spawnT: 1, dying: false, w: 0, h: 0, vy: 0,
      // ---- internals -------------------------------------------------------
      fontSize: 30, targetY: num(TB.entryY, -70),
      ySpring: { v: num(TB.entryY, -70), vel: 0 },
      introT: 0, introDur: num(TB.intro && TB.intro.duration, 1.2),
      harassT: num(TB.harassInterval, 6) * 0.6,
      deathT: 0, leaked: false, recoilCount: 0
    };
    boss.fontSize = bossFontSize(clean);
    layoutBoss(boss, clean);

    phase = 'bossintro';
    phaseT = 0;
    // §11.5 intro choreography (the *drawing* of the alert sweep is 50-render's)
    const intro = TB.intro || {};
    if (Core.setTimeScale) Core.setTimeScale(num(intro.timeScale, 0.3), num(intro.duration, 1.2));
    if (Core.punch) Core.punch(num(intro.zoom, 0.08), num(intro.duration, 1.2) * 0.5);
    if (Core.addTrauma) Core.addTrauma(num(TJ.trauma.bossIntro, 0.3));
    banner(TB.bannerText || '⚠ INCOMING PROMPT INJECTION',
      { style: 'alert', color: C.red, hold: num(TJ.bannerHold, 1) * 1.2 });
    snd('bossHit');
    if (PI.Audio && typeof PI.Audio.klaxon === 'function') snd('klaxon');
    return boss;
  }

  function spawnHarass() {
    const t = TB.harassType || 'token';
    if (!PI.WORDS[t] || !PI.WORDS[t].length) return null;
    return spawnEnemy(t);
  }

  function targetableBossWord() {
    if (!boss || !boss.alive || boss.dying) return null;
    if (phase === 'bossintro') return null;             // intro is not playable
    for (let i = 0; i < boss.words.length; i++) {
      const e = boss.words[i];
      if (e.alive && !e.dying && e.spawnT > 0.35) return e;
    }
    return null;
  }

  // Left-to-right kill order + 40px elastic recoil (§7 / §11.5).
  function handleBossWordDeath(e) {
    if (!e || e.deathHandled) return;
    e.deathHandled = true;
    e.alive = false;
    if (list.indexOf(e) >= 0) remove(e);                 // re-entry is guarded above
    const b = e.boss;
    if (!b || b !== boss || b.dying) return;
    b.targetY -= num(TB.knockback, 40);
    b.ySpring.vel -= 90;                                // kick for a snappier launch
    b.recoilCount++;
    let idx = b.words.length;
    for (let i = 0; i < b.words.length; i++) { if (b.words[i].alive) { idx = i; break; } }
    b.wordIndex = idx;
    if (idx >= b.words.length) beginBossDeath(b);
  }
  // PI.Game may call this explicitly from killEnemy; it is idempotent.
  function bossWordKilled(e) { handleBossWordDeath(e); return !!(boss && boss.dying); }

  function beginBossDeath(b) {
    if (!b || b.dying) return;
    b.dying = true;
    b.alive = false;
    b.deathT = 0;
    b.wordIndex = b.words.length;
    bossesDefeated++;
    phase = 'bossdeath';
    const d = TB.death || {};
    // §11.5 death: white flash -> background-bending shockwave -> letter rain.
    if (Core.flash) Core.flash(num(d.flashAlpha, 1), 0.14, '#ffffff');
    if (Core.addTrauma) Core.addTrauma(num(TJ.trauma.bossDeath, 1));
    if (Core.setTimeScale) Core.setTimeScale(num(d.slowmo, 0.28), num(TB.celebrateSlowmo, 1.5));
    if (Core.punch) Core.punch(num(TJ.punch, 0.08) * 1.5, 0.5);
    FX.ring(b.x, b.y, {
      color: C.white, r0: num(d.ringR0, 30), r1: num(d.ringR1, 1500),
      life: num(d.ringLife, 1.1), width: num(d.ringWidth, 26),
      displace: true, strength: num(d.displaceStrength, 46)
    });
    // slow-mo letter rain of the whole phrase
    for (let i = 0; i < b.words.length; i++) {
      const e = b.words[i];
      const n = e.word.length;
      const cw = e.charW || e.fontSize * 0.6;
      for (let j = 0; j < n; j++) {
        FX.glyph(e.x - (n * cw) * 0.5 + cw * (j + 0.5), e.y, e.word.charAt(j), {
          color: (j % 3 === 0) ? C.white : C.red,
          vx: U.rand(-120, 120), vy: U.rand(-260, -40),
          life: num(d.letterRainLife, 1.8) * U.rand(0.7, 1),
          size: e.fontSize, gravity: num(d.letterRainGravity, 240),
          spin: U.rand(-4, 4), delay: j * 0.02
        });
      }
    }
    snd('bossDie');
  }

  function clearBossWords(b) {
    if (!b) return;
    for (let i = 0; i < b.words.length; i++) {
      const e = b.words[i];
      e.deathHandled = true;
      if (list.indexOf(e) >= 0) remove(e);
    }
    b.words.length = 0;
  }
  function hardClearBoss() {
    if (!boss) return;
    clearBossWords(boss);
    boss.alive = false;
    boss = null;
  }

  function bossLeak(b) {
    if (b.leaked) return;
    b.leaked = true;
    const g = PI.Game;
    if (g && typeof g.leak === 'function') g.leak(b);
    clearBossWords(b);
    b.alive = false;
    boss = null;
    beginBreather(wave + 1);
  }

  function updateBoss(dt, udt) {
    const b = boss;
    if (!b) return;

    if (b.dying) {
      b.deathT += udt;
      if (b.deathT >= num(TB.death && TB.death.duration, 2)) {
        clearBossWords(b);
        boss = null;
        beginBreather(wave + 1);
      }
      return;
    }

    if (phase === 'bossintro') {
      // choreography runs on real time: the world is at 30% speed during it.
      b.introT += udt;
      const p = U.clamp(b.introT / Math.max(0.05, b.introDur), 0, 1);
      b.targetY = U.lerp(num(TB.entryY, -70), num(TB.startY, 96), U.easeOutCubic(p));
      b.ySpring.v = b.targetY; b.ySpring.vel = 0;
      b.y = b.targetY;
      if (p >= 1) { phase = 'boss'; }
    } else {
      if (freezeT <= 0) {
        b.targetY += (num(TB.speed, 10) + num(TB.speedPerTier, 2) * (b.tier - 1)) * dt;
      }
      b.y = U.spring(b.ySpring, b.targetY,
        dt, num(TB.knockbackSpring.stiffness, 150), num(TB.knockbackSpring.damping, 9));
      // §7: one Rogue Token of harassment every 6s while the boss lives
      b.harassT -= dt;
      if (b.harassT <= 0) { b.harassT = num(TB.harassInterval, 6); spawnHarass(); }
    }
    b.vy = num(TB.speed, 10) + num(TB.speedPerTier, 2) * (b.tier - 1);

    // keep the word chain glued to the phrase body + collect external kills
    let livingH = b.h;
    for (let i = 0; i < b.words.length; i++) {
      const e = b.words[i];
      e.baseX = b.x + e.offsetX;
      e.x = e.baseX;
      e.y = b.y;
      if (e.h > livingH) livingH = e.h;
      if (!e.alive && !e.deathHandled) { handleBossWordDeath(e); if (!boss || boss.dying) return; }
    }
    b.h = livingH;
    if (b.y + livingH * 0.5 >= LEAK_Y) bossLeak(b);
  }

  // ------------------------------------------------------------------ per-enemy
  function startDash(e) {
    const cfg = EN.jail;
    const ang = num(cfg.dashAngle, 0.7);
    const dist = num(cfg.dashDist, 120);
    let dir = -e.dashDir;
    const dx = Math.sin(ang) * dist * dir;
    const half = e.w * 0.5 + 20;
    if (e.baseX + dx < half || e.baseX + dx > W - half) dir = -dir;
    e.dashDir = dir;
    e.dashDX = Math.sin(ang) * dist * dir;
    e.dashDY = Math.cos(ang) * dist;
    e.dashing = true; e.dashProg = 0; e.dashPrev = 0;
    e.dashT = 1;
    e.dashX0 = e.x; e.dashY0 = e.y;
    e.dashTimer = 0;
    // red streak trail (renderer also draws a streak from dashX0 using dashT)
    const n = Math.max(1, num(cfg.streakCount, 4));
    for (let i = 0; i < n; i++) {
      FX.trail(e.x, e.y, {
        color: C.red, vx: e.dashDX * 2.2, vy: e.dashDY * 2.2,
        life: num(cfg.streakLife, 0.32) * U.rand(0.6, 1),
        size: num(cfg.streakWidth, 3), len: 0.05, alpha: 0.8, delay: i * 0.02, drag: 2.2
      });
    }
  }

  function updateEnemy(e, dt, udt, state) {
    e.ageT += dt;

    // materialize (§11.5) — not targetable until spawnT > 0.35
    if (e.spawnT < 1) {
      e.spawnT = Math.min(1, e.spawnT + dt / Math.max(0.01, num(EC.materialize, 0.25)));
      if (e.spawnT >= 1 && !e.snapped) {
        e.snapped = true;
        FX.spark(e.x, e.y, { color: e.color, count: 5, speed: [50, 160], life: [0.12, 0.26], size: 2 });
      }
    }
    // per-letter consume pop bookkeeping for the renderer (§11)
    if (e.typed !== e.typedSeen) {
      if (e.typed > e.typedSeen) { e.popIndex = e.typed - 1; e.popT = 0; }
      e.typedSeen = e.typed;
    } else if (e.popT < 9) e.popT += dt;
    if (e.shakeT > 0) e.shakeT = Math.max(0, e.shakeT - dt);

    if (!e.measured) { sizeEnemy(e); if (e.kind === 'enemy' || e.kind === 'command') clampX(e); }

    if (e.dying) {
      e.dieT += dt;
      e.alpha = Math.max(0, 1 - e.dieT / Math.max(0.01, num(EC.dyingTime, 0.18)));
      if (e.dieT >= num(EC.dyingTime, 0.18)) remove(e);
      return;
    }

    // boss words are positioned by the boss itself
    if (e.kind === 'bossword') { e.alpha = 1; e.scale = e.baseScale; return; }

    const frozen = (freezeT > 0 && e.kind !== 'command');
    const moving = !frozen && e.spawnT >= 1;
    e.vy = moving ? e.baseSpeed * e.speedMul : 0;
    if (moving) e.y += e.vy * dt;

    // slight individual wobble (§6) on top of the type behaviour
    let x = e.baseX + Math.sin(e.wobblePhase + e.ageT * e.wobbleFreq * TAU) * num(EC.wobbleAmpX, 5);
    let alpha = 1;
    let scale = e.baseScale;

    switch (e.type) {
      case 'halluc': {
        const cfg = EN.halluc;
        // sine drift: amplitude 60px, period 3s
        x += Math.sin(e.sinePhase + e.ageT * TAU / Math.max(0.1, num(cfg.period, 3))) * num(cfg.amplitude, 60);
        const fl = 1 - num(cfg.flickerDepth, 0.18) * (0.5 + 0.5 * Math.sin(e.ageT * TAU * num(cfg.flickerHz, 9)));
        alpha = num(cfg.opacity, 0.55) * fl;
        e.jitterPx = num(cfg.jitter, 1);                 // renderer: +/-1px letters
        break;
      }
      case 'jail': {
        const cfg = EN.jail;
        if (e.dashing) {
          e.dashProg += dt / Math.max(0.02, num(cfg.dashTime, 0.2));
          const p = Math.min(1, e.dashProg);
          const eased = U.easeOutCubic(p);
          const d = eased - e.dashPrev;
          e.dashPrev = eased;
          e.baseX += e.dashDX * d;
          e.y += e.dashDY * d;
          if (p >= 1) e.dashing = false;
          x = e.baseX + Math.sin(e.wobblePhase + e.ageT * e.wobbleFreq * TAU) * num(EC.wobbleAmpX, 5);
        } else if (!frozen && e.spawnT >= 1) {
          e.dashTimer += dt;
          if (e.dashTimer >= num(cfg.dashInterval, 2.5)) startDash(e);
        }
        if (e.dashT > 0) e.dashT = Math.max(0, e.dashT - dt / Math.max(0.05, num(cfg.streakLife, 0.32)));
        break;
      }
      case 'overflow': {
        const cfg = EN.overflow;
        // slow tank that pulses larger the deeper it gets
        const span = Math.max(1, LEAK_Y - num(EC.spawnY, -46));
        const depth = U.clamp((e.y - num(EC.spawnY, -46)) / span, 0, 1);
        const pulse = 0.5 + 0.5 * Math.sin(e.ageT * TAU / Math.max(0.1, num(cfg.pulsePeriod, 1.7)));
        e.pulse = pulse;
        scale = e.baseScale * (1
          + num(cfg.pulseGain, 0.32) * pulse * (0.35 + 0.65 * depth)
          + num(cfg.pulseByDepth, 0.45) * depth * 0.5);
        break;
      }
      case 'command': {
        const cfg = EN.command;
        const pulse = 0.5 + 0.5 * Math.sin(e.ageT * TAU / Math.max(0.1, num(cfg.pulsePeriod, 0.9)));
        e.pulse = pulse;
        scale = e.baseScale * (1 + num(cfg.pulseGain, 0.16) * pulse);
        e.sparkT -= dt;
        if (e.sparkT <= 0) {
          e.sparkT = num(cfg.sparkleInterval, 0.1);
          FX.spark(e.x + U.rand(-e.w * 0.5, e.w * 0.5), e.y + U.rand(-e.h * 0.4, e.h * 0.4), {
            color: C.gold, count: num(cfg.sparkleCount, 2),
            speed: [10, 60], life: [0.25, 0.5], size: 2
          });
        }
        // §10: leaking despawns harmlessly
        if (e.y >= num(cfg.despawnBelow, 700)) {
          FX.spark(e.x, e.y, { color: C.gold, count: 8, speed: [40, 140], life: [0.2, 0.4], size: 2 });
          remove(e);
          return;
        }
        break;
      }
      default: break;                                    // token / swarm: straight fall
    }

    e.x = x;
    e.scale = scale;
    // fade in over the materialize window, then hold the type opacity
    e.alpha = alpha * U.lerp(0.2, 1, U.easeOutCubic(e.spawnT));

    // §6 leak: exactly once, then the enemy is gone
    if (e.kind === 'enemy' && !e.leaked && (e.y + e.h * scale * 0.5) >= LEAK_Y) {
      e.leaked = true;
      if (e.tutorial && state !== 'PLAYING') {
        // title-screen tutorial word loops instead of hurting anybody
        e.leaked = false;
        e.y = num(EC.spawnY, -46);
        e.typed = 0;
        return;
      }
      if (state === 'PLAYING') {
        const g = PI.Game;
        if (g && typeof g.leak === 'function') g.leak(e);
      }
      if (list.indexOf(e) >= 0) remove(e);
    }
  }

  // ------------------------------------------------------------------ director
  function announceWave(n) {
    if (bannerShownFor === n) return;
    bannerShownFor = n;
    banner('WAVE ' + n, { style: 'wave', color: C.green });
    snd('waveStart');
  }
  function beginBreather(next) {
    pendingWave = Math.max(1, Math.round(num(next, wave + 1)));
    phase = 'breather';
    phaseT = num(TW.breather, 2.5);
    announceWave(pendingWave);
  }
  function threats() {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.kind === 'enemy' && e.alive && !e.dying && !e.tutorial) n++;
    }
    return n;
  }
  function onWaveCleared() {
    const g = PI.Game;
    if (g && typeof g.onWaveClear === 'function') { g.onWaveClear(wave); return; }
    const bonus = num(T.score && T.score.waveClearBonus, 0);
    if (bonus > 0 && PI.Score && typeof PI.Score.add === 'function') PI.Score.add(bonus, W * 0.5, H * 0.42);
  }

  function startWave(n) {
    let w = Math.round(num(n, wave + 1));
    if (!(w >= 1)) w = 1;
    hardClearBoss();
    purgeQueue.length = 0;
    wave = w;
    pendingWave = w;
    spawnedCount = 0;
    budget = num(TW.budget.base, 4) + Math.ceil(w * num(TW.budget.per, 1.5));
    spawnTimer = 0.45;
    phaseT = 0;
    idleGrace = 0;
    if (w % Math.max(1, num(TW.bossEvery, 5)) === 0) {
      budget = 0;                                        // §8: the boss *is* the budget
      beginBoss(w);
    } else {
      phase = 'spawning';
      announceWave(w);
    }
    return w;
  }

  function director(dt) {
    if (phase === 'spawning') {
      spawnTimer -= dt;
      if (spawnTimer <= 0 && spawnedCount < budget) {
        spawnFromRoster();
        spawnedCount++;
        spawnTimer = currentInterval();
      }
      if (spawnedCount >= budget) phase = 'clearing';
      return;
    }
    if (phase === 'clearing') {
      // §8: next wave once the budget is spent AND <= 2 enemies remain
      if (threats() <= num(TW.clearThreshold, 2)) {
        onWaveCleared();
        beginBreather(wave + 1);
      }
      return;
    }
    if (phase === 'breather') {
      phaseT -= dt;
      if (phaseT <= 0) startWave(pendingWave);
      return;
    }
  }

  // ------------------------------------------------------------------ lifecycle
  function remove(e) {
    if (!e) return false;
    const i = list.indexOf(e);
    if (i >= 0) {
      list[i] = list[list.length - 1];
      list.pop();
    }
    e.alive = false;
    if (e === commandOnScreen) commandOnScreen = null;
    // Safety net (§10): if a fully-typed command leaves the screen without its
    // effect having fired, fire it. The 0.3s window keeps a Game that already
    // called freeze()/purge()/stopSeq() itself from double-firing.
    if (e.kind === 'command' && !e.effectFired && e.typed >= e.word.length &&
        (U.now() - commandFiredAt) > 0.3) {
      e.effectFired = true;
      applyCommand(e.effect, e);
    }
    if (e.kind === 'bossword' && !e.deathHandled) handleBossWordDeath(e);
    const In = PI.Input;
    if (In && In.target === e && typeof In.release === 'function') In.release();
    return i >= 0;
  }

  function reset() {
    for (let i = 0; i < list.length; i++) list[i].alive = false;
    list.length = 0;
    if (boss) { boss.alive = false; boss.words.length = 0; }
    boss = null;
    bossTier = 0; bossesDefeated = 0;
    wave = num(TW.startWave, 1); pendingWave = wave;
    phase = 'idle'; phaseT = 0; idleGrace = 0;
    budget = 0; spawnedCount = 0; spawnTimer = 0;
    freezeT = 0;
    purgeQueue.length = 0; purgeTimer = 0;
    commandOnScreen = null; commandFiredAt = -99;
    cmdTimer = commandDelay();
    bannerShownFor = -1;
    nextId = 1;
  }

  function refreshTargetable() {
    const tw = targetableBossWord();
    let cmd = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      let ok = e.alive && !e.dying && e.spawnT > 0.35;
      if (e.kind === 'bossword') ok = ok && (e === tw);
      e.targetable = !!ok;
      if (e.kind === 'command' && e.alive) cmd = e;
    }
    commandOnScreen = cmd;
  }

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    const ts = (Core && typeof Core.timeScale === 'number' && Core.timeScale > 0.001) ? Core.timeScale : 1;
    const udt = dt / ts;                                 // ~real time (choreography)
    const state = (Core && Core.state) || 'PLAYING';

    if (freezeT > 0) freezeT = Math.max(0, freezeT - dt);
    updatePurge(udt);

    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (i >= list.length) continue;                    // swap-removal shrank us
      if (!e || !e.alive) { if (list.indexOf(e) >= 0) remove(e); continue; }
      updateEnemy(e, dt, udt, state);
    }

    updateBoss(dt, udt);

    if (state === 'PLAYING') {
      // Safety net: if Game never called startWave(), start wave 1 anyway.
      if (phase === 'idle' && !boss) {
        idleGrace += dt;
        if (idleGrace > 0.75 && threats() === 0) startWave(Math.max(1, wave || 1));
      } else idleGrace = 0;
      director(dt);
      // §10: one command every ~25s (+/-5s), never two at once
      if (phase !== 'idle' && phase !== 'bossintro' && !commandOnScreen) {
        cmdTimer -= dt;
        if (cmdTimer <= 0) spawnCommand();
      }
    }

    refreshTargetable();
  }

  // ------------------------------------------------------------------ api
  const api = {
    list: list,
    reset: reset,
    update: update,
    spawn: spawn,
    startWave: startWave,
    freeze: freeze,
    purge: purge,
    stopSeq: stopSeq,
    remove: remove,
    targetableBossWord: targetableBossWord,
    // extras the integrator may find useful (all documented in the header)
    applyCommand: applyCommand,
    bossWordKilled: bossWordKilled,
    spawnCommand: spawnCommand,
    spawnTutorial: spawnTutorial,
    measureEnemy: measureEnemy,
    letterPos: letterPos,
    nextChar: nextChar,
    nextBossWave: nextBossWave,
    targetable: function (e) { return !!(e && e.targetable); },
    threats: threats,
    leakLine: LEAK_Y
  };
  // Contract properties that must always read live state. Setters exist so a
  // stray assignment from another module can never throw in strict mode.
  Object.defineProperty(api, 'wave', {
    get: function () { return wave; },
    set: function (v) { wave = Math.max(0, Math.round(num(v, wave))); }
  });
  Object.defineProperty(api, 'boss', {
    get: function () { return boss; },
    set: function (v) { if (v === null) hardClearBoss(); }
  });
  Object.defineProperty(api, 'bossTier', {
    get: function () { return bossTier; },
    set: function (v) { bossTier = Math.max(0, Math.round(num(v, bossTier))); }
  });
  Object.defineProperty(api, 'commandOnScreen', {
    get: function () { return commandOnScreen; },
    set: function (v) { if (v === null) { if (commandOnScreen) remove(commandOnScreen); } }
  });
  Object.defineProperty(api, 'frozen', { get: function () { return freezeT > 0; } });
  Object.defineProperty(api, 'freezeT', { get: function () { return freezeT; } });
  Object.defineProperty(api, 'phase', { get: function () { return phase; } });
  Object.defineProperty(api, 'phaseT', { get: function () { return phaseT; } });
  Object.defineProperty(api, 'budget', { get: function () { return budget; } });
  Object.defineProperty(api, 'spawned', { get: function () { return spawnedCount; } });
  Object.defineProperty(api, 'speedMul', { get: function () { return currentSpeedMul(); } });
  Object.defineProperty(api, 'spawnInterval', { get: function () { return currentInterval(); } });
  Object.defineProperty(api, 'bossesDefeated', { get: function () { return bossesDefeated; } });
  Object.defineProperty(api, 'purging', { get: function () { return purgeQueue.length > 0; } });

  return api;
})();
