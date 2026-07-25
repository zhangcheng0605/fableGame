// PI.Game — the orchestrator. Owns run lifecycle, context integrity, and the glue
// every other module calls: hit / killEnemy / typo / leak. Calls into other modules
// are optional-chained so a partially wired build degrades instead of crashing.

PI.Game = (function () {
  const U = PI.U, C = PI.C, T = PI.TUNING;
  const W = T.view.W, H = T.view.H;
  const TP = T.player, J = T.juice, TS = T.score, TB = T.boss;

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  const API = {
    integrity: num(TP.integrityStart, 100),
    integrityGhost: num(TP.integrityStart, 100),
    runTime: 0,
  };

  let deathLock = 0;      // brief input lockout so a key mash cannot skip the death screen
  let bossDeathT = 0;     // drives the +15% "retyped into the context bar" refill
  let healQueue = 0;

  // ------------------------------------------------------------------- boot
  function boot() {
    try { if (PI.Score && PI.Score.load) PI.Score.load(); } catch (_) { }
    if (PI.Core && PI.Core.boot) PI.Core.boot();
    if (PI.Core && PI.Core.setState) PI.Core.setState('TITLE');
    if (PI.Render && PI.Render.resetScreens) PI.Render.resetScreens();
    // The title screen carries one slow tutorial enemy: destroying it starts wave 1 (§4).
    if (PI.Entities && PI.Entities.spawnTutorial) {
      try { PI.Entities.spawnTutorial(); } catch (_) { }
    }
  }

  // -------------------------------------------------------------- lifecycle
  function newRun() {
    API.integrity = num(TP.integrityStart, 100);
    API.integrityGhost = API.integrity;
    API.runTime = 0;
    bossDeathT = 0;
    healQueue = 0;
    deathLock = 0;
    if (PI.Entities && PI.Entities.reset) PI.Entities.reset();
    if (PI.Score && PI.Score.reset) PI.Score.reset();
    if (PI.Input && PI.Input.reset) PI.Input.reset();
    if (PI.FX && PI.FX.clear) PI.FX.clear();
    if (PI.Render && PI.Render.resetScreens) PI.Render.resetScreens();
    if (PI.Core && PI.Core.setState) PI.Core.setState('PLAYING');
    if (PI.Entities && PI.Entities.startWave) PI.Entities.startWave(num(T.wave.startWave, 1));
    if (PI.Audio) {
      if (PI.Audio.init) PI.Audio.init();
      if (PI.Audio.music) PI.Audio.music(true);
    }
  }

  function gameOver() {
    if (PI.Core && PI.Core.state === 'GAME_OVER') return;
    if (PI.Input && PI.Input.noteDeath) PI.Input.noteDeath();
    if (PI.Score && PI.Score.save) PI.Score.save();
    if (PI.Core) {
      if (PI.Core.setState) PI.Core.setState('GAME_OVER');
      if (PI.Core.setTimeScale) PI.Core.setTimeScale(0.35, 0.9);
      if (PI.Core.addTrauma) PI.Core.addTrauma(0.5);
    }
    if (PI.Audio) {
      if (PI.Audio.music) PI.Audio.music(false);
      if (PI.Audio.gameOver) PI.Audio.gameOver();
    }
    deathLock = 0.6;

    if (PI.Score && PI.Score.isNewHigh) {
      if (PI.Audio && PI.Audio.highScore) PI.Audio.highScore();
      if (PI.Core && PI.Core.addTrauma) PI.Core.addTrauma(num(J.trauma.highScore, 0.4));
      // confetti
      if (PI.FX) {
        const n = num(TS.confetti, 90);
        const colors = [C.gold, C.green, C.cyan, C.violet, C.white];
        for (let i = 0; i < n; i++) {
          PI.FX.glyph(U.rand(0, W), U.rand(-40, H * 0.3), U.pick(['▪', '▫', '/', '\\', '|']), {
            color: U.pick(colors),
            vx: [-160, 160], vy: [-120, 60],
            life: [0.9, 1.8], size: 14, spin: 7,
          });
        }
      }
    }
  }

  // Typing on the title screen types the tutorial enemy; anything else starts a run.
  function titleKey(ch) {
    if (PI.Audio && PI.Audio.init) PI.Audio.init();
    const s = PI.Core ? PI.Core.state : 'TITLE';
    if (s === 'GAME_OVER') {
      if (deathLock <= 0) newRun();
      return true;
    }
    if (s !== 'TITLE') return false;
    // Let the tutorial enemy absorb the keystroke if it matches.
    const E = PI.Entities;
    if (E && E.list) {
      for (let i = 0; i < E.list.length; i++) {
        const e = E.list[i];
        if (e && e.tutorial && e.alive && e.typed < e.word.length && e.word.charAt(e.typed) === ch) {
          return false;   // Input handles the hit through the normal path
        }
      }
    }
    newRun();
    return true;
  }

  // ------------------------------------------------------------------- hits
  const lp = { x: 0, y: 0 };

  function hit(e) {
    if (!e) return;
    const E = PI.Entities;
    const idx = Math.max(0, e.typed - 1);
    if (E && E.letterPos) E.letterPos(e, idx, lp);
    else { lp.x = num(e.x, W * 0.5); lp.y = num(e.y, 0); }

    // per-letter consume pop, read by the renderer
    e.popIndex = idx;
    e.popT = 0;

    if (PI.Render && PI.Render.fire) PI.Render.fire();
    if (PI.FX) {
      PI.FX.beam(num(TP.turretX, 640), num(TP.turretY, 634) - 18, lp.x, lp.y, {
        color: PI.Score && PI.Score.flow ? C.cyan : C.green,
        life: num(T.fx.beam.life, 0.03),
        width: num(T.fx.beam.width, 2.5),
        bloom: num(T.fx.beam.bloom, 9),
      });
      const ks = T.fx.keySpark;
      PI.FX.spark(lp.x, lp.y, {
        color: e.color || C.white,
        count: ks.count, speed: ks.speed, life: ks.life, size: ks.size, spread: ks.spread,
        angle: -Math.PI * 0.5,
      });
    }
    if (PI.Audio && PI.Audio.key) PI.Audio.key(e.typed);
  }

  function tierOf(e) {
    if (!e) return 'basic';
    if (e.kind === 'bossword' || e.kind === 'boss') return 'boss';
    const cfg = T.enemy[e.type];
    return (cfg && cfg.tier) || 'basic';
  }

  function killEnemy(e) {
    if (!e || !e.alive) return;
    const E = PI.Entities;
    const tier = tierOf(e);
    const x = num(e.x, W * 0.5), y = num(e.y, 0);

    // letter explosion: the word's own characters become physical debris
    if (PI.FX && e.word) {
      const LE = T.fx.letterExplosion;
      for (let i = 0; i < e.word.length; i++) {
        if (E && E.letterPos) E.letterPos(e, i, lp);
        else { lp.x = x; lp.y = y; }
        PI.FX.glyph(lp.x, lp.y, e.word.charAt(i), {
          color: i < e.typed ? C.dim : (e.color || C.white),
          vx: LE.vx, vy: LE.vy, life: LE.life, gravity: LE.gravity,
          spin: LE.spin, size: num(e.fontSize, 24) * 0.8,
        });
      }
      const sparkCfg = tier === 'boss' ? T.fx.bossSpark : tier === 'elite' ? T.fx.eliteSpark : T.fx.killSpark;
      PI.FX.spark(x, y, {
        color: e.color || C.white,
        count: sparkCfg.count, speed: sparkCfg.speed, life: sparkCfg.life,
        size: sparkCfg.size, spread: Math.PI * 2,
      });
      const ring = tier === 'boss' ? T.fx.bigRing : T.fx.ring;
      PI.FX.ring(x, y, {
        color: e.color || C.white,
        r0: ring.r0, r1: ring.r1, life: ring.life, width: ring.width,
      });
    }

    if (PI.Core) {
      const traumaKey = tier === 'boss' ? 'killBoss' : tier === 'elite' ? 'killElite' : 'killBasic';
      if (PI.Core.addTrauma) PI.Core.addTrauma(num(J.trauma[traumaKey], 0.35));
      if (tier === 'boss' && PI.Core.hitstop) PI.Core.hitstop(num(TB.wordKill.hitstop, 0.08));
      else if (tier === 'elite' && PI.Core.hitstop) PI.Core.hitstop(num(J.hitstopElite, 0.04));
      if (tier === 'boss' && PI.Core.flash) {
        PI.Core.flash(num(TB.wordKill.flashAlpha, 0.55), num(TB.wordKill.flash, 0.14), C.white);
      }
    }

    if (PI.Score && PI.Score.onKill) PI.Score.onKill(e);
    if (PI.Audio) {
      if (PI.Audio.kill) PI.Audio.kill(PI.Score ? num(PI.Score.combo, 0) : 0);
      if (tier !== 'basic' && PI.Audio.explode) PI.Audio.explode(tier === 'boss' ? 1 : 0.6);
    }

    // command effects
    if (e.kind === 'command') {
      if (PI.Audio && PI.Audio.command) PI.Audio.command();
      if (E && E.applyCommand) E.applyCommand(e.effect, e);
    }

    // boss bookkeeping: Entities owns the recoil/phase, Game owns reward + heal
    if (e.kind === 'bossword') {
      const finished = E && E.bossWordKilled ? E.bossWordKilled(e) : false;
      if (finished) onBossDefeated(E.boss);
    }

    if (E && E.remove) E.remove(e);
    if (PI.Input && PI.Input.target === e && PI.Input.release) PI.Input.release();
  }

  function onBossDefeated(b) {
    const tier = b ? num(b.tier, 1) : 1;
    if (PI.Score && PI.Score.add) PI.Score.add(num(TB.reward, 500) * tier, W * 0.5, H * 0.35);
    if (PI.Audio && PI.Audio.bossDie) PI.Audio.bossDie();
    if (PI.Core) {
      if (PI.Core.flash) PI.Core.flash(num(TB.death.flashAlpha, 1), 0.05, C.white);
      if (PI.Core.addTrauma) PI.Core.addTrauma(num(J.trauma.bossDeath, 1));
      if (PI.Core.setTimeScale) PI.Core.setTimeScale(num(TB.death.slowmo, 0.28), num(TB.death.slowmoTime, 1.4));
    }
    if (PI.FX) {
      // a shockwave that visibly bends the background
      PI.FX.ring(W * 0.5, num(b && b.y, H * 0.2), {
        color: C.white, r0: num(TB.death.ringR0, 30), r1: num(TB.death.ringR1, 1500),
        life: num(TB.death.ringLife, 1.1), width: num(TB.death.ringWidth, 26),
        displace: true, strength: num(TB.death.displaceStrength, 46),
      });
      // slow-mo letter rain of the whole phrase
      const phrase = (b && b.phrase) || '';
      for (let i = 0; i < phrase.length; i++) {
        if (phrase.charAt(i) === ' ') continue;
        PI.FX.glyph(U.rand(60, W - 60), U.rand(-120, H * 0.25), phrase.charAt(i), {
          color: U.pick([C.white, C.green, C.cyan]),
          vx: [-70, 70], vy: [-40, 40],
          life: num(TB.death.letterRainLife, 1.8),
          gravity: num(TB.death.letterRainGravity, 240),
          spin: 4, size: 22,
        });
      }
    }
    // +15% integrity, animated as text being retyped into the context bar
    healQueue += num(TB.healOnKill, 15);
    bossDeathT = num(TB.death.refillTime, 1.2);
  }

  function typo(e) {
    if (PI.Score && PI.Score.breakCombo) PI.Score.breakCombo();
    if (e) e.shakeT = num(J.typoShakeTime, 0.22);
    if (PI.Core && PI.Core.addTrauma) PI.Core.addTrauma(num(J.trauma.typo, 0.13));
    if (PI.Audio && PI.Audio.typo) PI.Audio.typo();
  }

  function leak(e) {
    if (!e) return;
    const dmg = num(e.damage, 0);
    if (dmg > 0) {
      API.integrity = Math.max(0, API.integrity - dmg);
      if (PI.Render && PI.Render.glitchContext) PI.Render.glitchContext(num(e.x, W * 0.5));
      if (PI.Core) {
        if (PI.Core.addTrauma) PI.Core.addTrauma(num(J.trauma.leak, 0.56));
        if (PI.Core.flash) PI.Core.flash(num(J.flash.leakAlpha, 0.22), num(J.flash.time, 0.16), C.red);
      }
      if (PI.Audio && PI.Audio.leak) PI.Audio.leak();
      if (PI.Score && PI.Score.breakCombo) PI.Score.breakCombo();
      if (PI.FX) {
        PI.FX.spark(num(e.x, W * 0.5), num(TP.leakLine, 652), {
          color: C.corrupt, count: [14, 20], speed: [80, 260], life: [0.3, 0.7], size: 2.6,
        });
      }
    }
    if (API.integrity <= 0) gameOver();
  }

  function heal(amount) {
    API.integrity = Math.min(num(TP.healCap, 100), API.integrity + num(amount, 0));
  }

  // ----------------------------------------------------------------- update
  function update(dt) {
    const d = num(dt, 0);
    const s = PI.Core ? PI.Core.state : 'TITLE';

    if (deathLock > 0) deathLock = Math.max(0, deathLock - d);

    if (PI.Render && PI.Render.update) PI.Render.update(d);

    if (s === 'PLAYING' || s === 'TITLE') {
      if (PI.Entities && PI.Entities.update) PI.Entities.update(d);
    }
    if (PI.FX && PI.FX.update) PI.FX.update(d);
    if (PI.Score && PI.Score.update) PI.Score.update(d);

    // the boss reward trickles in so the context bar visibly refills
    if (healQueue > 0) {
      const rate = healQueue / Math.max(0.05, bossDeathT > 0 ? bossDeathT : 0.4);
      const step = Math.min(healQueue, rate * d);
      heal(step);
      healQueue -= step;
      if (bossDeathT > 0) bossDeathT = Math.max(0, bossDeathT - d);
    }

    // ghost bar lags the real value by ~200ms (§11.5)
    API.integrityGhost = U.damp(API.integrityGhost, API.integrity,
      1 / Math.max(0.02, num(J.ghostLag, 0.2)), d);
    if (Math.abs(API.integrityGhost - API.integrity) < 0.15) API.integrityGhost = API.integrity;

    if (s === 'PLAYING') API.runTime += d;

    // music intensity tracks the multiplier; flow pins it high
    if (PI.Audio && PI.Audio.setIntensity && PI.Score) {
      const m = typeof PI.Score.multiplier === 'function' ? PI.Score.multiplier() : 1;
      let intensity = U.clamp((m - 1) / Math.max(1, num(T.combo.cap, 8) - 1), 0, 1);
      if (PI.Score.flow) intensity = Math.max(0.9, intensity);
      PI.Audio.setIntensity(intensity);
    }
  }

  // ------------------------------------------------------------------- draw
  function draw() {
    const ctx = PI.Core && PI.Core.ctx;
    if (!ctx) return;
    const dt = PI.Core ? num(PI.Core.dt, 0) : 0;
    const R = PI.Render;
    if (!R) return;
    R.background(ctx, dt);
    R.enemies(ctx);
    R.turret(ctx);
    if (PI.FX && PI.FX.draw) PI.FX.draw(ctx);
    R.contextBar(ctx);
    R.hud(ctx);
    R.banners(ctx);
    R.screens(ctx);
    // overlay() is drawn by Core outside the shake transform
  }

  function onState(prev, next) {
    if (next === 'GAME_OVER' || next === 'TITLE') {
      if (PI.Audio && PI.Audio.music) PI.Audio.music(false);
    }
    if (next === 'PLAYING' && prev === 'PAUSED') {
      if (PI.Audio && PI.Audio.music) PI.Audio.music(true);
    }
  }

  API.boot = boot;
  API.newRun = newRun;
  API.gameOver = gameOver;
  API.titleKey = titleKey;
  API.hit = hit;
  API.killEnemy = killEnemy;
  API.typo = typo;
  API.leak = leak;
  API.heal = heal;
  API.update = update;
  API.draw = draw;
  API.onState = onState;
  return API;
})();
