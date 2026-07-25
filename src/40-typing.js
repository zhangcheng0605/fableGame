// 40-typing.js — PI.Input (targeting + keystroke model, DESIGN.md §4/§5) and
// PI.Score (score / combo / multiplier / FLOW STATE / persistence, DESIGN.md §9).
//
// Only assignments onto PI; every private is inside an IIFE. Nothing here draws:
// Render reads PI.Score.value/.combo/.multiplier()/.flow/.breakFlash and
// PI.Input.target/.accuracy() and paints them.

PI.Input = (function () {
  const U = PI.U, T = PI.TUNING;

  // A materializing enemy (§11.5, 250ms glyph converge) is not targetable until
  // it is mostly assembled, so a keystroke can never lock something invisible.
  const MIN_SPAWN = 0.35;
  const DEATH_LOCKOUT = 0.6;                 // §16: a mash must not skip the death screen
  const LEGAL = /^[a-z0-9 '\-=]$/;           // §4: the only typeable characters

  let totalKeys = 0, goodKeys = 0;
  let localMuted = false;
  let seenState = null, deathAt = -1e9, justStamped = false;

  function snd(fn, a) {
    const A = PI.Audio;
    if (A && typeof A[fn] === 'function') { try { A[fn](a); } catch (_) { /* audio never breaks play */ } }
  }
  function initAudio() {
    // §13: one shared AudioContext, created inside the user gesture. Idempotent —
    // Core kicks it too.
    const A = PI.Audio;
    if (A && typeof A.init === 'function') { try { A.init(); } catch (_) { } }
  }
  function stateNow() { return (PI.Core && PI.Core.state) ? PI.Core.state : 'TITLE'; }

  // Core gives Input no per-frame tick, so the death timestamp behind the [ENTER]
  // lockout is stamped the first time any entry point *observes* GAME_OVER. The
  // renderer reads PI.Input.accuracy() while drawing the death screen, so in
  // practice the stamp lands on the death frame itself; PI.Score.save() also
  // calls noteDeath(). If nothing ever observes the transition before the first
  // Enter, `justStamped` lets that Enter through instead of eating it.
  function watch() {
    const s = stateNow();
    justStamped = false;
    if (s !== seenState) {
      if (s === 'GAME_OVER') { deathAt = U.now(); justStamped = true; }
      seenState = s;
    }
    return s;
  }
  function noteDeath() { seenState = 'GAME_OVER'; deathAt = U.now(); justStamped = false; }

  // ---------------------------------------------------------------- targeting
  function nextChar(e) {
    const w = e && e.word;
    if (typeof w !== 'string') return '';
    const i = e.typed | 0;
    return (i >= 0 && i < w.length) ? w.charAt(i) : '';
  }

  function ready(e) {
    if (!e || !e.alive || e.dying) return false;
    const s = (typeof e.spawnT === 'number') ? e.spawnT : 1;
    return s > MIN_SPAWN;
  }

  // §7: only the leftmost living boss word is targetable.
  function bossTarget() {
    const E = PI.Entities;
    if (!E) return null;
    if (typeof E.targetableBossWord === 'function') {
      const b = E.targetableBossWord();
      if (b) return b;
    }
    const boss = E.boss;
    if (boss && boss.words) {
      for (let i = 0; i < boss.words.length; i++) {
        const w = boss.words[i];
        if (w && w.alive && !w.dying && nextChar(w) !== '') return w;
      }
    }
    return null;
  }

  // §5: with no lock, the enemy NEAREST THE BOTTOM (greatest y) whose next
  // expected char matches wins, deterministically.
  function findCandidate(ch) {
    const E = PI.Entities;
    let best = null, bestY = -Infinity;
    const list = (E && E.list) ? E.list : null;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e.kind === 'bossword') continue;      // boss handled below
        if (!ready(e) || nextChar(e) !== ch) continue;
        const y = (typeof e.y === 'number') ? e.y : 0;
        if (y > bestY) { bestY = y; best = e; }
      }
    }
    const bw = bossTarget();
    if (bw && ready(bw) && nextChar(bw) === ch) {
      let y = (typeof bw.y === 'number') ? bw.y : 0;
      if (!y && E.boss && typeof E.boss.y === 'number') y = E.boss.y;
      if (y > bestY) { bestY = y; best = bw; }
    }
    return best;
  }

  // A lock survives until kill / Escape / the enemy leaving play. Consumed chars
  // stay on the enemy either way (§5: progress persists).
  function lockValid(e) {
    if (!e || !e.alive || e.dying) return false;
    if (nextChar(e) === '') return false;
    if (e.kind === 'bossword') return bossTarget() === e;
    const list = (PI.Entities && PI.Entities.list) ? PI.Entities.list : null;
    if (list && list.indexOf(e) < 0) return false;
    return true;
  }

  function release() { api.target = null; }
  function releaseIf(e) { if (api.target === e) api.target = null; }

  // ---------------------------------------------------------------- feedback
  // Game.hit(e) owns the per-keystroke juice (muzzle flash, beam, letter pop,
  // sparks, rising blip). fallbackHit only runs if Game has no hit() — the game
  // must never go silent on a correct key.
  function hit(e) {
    const G = PI.Game;
    if (G && typeof G.hit === 'function') { G.hit(e); return; }
    fallbackHit(e);
  }

  function fallbackHit(e) {
    snd('key', e.typed);
    if (!PI.FX) return;
    const P = T.player, EC = T.enemy.common, F = T.fx;
    const cfg = T.enemy[e.type];
    const size = (cfg && cfg.fontSize) || EC.fontSize;
    const cw = size * 0.6;                                   // monospace advance ≈ 0.6em
    const len = e.word.length;
    const lx = e.x - len * cw * 0.5 + ((e.typed | 0) - 0.5) * cw;
    const color = e.color || PI.C.forType(e.type);
    PI.FX.beam(P.turretX, P.turretY, lx, e.y, {
      color: PI.C.green, life: F.beam.life, width: F.beam.width, bloom: F.beam.bloom
    });
    PI.FX.spark(lx, e.y, {
      color: color, count: F.keySpark.count, speed: F.keySpark.speed,
      life: F.keySpark.life, size: F.keySpark.size
    });
  }

  function kill(e) {
    const G = PI.Game;
    if (G && typeof G.killEnemy === 'function') { G.killEnemy(e); return; }
    if (PI.Score) PI.Score.onKill(e);
    if (PI.Entities && typeof PI.Entities.remove === 'function') PI.Entities.remove(e);
  }

  function typo(e) {
    const G = PI.Game;
    if (G && typeof G.typo === 'function') { G.typo(e || null); return; }
    if (PI.Score) PI.Score.breakCombo();
    snd('typo');
    if (PI.Core) PI.Core.addTrauma(T.juice.trauma.typo);
  }

  // ---------------------------------------------------------------- typing
  function typeKey(ch) {
    let e = api.target;
    if (e && !lockValid(e)) { release(); e = null; }

    if (!e) {
      const cand = findCandidate(ch);
      if (!cand) {
        // §4: space is a real character (boss phrases are typed word by word), but
        // a space that matches nothing is free — never a typo.
        if (ch === ' ') return;
        totalKeys++; api.totalKeys = totalKeys;
        typo(null);
        return;
      }
      api.target = cand;
      e = cand;                    // §5: the locking keystroke IS the first letter
    } else if (nextChar(e) !== ch) {
      if (ch === ' ') return;      // habitual space between boss words: ignored
      totalKeys++; api.totalKeys = totalKeys;
      typo(e);
      return;
    }

    totalKeys++; api.totalKeys = totalKeys;
    goodKeys++; api.goodKeys = goodKeys;
    e.typed = (e.typed | 0) + 1;
    hit(e);
    if (e.typed >= e.word.length) {
      kill(e);
      releaseIf(e);
    }
  }

  function toggleMute() {
    const A = PI.Audio;
    if (A && typeof A.toggleMute === 'function') { A.toggleMute(); localMuted = !!A.muted; }
    else localMuted = !localMuted;
    snd('uiTick');               // audible confirmation on un-mute
  }

  function newRun() {
    const G = PI.Game;
    if (G && typeof G.newRun === 'function') G.newRun();
  }

  function key(ch) {
    if (typeof ch !== 'string' || ch.length !== 1) return;
    ch = ch.toLowerCase();
    if (!LEGAL.test(ch)) return;

    const st = watch();
    initAudio();

    if (st === 'PLAYING') { typeKey(ch); return; }

    // MUTE POLICY (deliberate reading of §4): 'm' toggles mute only while NOT
    // playing. During play every printable key is a gameplay keystroke (§5) —
    // binding mute there would either swallow the 'm' of a word or turn a
    // legitimate keystroke into a typo. The title and death screens are where a
    // player actually reaches for mute. On the title the tutorial enemy still
    // wins the key if it expects an 'm'.
    if (ch === 'm' && !(st === 'TITLE' && (matchesLive(ch)))) { toggleMute(); return; }

    // PI.Game owns the non-playing screens (title logo, tutorial enemy, death
    // stats, touch card), so it gets first refusal on the key. Returning true
    // means "handled, Input should stay out of it".
    const G = PI.Game;
    if (G && typeof G.titleKey === 'function' && G.titleKey(ch) === true) return;

    if (st === 'TITLE') {
      // §4/§16: the title spawns one slow tutorial enemy ('start'), so the title
      // screen is typable and a cold load reaches play in ≤2 keystrokes. A key
      // that matches nothing just starts the run rather than scolding the player.
      if (api.target || findCandidate(ch)) { typeKey(ch); return; }
      newRun();
      return;
    }
    // GAME_OVER / PAUSED: [ENTER] retries (§3). Printable keys are ignored so
    // in-flight keystrokes cannot blow past the stats screen.
  }

  function matchesLive(ch) {
    if (api.target && nextChar(api.target) === ch) return true;
    return !!findCandidate(ch);
  }

  function enter() {
    const st = watch();
    initAudio();
    if (st === 'TITLE') { snd('uiTick'); newRun(); return; }
    if (st === 'GAME_OVER') {
      if (!justStamped && (U.now() - deathAt) < DEATH_LOCKOUT) return;
      snd('uiTick');
      newRun();
    }
  }

  function escape() {
    watch();
    if (api.target) { release(); snd('uiTick'); }   // §4: free action
  }

  function reset() {
    release();
    totalKeys = 0; goodKeys = 0;
    api.totalKeys = 0; api.goodKeys = 0;
  }

  function accuracy() {
    watch();                        // cheap frame hook: the HUD/death screen call this
    if (totalKeys <= 0) return 1;
    return U.clamp(goodKeys / totalKeys, 0, 1);
  }

  const api = {
    target: null,
    totalKeys: 0,
    goodKeys: 0,
    key: key,
    enter: enter,
    escape: escape,
    release: release,
    reset: reset,
    accuracy: accuracy,
    toggleMute: toggleMute,
    noteDeath: noteDeath,
    candidate: findCandidate        // exposed for Entities' first-letter-clash rerolls
  };
  Object.defineProperty(api, 'muted', {
    enumerable: true,
    get: function () {
      const A = PI.Audio;
      return (A && typeof A.muted === 'boolean') ? A.muted : localMuted;
    },
    set: function (v) { if (!!v !== api.muted) toggleMute(); }
  });

  return api;
})();


PI.Score = (function () {
  const U = PI.U, T = PI.TUNING;
  const TS = T.score, TC = T.combo, TF = T.flow, VIEW = T.view, HUD = T.hud;

  const TIER = Math.max(1, TC.tier || 5);
  const CAP = Math.max(1, TC.cap || 8);
  const FLOW_AT = TF.threshold || 25;
  const FLOW_MUL = TF.multiplier || 2;
  const PER_LETTER = TS.perLetter || 10;
  const KEY_HIGH = TS.highKey || 'pi_highscore';
  const KEY_COMBO = TS.comboKey || 'pi_bestcombo';
  const AUDIO_STEPS = 8;                       // combo melody wraps every 8 kills

  let value = 0, combo = 0, bestCombo = 0;
  let high = 0, highCombo = 0, isNewHigh = false;
  let flow = false;
  let breakUntil = -1, comboAt = -1, tierAt = -1, flowAt = -1, lastTier = 1;

  const display = U.counter(0);
  // Where the combo counter cracks (§11.5). 50-render may overwrite x/y with the
  // real HUD position; this default is the top-right corner of the HUD band.
  const anchor = { x: VIEW.W - (HUD.pad || 24) - 46, y: (HUD.topY || 40) + 6 };

  function snd(fn, a) {
    const A = PI.Audio;
    if (A && typeof A[fn] === 'function') { try { A[fn](a); } catch (_) { } }
  }
  function store() { try { return window.localStorage; } catch (_) { return null; } }
  function multOf(c) { return Math.min(CAP, 1 + Math.floor(c / TIER)); }

  // Music intensity tracks the multiplier, FLOW pins it near the top (§11/§13).
  function pushIntensity() {
    const base = (CAP > 1) ? (multOf(combo) - 1) / (CAP - 1) : 0;
    snd('setIntensity', U.clamp(base * 0.7 + (flow ? 0.3 : 0), 0, 1));
  }

  // FLOW STATE is derived from combo, so this runs on every read of .flow and
  // every multiplier() call — the transition side effects fire exactly once.
  function syncFlow() {
    const want = combo >= FLOW_AT;
    if (want === flow) return flow;
    flow = want;
    flowAt = U.now();
    if (flow) {
      snd('flowStart');
      if (PI.Core) {
        PI.Core.flash(0.10, 0.34, TF.tint || PI.C.cyan);
        PI.Core.addTrauma(0.18);
        PI.Core.punch(0.02, 0.3);
      }
      if (PI.FX) {
        PI.FX.ring(T.player.turretX, T.player.turretY, {
          color: TF.tint || PI.C.cyan, r0: 14, r1: 300, life: 0.6, width: 5
        });
      }
    } else {
      snd('flowEnd');
    }
    pushIntensity();
    return flow;
  }

  function multiplier() { syncFlow(); return multOf(combo); }
  function totalMultiplier() { return multiplier() * (flow ? FLOW_MUL : 1); }

  function bump(p) {
    value = Math.max(0, value + p);
    display.set(value);
  }

  function popColor(total) {
    if (flow) return TF.tint || PI.C.cyan;
    if (total >= 6) return PI.C.gold;
    if (total >= 3) return PI.C.green;
    return PI.C.white;
  }

  function popupAt(x, y, text, color) {
    if (!PI.FX || typeof x !== 'number' || typeof y !== 'number') return;
    PI.FX.popup(x, y, text, {
      color: color, size: TS.popupSize, life: TS.popupLife,
      vy: TS.popupVy, scalePop: TS.popupScalePop
    });
  }

  // Flat award (boss bonus, command bonus, wave clear). x/y optional popup.
  function add(points, x, y) {
    const p = Math.round(points);
    if (!isFinite(p) || p === 0) return value;
    bump(p);
    popupAt(x, y, (p > 0 ? '+' : '') + p, p > 0 ? PI.C.gold : PI.C.red);
    return value;
  }

  // §9: base 10 × word length × combo multiplier × FLOW ×2. Boss-word and
  // boss-kill bonuses are added by PI.Game on top of this (§7).
  function onKill(e) {
    const word = (e && typeof e.word === 'string') ? e.word : '';
    const len = word.length || 1;

    combo++;
    if (combo > bestCombo) bestCombo = combo;
    comboAt = U.now();
    syncFlow();

    const mult = multOf(combo);
    if (mult !== lastTier) { lastTier = mult; tierAt = U.now(); }
    const total = mult * (flow ? FLOW_MUL : 1);
    const pts = Math.round(PER_LETTER * len * total);
    bump(pts);

    const x = (e && typeof e.x === 'number') ? e.x : VIEW.W * 0.5;
    const y = (e && typeof e.y === 'number') ? e.y : VIEW.H * 0.5;
    popupAt(x, y - 16, '+' + pts + (total > 1 ? ' ×' + total : ''), popColor(total));

    snd('kill', (combo - 1) % AUDIO_STEPS);     // combos literally play a melody
    pushIntensity();
    return pts;
  }

  // §9: any typo or leak resets the combo — glass shatter, counter cracks into
  // shards, desaturation blink (Render reads PI.Score.breakFlash).
  function breakCombo() {
    const had = combo;
    combo = 0;
    comboAt = U.now();
    lastTier = 1;
    syncFlow();                                  // exits FLOW if it was active
    if (had <= 0) { pushIntensity(); return; }
    breakUntil = U.now() + (TC.breakDesaturate || 0.22);
    snd('comboBreak');
    if (PI.FX) {
      PI.FX.shard(anchor.x, anchor.y, {
        color: PI.C.red, count: TC.breakShards, text: '×' + multOf(had),
        size: (HUD.comboSize || 40) * 0.7,
        life: TC.breakShardLife, gravity: TC.breakShardGravity
      });
      PI.FX.ring(anchor.x, anchor.y, { color: PI.C.red, r0: 6, r1: 74, life: 0.34, width: 2 });
    }
    pushIntensity();
  }

  function reset() {
    value = 0; combo = 0; bestCombo = 0;
    isNewHigh = false;
    breakUntil = -1; comboAt = -1; tierAt = -1; flowAt = -1; lastTier = 1;
    if (flow) { flow = false; snd('flowEnd'); }
    if (typeof display.snap === 'function') display.snap(0); else display.set(0);
    pushIntensity();
  }

  function load() {
    const ls = store();
    if (!ls) return;
    try {
      const h = parseInt(ls.getItem(KEY_HIGH), 10);
      if (isFinite(h) && h > high) high = h;
    } catch (_) { }
    try {
      const c = parseInt(ls.getItem(KEY_COMBO), 10);
      if (isFinite(c) && c > highCombo) highCombo = c;
    } catch (_) { }
  }

  // Called by PI.Game.gameOver(). Sets isNewHigh for the NEW HIGH SCORE stamp
  // (§9) — the audio/confetti for it stay Game's call so they fire once.
  function save() {
    if (value > 0 && value > high) { high = value; isNewHigh = true; }
    if (bestCombo > highCombo) highCombo = bestCombo;
    const ls = store();
    if (ls) {
      try { ls.setItem(KEY_HIGH, String(Math.round(high))); } catch (_) { }
      try { ls.setItem(KEY_COMBO, String(Math.round(highCombo))); } catch (_) { }
    }
    if (PI.Core && PI.Core.state === 'GAME_OVER' && PI.Input && PI.Input.noteDeath) PI.Input.noteDeath();
    return isNewHigh;
  }

  // Convenience for PI.Game.update(dt): advances the tweened score readout.
  // Game may equally call PI.Score.display.update(dt) itself.
  function update(dt) { display.update(dt); return display.value; }

  function setCombo(n) {
    let v = Math.floor(n);
    if (!isFinite(v) || v < 0) v = 0;
    combo = v;
    if (combo > bestCombo) bestCombo = combo;
    comboAt = U.now();
    lastTier = multOf(combo);
    syncFlow();
  }

  const api = {
    display: display,
    comboAnchor: anchor,
    multiplier: multiplier,
    totalMultiplier: totalMultiplier,
    reset: reset,
    add: add,
    onKill: onKill,
    breakCombo: breakCombo,
    load: load,
    save: save,
    update: update
  };

  function def(name, get, set) {
    Object.defineProperty(api, name, { enumerable: true, get: get, set: set });
  }
  def('value', function () { return value; }, function (v) {
    const n = Math.round(v);
    value = (isFinite(n) && n > 0) ? n : 0;
    display.set(value);
  });
  def('combo', function () { return combo; }, setCombo);
  def('bestCombo', function () { return bestCombo; }, function (v) {
    const n = Math.floor(v);
    bestCombo = (isFinite(n) && n > 0) ? n : 0;
  });
  def('high', function () { return high; }, function (v) {
    const n = Math.round(v);
    high = (isFinite(n) && n > 0) ? n : 0;
  });
  // All-time best combo (localStorage 'pi_bestcombo'); bestCombo is this run's.
  def('highCombo', function () { return highCombo; }, function (v) {
    const n = Math.floor(v);
    highCombo = (isFinite(n) && n > 0) ? n : 0;
  });
  def('bestComboEver', function () { return highCombo; }, function (v) { api.highCombo = v; });
  def('isNewHigh', function () { return isNewHigh; }, function (v) { isNewHigh = !!v; });
  // Derived from combo — the setter exists only so a stray assignment in strict
  // mode cannot throw.
  def('flow', function () { return syncFlow(); }, function () { });
  // Seconds of desaturation blink left after a combo break (0 = inactive).
  def('breakFlash', function () { return Math.max(0, breakUntil - U.now()); }, function () { });
  // Seconds since the combo last changed / the multiplier tier last changed /
  // FLOW last toggled — Render drives the squash-stretch and ring pulse off these.
  def('comboAge', function () { return comboAt < 0 ? 999 : Math.max(0, U.now() - comboAt); }, function () { });
  def('tierAge', function () { return tierAt < 0 ? 999 : Math.max(0, U.now() - tierAt); }, function () { });
  def('flowAge', function () { return flowAt < 0 ? 999 : Math.max(0, U.now() - flowAt); }, function () { });
  def('tier', function () { return multOf(combo); }, function () { });

  load();     // so the title screen shows the persisted high score immediately
  return api;
})();
