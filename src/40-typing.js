// 40-typing.js — PI.Input (targeting + keystroke model, DESIGN.md §4/§5) and
// PI.Score (score / combo / multiplier / FLOW STATE / persistence, DESIGN.md §9).
// Nothing here draws: Render reads .value/.combo/.multiplier()/.flow/.breakFlash
// and PI.Input.target/.accuracy() and paints them.

PI.Input = (function () {
  const U = PI.U, T = PI.TUNING;

  // A materializing enemy (§11.5 — 250ms glyph converge) is not targetable until
  // it is mostly assembled, so a keystroke can never lock something invisible.
  const MIN_SPAWN = 0.35;
  const DEATH_LOCKOUT = 0.6;               // §16: a mash must not skip the death screen
  const LEGAL = /^[a-z0-9 '\-=]$/;         // §4: the only typeable characters

  let totalKeys = 0, goodKeys = 0, localMuted = false;
  let seenState = null, deathAt = -1e9, justStamped = false;

  function now() { return (typeof U.now === 'function') ? U.now() : Date.now() / 1000; }
  function stateNow() { return (PI.Core && PI.Core.state) ? PI.Core.state : 'TITLE'; }
  function snd(fn, a) {
    const A = PI.Audio;
    if (A && typeof A[fn] === 'function') { try { A[fn](a); } catch (_) { /* audio never breaks play */ } }
  }
  // §13: one shared AudioContext, born inside a user gesture. Idempotent — Core
  // kicks it on keydown too.
  function initAudio() { snd('init'); }

  // Core gives Input no per-frame tick, so the death timestamp behind the [ENTER]
  // lockout is stamped the first time any entry point *observes* GAME_OVER — the
  // renderer calls PI.Input.accuracy() while drawing the death screen, so in
  // practice that is the death frame. `justStamped` lets the very first Enter
  // through if nothing observed the transition, rather than eating it.
  function watch() {
    const s = stateNow();
    justStamped = false;
    if (s !== seenState) {
      seenState = s;
      if (s === 'GAME_OVER') {
        deathAt = now();
        justStamped = true;
        // Safety net: persistence + the NEW HIGH SCORE stamp can't be forgotten.
        // save() is idempotent, so Game calling it in gameOver() is harmless.
        if (PI.Score && typeof PI.Score.save === 'function') PI.Score.save();
      }
    }
    return s;
  }
  function noteDeath() { seenState = 'GAME_OVER'; deathAt = now(); justStamped = false; }

  // ---------------------------------------------------------------- targeting
  function nextChar(e) {
    const w = e && e.word;
    if (typeof w !== 'string') return '';
    const i = e.typed | 0;
    return (i >= 0 && i < w.length) ? w.charAt(i) : '';
  }
  function ready(e) {
    if (!e || !e.alive || e.dying) return false;
    return ((typeof e.spawnT === 'number') ? e.spawnT : 1) > MIN_SPAWN;
  }

  // §7: only the leftmost living boss word is targetable. Entities owns that call
  // and its null is authoritative (it also locks the boss out during the 1.2s
  // intro choreography, §11.5) — the scan below is only a no-Entities fallback.
  function bossTarget() {
    const E = PI.Entities;
    if (!E) return null;
    if (typeof E.targetableBossWord === 'function') return E.targetableBossWord() || null;
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
    const list = (E && E.list) ? E.list : null;
    let best = null, bestY = -Infinity;
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e.kind === 'bossword') continue;         // boss handled below
        if (!ready(e) || nextChar(e) !== ch) continue;
        const y = (typeof e.y === 'number') ? e.y : 0;
        if (y > bestY) { bestY = y; best = e; }
      }
    }
    const bw = bossTarget();
    if (bw && ready(bw) && nextChar(bw) === ch) {
      let y = (typeof bw.y === 'number') ? bw.y : 0;
      if (!y && E.boss && typeof E.boss.y === 'number') y = E.boss.y;
      if (y > bestY) best = bw;
    }
    return best;
  }

  // A lock survives until kill / Escape / the enemy leaving play. Consumed chars
  // stay on the enemy either way (§5: the typed prefix persists).
  function lockValid(e) {
    if (!e || !e.alive || e.dying || nextChar(e) === '') return false;
    if (e.kind === 'bossword') return bossTarget() === e;
    const list = (PI.Entities && PI.Entities.list) ? PI.Entities.list : null;
    return !(list && list.indexOf(e) < 0);
  }

  function release() { api.target = null; }

  // ---------------------------------------------------------------- feedback
  // Game.hit(e) owns the per-keystroke juice (muzzle flash, beam, letter pop,
  // sparks, rising blip). fallbackHit exists so a correct key is never silent if
  // Game ships without hit().
  function hit(e) {
    const G = PI.Game;
    if (G && typeof G.hit === 'function') { G.hit(e); return; }
    snd('key', e.typed);
    if (!PI.FX) return;
    const P = T.player, F = T.fx;
    const cfg = T.enemy[e.type];
    const cw = ((cfg && cfg.fontSize) || T.enemy.common.fontSize) * 0.6;  // mono advance ≈ 0.6em
    const lx = e.x - e.word.length * cw * 0.5 + ((e.typed | 0) - 0.5) * cw;
    PI.FX.beam(P.turretX, P.turretY, lx, e.y,
      { color: PI.C.green, life: F.beam.life, width: F.beam.width, bloom: F.beam.bloom });
    PI.FX.spark(lx, e.y, {
      color: e.color || PI.C.forType(e.type), count: F.keySpark.count,
      speed: F.keySpark.speed, life: F.keySpark.life, size: F.keySpark.size
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
      e = findCandidate(ch);
      if (!e) {
        // §4: space is a real character (boss phrases are typed word by word), but
        // a space matching nothing is free — a habit key, never a typo.
        if (ch === ' ') return;
        totalKeys++; api.totalKeys = totalKeys;
        typo(null);
        return;
      }
      api.target = e;                // §5: the locking keystroke IS the first letter
    } else if (nextChar(e) !== ch) {
      if (ch === ' ') return;        // habitual space between boss words: ignored
      totalKeys++; api.totalKeys = totalKeys;
      typo(e);                       // §5: the lock is kept, only the combo dies
      return;
    }

    totalKeys++; api.totalKeys = totalKeys;
    goodKeys++; api.goodKeys = goodKeys;
    e.typed = (e.typed | 0) + 1;
    hit(e);
    if (e.typed >= e.word.length) {
      kill(e);
      if (api.target === e) api.target = null;
    }
  }

  function toggleMute() {
    const A = PI.Audio;
    if (A && typeof A.toggleMute === 'function') { A.toggleMute(); localMuted = !!A.muted; }
    else localMuted = !localMuted;
    snd('uiTick');                   // audible confirmation on un-mute
  }
  function newRun() {
    const G = PI.Game;
    if (G && typeof G.newRun === 'function') G.newRun();
  }
  function matchesLive(ch) {
    if (api.target && nextChar(api.target) === ch) return true;
    return !!findCandidate(ch);
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
    // legitimate keystroke into a typo. Title / death screens are where a player
    // actually reaches for it, and even there a live enemy expecting 'm' wins.
    if (ch === 'm' && !(st === 'TITLE' && matchesLive(ch))) { toggleMute(); return; }

    // Game owns the non-playing screens (title logo, tutorial enemy, death stats,
    // touch card), so it gets first refusal. `true` means "handled, stay out".
    const G = PI.Game;
    if (G && typeof G.titleKey === 'function' && G.titleKey(ch) === true) return;

    if (st === 'TITLE') {
      // §4/§16: the title spawns one slow tutorial enemy ('start'), so the title
      // screen is typable and a cold load reaches play in ≤2 keystrokes. A key
      // that matches nothing just starts the run instead of scolding the player.
      if (api.target || findCandidate(ch)) typeKey(ch);
      else newRun();
    }
    // GAME_OVER / PAUSED: [ENTER] retries (§3). Printable keys are ignored so
    // in-flight keystrokes cannot blow past the stats screen.
  }

  function enter() {
    const st = watch();
    initAudio();
    if (st === 'TITLE') { snd('uiTick'); newRun(); return; }
    if (st === 'GAME_OVER') {
      if (!justStamped && (now() - deathAt) < DEATH_LOCKOUT) return;
      snd('uiTick');
      newRun();
    }
  }

  function escape() {
    watch();
    if (api.target) { release(); snd('uiTick'); }      // §4: free action
  }

  function reset() {
    release();
    totalKeys = 0; goodKeys = 0;
    api.totalKeys = 0; api.goodKeys = 0;
  }

  function accuracy() {
    watch();                          // cheap frame hook: HUD / death screen call this
    if (totalKeys <= 0) return 1;
    return U.clamp(goodKeys / totalKeys, 0, 1);
  }

  const api = {
    target: null, totalKeys: 0, goodKeys: 0,
    key: key, enter: enter, escape: escape,
    release: release, reset: reset, accuracy: accuracy,
    toggleMute: toggleMute,
    noteDeath: noteDeath,             // Game/Score may stamp the death moment exactly
    candidate: findCandidate          // spawner can check first-letter clashes
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
  const TIER = Math.max(1, TC.tier || 5);          // ×(1 + floor(combo/5)) …
  const CAP = Math.max(1, TC.cap || 8);            // … capped ×8 (§9)
  const FLOW_AT = TF.threshold || 25;
  const FLOW_MUL = TF.multiplier || 2;
  const PER_LETTER = TS.perLetter || 10;
  const KEY_HIGH = TS.highKey || 'pi_highscore';
  const KEY_COMBO = TS.comboKey || 'pi_bestcombo';
  const STEPS = 8;                                 // kill melody wraps every 8 kills

  let value = 0, combo = 0, bestCombo = 0;
  let high = 0, highCombo = 0, isNewHigh = false, flow = false;
  let breakUntil = -1, comboAt = -1, tierAt = -1, flowAt = -1, lastTier = 1;

  const display = U.counter(0);
  // Where the combo counter cracks (§11.5). 50-render may overwrite x/y with the
  // real HUD position; this default is the top-right of the HUD band.
  const anchor = { x: VIEW.W - (HUD.pad || 24) - 46, y: (HUD.topY || 40) + 6 };

  function now() { return (typeof U.now === 'function') ? U.now() : Date.now() / 1000; }
  function snd(fn, a) {
    const A = PI.Audio;
    if (A && typeof A[fn] === 'function') { try { A[fn](a); } catch (_) { } }
  }
  function store() { try { return window.localStorage; } catch (_) { return null; } }
  function multOf(c) { return Math.min(CAP, 1 + Math.floor(c / TIER)); }
  function pint(v, min) { const n = Math.floor(v); return (isFinite(n) && n > min) ? n : min; }

  // Music intensity tracks the multiplier; FLOW pins it near the top (§11/§13).
  function pushIntensity() {
    const base = (CAP > 1) ? (multOf(combo) - 1) / (CAP - 1) : 0;
    snd('setIntensity', U.clamp(base * 0.7 + (flow ? 0.3 : 0), 0, 1));
  }

  // FLOW STATE is derived from combo, so this runs on every read of .flow and on
  // every multiplier() call; the transition side effects fire exactly once.
  function syncFlow() {
    const want = combo >= FLOW_AT;
    if (want === flow) return flow;
    flow = want;
    flowAt = now();
    if (flow) {
      snd('flowStart');
      if (PI.Core) {
        PI.Core.flash(0.10, 0.34, TF.tint || PI.C.cyan);
        PI.Core.addTrauma(0.18);
        PI.Core.punch(0.02, 0.3);
      }
      if (PI.FX) {
        PI.FX.ring(T.player.turretX, T.player.turretY,
          { color: TF.tint || PI.C.cyan, r0: 14, r1: 300, life: 0.6, width: 5 });
      }
    } else snd('flowEnd');
    pushIntensity();
    return flow;
  }

  function multiplier() { syncFlow(); return multOf(combo); }
  function totalMultiplier() { return multiplier() * (flow ? FLOW_MUL : 1); }
  function bump(p) { value = Math.max(0, value + p); display.set(value); }

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

  // Flat award (boss kill reward, command bonus, wave clear). x/y optional popup.
  function add(points, x, y) {
    const p = Math.round(points);
    if (!isFinite(p) || p === 0) return value;
    bump(p);
    popupAt(x, y, (p > 0 ? '+' : '') + p, p > 0 ? PI.C.gold : PI.C.red);
    return value;
  }

  // §9: 10 × word length × combo multiplier × (FLOW ? 2 : 1). Boss-word and
  // boss-kill bonuses are added on top by PI.Game (§7).
  function onKill(e) {
    const word = (e && typeof e.word === 'string') ? e.word : '';
    const len = word.length || 1;

    combo++;
    if (combo > bestCombo) bestCombo = combo;
    comboAt = now();
    syncFlow();

    const mult = multOf(combo);
    if (mult !== lastTier) { lastTier = mult; tierAt = now(); }   // tier ring pulse
    const total = mult * (flow ? FLOW_MUL : 1);
    const pts = Math.round(PER_LETTER * len * total);
    bump(pts);

    const x = (e && typeof e.x === 'number') ? e.x : VIEW.W * 0.5;
    const y = (e && typeof e.y === 'number') ? e.y : VIEW.H * 0.5;
    popupAt(x, y - 16, '+' + pts + (total > 1 ? ' ×' + total : ''), popColor(total));

    snd('kill', (combo - 1) % STEPS);          // combos literally play a melody
    pushIntensity();
    return pts;
  }

  // §9: a typo or a leak resets the combo — glass shatter, the counter cracks into
  // falling shards, desaturation blink (Render reads PI.Score.breakFlash).
  function breakCombo() {
    const had = combo;
    combo = 0;
    comboAt = now();
    lastTier = 1;
    syncFlow();                                // exits FLOW if it was active
    if (had <= 0) { pushIntensity(); return; }  // nothing to shatter
    breakUntil = now() + (TC.breakDesaturate || 0.22);
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
    value = 0; combo = 0; bestCombo = 0; isNewHigh = false;
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

  // Called from PI.Game.gameOver(); also fired by Input the frame it observes
  // GAME_OVER, so persistence can't be missed. Idempotent. Sets isNewHigh for the
  // NEW HIGH SCORE stamp (§9) — the sting/confetti stay Game's call so they fire once.
  function save() {
    if (value > 0 && value > high) { high = value; isNewHigh = true; }
    if (bestCombo > highCombo) highCombo = bestCombo;
    const ls = store();
    if (ls) {
      try { ls.setItem(KEY_HIGH, String(Math.round(high))); } catch (_) { }
      try { ls.setItem(KEY_COMBO, String(Math.round(highCombo))); } catch (_) { }
    }
    return isNewHigh;
  }

  // Convenience for PI.Game.update(dt) — advances the tweened score readout.
  // Game may equally call PI.Score.display.update(dt) itself.
  function update(dt) { display.update(dt); return display.value; }

  function setCombo(n) {
    combo = pint(n, 0);
    if (combo > bestCombo) bestCombo = combo;
    comboAt = now();
    lastTier = multOf(combo);
    syncFlow();
  }

  const api = {
    display: display, comboAnchor: anchor,
    multiplier: multiplier, totalMultiplier: totalMultiplier,
    reset: reset, add: add, onKill: onKill, breakCombo: breakCombo,
    load: load, save: save, update: update
  };
  function def(name, get, set) {
    Object.defineProperty(api, name, { enumerable: true, get: get, set: set });
  }
  const NOP = function () { };        // derived props keep a setter so a stray
                                     // assignment can't throw under 'use strict'
  def('value', function () { return value; },
    function (v) { value = pint(Math.round(v), 0); display.set(value); });
  def('combo', function () { return combo; }, setCombo);
  def('bestCombo', function () { return bestCombo; }, function (v) { bestCombo = pint(v, 0); });
  def('high', function () { return high; }, function (v) { high = pint(Math.round(v), 0); });
  // All-time best combo (localStorage 'pi_bestcombo'); bestCombo is this run's.
  def('highCombo', function () { return highCombo; }, function (v) { highCombo = pint(v, 0); });
  def('bestComboEver', function () { return highCombo; }, function (v) { api.highCombo = v; });
  def('isNewHigh', function () { return isNewHigh; }, function (v) { isNewHigh = !!v; });
  def('flow', function () { return syncFlow(); }, NOP);
  def('tier', function () { return multOf(combo); }, NOP);
  // Seconds of desaturation blink left after a combo break (0 = inactive).
  def('breakFlash', function () { return Math.max(0, breakUntil - now()); }, NOP);
  // Seconds since combo / tier / FLOW last changed — Render drives the combo
  // squash-stretch, the tier ring pulse and the flow ramp off these.
  def('comboAge', function () { return comboAt < 0 ? 999 : Math.max(0, now() - comboAt); }, NOP);
  def('tierAge', function () { return tierAt < 0 ? 999 : Math.max(0, now() - tierAt); }, NOP);
  def('flowAge', function () { return flowAt < 0 ? 999 : Math.max(0, now() - flowAt); }, NOP);

  load();      // title screen shows the persisted high score on a cold load
  return api;
})();
