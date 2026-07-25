// PI.Render — every pixel except the particle layer (DESIGN.md §11, §11.5, §13).
//
// Draw calls run inside Core's logical 1280x720 transform, with the camera punch and
// trauma shake already applied — except overlay(), which Core draws outside the shake
// so the CRT and vignette stay nailed to the screen.
//
// Performance rules from §14: static layers (scanlines, vignette) are pre-rendered to
// offscreen canvases once and blitted; the code-rain grid is generated once and only
// its offsets advance; the font string is cached to avoid re-parsing every draw; and
// nothing here uses shadowBlur or ctx.filter.

PI.Render = (function () {
  const U = PI.U, C = PI.C, T = PI.TUNING, FONT = PI.FONT;
  const W = T.view.W, H = T.view.H;
  const HUD = T.hud, J = T.juice, CB = T.hud.contextBar, TP = T.player;
  const TAU = Math.PI * 2;

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function state() { return PI.Core ? PI.Core.state : 'TITLE'; }
  function integrity() { return PI.Game ? num(PI.Game.integrity, 100) : 100; }
  function clockT() { return PI.Core ? num(PI.Core.time, 0) : 0; }

  // ------------------------------------------------------------------ fonts
  // Assigning ctx.font re-parses the shorthand, so only do it on change. The cache
  // is invalidated once per frame because other modules (enemy measuring) touch it.
  let fontCache = '';
  function font(ctx, size, weight) {
    const f = (weight ? weight + ' ' : '') + Math.round(size) + 'px ' + FONT;
    if (f !== fontCache) { ctx.font = f; fontCache = f; }
  }
  function invalidateFont() { fontCache = ''; }

  // ------------------------------------------------------- offscreen layers
  let scanLayer = null, vignetteLayer = null, lowLayer = null;

  function makeLayer(w, h) {
    try {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w));
      c.height = Math.max(1, Math.round(h));
      return c;
    } catch (_) { return null; }
  }

  function ensureLayers() {
    if (scanLayer === null) {
      // One tile of scanlines, repeated by a pattern fill — cheaper than a gradient
      // stroke per row and pixel-exact at logical scale.
      const step = Math.max(2, num(J.scanlineSize, 2));
      const c = makeLayer(4, step);
      if (c) {
        const g = c.getContext('2d');
        g.clearRect(0, 0, 4, step);
        g.fillStyle = 'rgba(0,0,0,' + num(J.scanlineAlpha, 0.075) + ')';
        g.fillRect(0, 0, 4, Math.max(1, step / 2));
      }
      scanLayer = c || false;
    }
    if (vignetteLayer === null) {
      const c = makeLayer(W, H);
      if (c) {
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(W * 0.5, H * 0.5, H * 0.28, W * 0.5, H * 0.5, H * 0.82);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(1, 'rgba(0,0,0,' + num(J.vignette, 0.5) + ')');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
      vignetteLayer = c || false;
    }
    if (lowLayer === null) {
      // Red heartbeat vignette for the sub-30% integrity state.
      const c = makeLayer(W, H);
      if (c) {
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(W * 0.5, H * 0.55, H * 0.2, W * 0.5, H * 0.55, H * 0.85);
        grad.addColorStop(0, 'rgba(255,45,63,0)');
        grad.addColorStop(1, 'rgba(255,45,63,0.55)');
        g.fillStyle = grad;
        g.fillRect(0, 0, W, H);
      }
      lowLayer = c || false;
    }
  }

  // -------------------------------------------------------------- code rain
  // Two parallax layers of drifting glyphs. Reactive to the score multiplier per
  // §11.5: the whole field speeds up and shifts toward cyan as the player heats up.
  const TR = T.fx.rain;
  const rain = { far: [], near: [], ready: false };

  function makeColumns(count, size, speed) {
    const cols = [];
    const gap = num(TR.columnGap, 30);
    for (let i = 0; i < count; i++) {
      const glyphs = [];
      const n = Math.ceil(H / size) + 2;
      for (let k = 0; k < n; k++) glyphs.push(U.pick(U.GLYPHS_ASCII || U.GLYPHS));
      cols.push({
        x: (i * gap + U.rand(0, gap)) % W,
        y: U.rand(-H, 0),
        speed: speed * U.rand(0.7, 1.35),
        size: size,
        glyphs: glyphs,
        rollT: U.rand(0, 1),
      });
    }
    return cols;
  }

  function initRain() {
    rain.far = makeColumns(num(TR.farCount, 60), num(TR.farSize, 13), num(TR.farSpeed, 26));
    rain.near = makeColumns(num(TR.nearCount, 40), num(TR.nearSize, 17), num(TR.nearSpeed, 62));
    rain.ready = true;
  }

  function heat() {
    // 0..1 excitement level from the combo multiplier, pinned high in flow state.
    const S = PI.Score;
    if (!S) return 0;
    const m = typeof S.multiplier === 'function' ? S.multiplier() : 1;
    const base = U.clamp((m - 1) / Math.max(1, num(T.combo.cap, 8) - 1), 0, 1);
    return S.flow ? Math.max(0.85, base) : base;
  }

  function advanceRain(dt) {
    if (!rain.ready) initRain();
    const h = heat();
    const boost = 1 + num(TR.comboSpeedGain, 0.9) * h;
    for (let layer = 0; layer < 2; layer++) {
      const cols = layer === 0 ? rain.far : rain.near;
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i];
        col.y += col.speed * boost * dt;
        if (col.y > H + col.size) col.y -= H + col.size * 2;
        // Re-roll one glyph occasionally rather than every frame.
        col.rollT -= dt;
        if (col.rollT <= 0) {
          col.rollT = U.rand(0.08, 0.4);
          col.glyphs[U.randInt(0, col.glyphs.length - 1)] = U.pick(U.GLYPHS_ASCII || U.GLYPHS);
        }
      }
    }
  }

  function displaceAt(x, y, out) {
    // Boss-death shockwaves bend the background: push glyphs radially away from
    // each live displacement, strongest right at the ring's edge.
    out.x = x; out.y = y;
    const D = PI.FX && PI.FX.displacements;
    if (!D || !D.length) return out;
    for (let i = 0; i < D.length; i++) {
      const d = D[i];
      const dx = x - d.x, dy = y - d.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const band = Math.abs(dist - d.r);
      if (band > 140) continue;
      const amt = (1 - band / 140) * d.strength;
      out.x += (dx / dist) * amt;
      out.y += (dy / dist) * amt;
    }
    return out;
  }

  const dispOut = { x: 0, y: 0 };

  function drawRainLayer(ctx, cols, alpha, colorFar) {
    const h = heat();
    // Hue shift: green -> cyan as the run heats up (§11.5 reactive background).
    const shift = num(TR.comboHueShift, 0.85) * h;
    ctx.fillStyle = shift > 0.02
      ? U.hexA(C.cyan, alpha * (0.6 + 0.4 * shift))
      : U.hexA(colorFar, alpha);
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      font(ctx, col.size);
      for (let k = 0; k < col.glyphs.length; k++) {
        const gy = col.y + k * col.size;
        if (gy < -col.size || gy > H + col.size) continue;
        const p = displaceAt(col.x, gy, dispOut);
        ctx.fillText(col.glyphs[k], p.x, p.y);
      }
    }
  }

  function background(ctx, dt) {
    invalidateFont();
    ensureLayers();
    advanceRain(num(dt, 0));

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    drawRainLayer(ctx, rain.far, num(TR.farAlpha, 0.16), C.rainFar);
    drawRainLayer(ctx, rain.near, num(TR.nearAlpha, 0.3), C.rain);

    // Freeze tint while temp=0 is active.
    const E = PI.Entities;
    if (E && E.frozen) {
      ctx.fillStyle = U.hexA(T.commands.freeze.tint || C.cyan, num(T.commands.freeze.tintAlpha, 0.12));
      ctx.fillRect(0, 0, W, H);
    }
    // Flow-state wash.
    if (PI.Score && PI.Score.flow) {
      ctx.fillStyle = U.hexA(T.flow.tint || C.cyan, num(T.flow.tintAlpha, 0.075));
      ctx.fillRect(0, 0, W, H);
    }
    if (vignetteLayer) ctx.drawImage(vignetteLayer, 0, 0);
  }

  // --------------------------------------------------------------- enemies
  const EC = T.enemy.common;

  function typedColor(e) {
    return C.dim;
  }

  function capsule(ctx, x, y, w, h, r) {
    const rr = Math.min(r, h * 0.5, w * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  // Faked bloom: two layered radial gradients. shadowBlur is banned in the draw path.
  function glow(ctx, x, y, radius, color, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, U.hexA(color, alpha));
    g.addColorStop(0.55, U.hexA(color, alpha * 0.35));
    g.addColorStop(1, U.hexA(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  function drawEnemy(ctx, e) {
    if (!e || !e.alive) return;
    const E = PI.Entities;
    if (E && E.measureEnemy) E.measureEnemy(e, ctx);

    const sp = U.clamp(num(e.spawnT, 1), 0, 1);
    // Materialize with a slight overshoot, then settle (§11.5).
    const inScale = sp >= 1 ? 1 : U.easeOutBack(sp);
    const dieP = e.dying ? U.clamp(num(e.dieT, 0) / Math.max(0.01, num(EC.dyingTime, 0.18)), 0, 1) : 0;
    const scale = num(e.scale, 1) * inScale * (1 + dieP * 0.35);
    let alpha = num(e.alpha, 1) * (sp >= 1 ? 1 : sp) * (1 - dieP);

    if (e.type === 'halluc') {
      const flick = 1 - num(T.enemy.halluc.flickerDepth, 0.18) *
        (0.5 + 0.5 * Math.sin(clockT() * TAU * num(T.enemy.halluc.flickerHz, 9) + e.wobblePhase));
      alpha *= num(T.enemy.halluc.opacity, 0.55) * flick;
    }
    if (alpha <= 0.01) return;

    const size = num(e.fontSize, EC.fontSize) * scale;
    const cw = num(e.charW, size * 0.6) * scale;
    const n = e.word.length;
    const textW = cw * n;
    const isTarget = PI.Input && PI.Input.target === e;
    const color = e.color || C.white;

    // Typo shake, set by Game.typo(e).
    let shx = 0;
    if (num(e.shakeT, 0) > 0) {
      const k = e.shakeT / Math.max(0.01, num(J.typoShakeTime, 0.22));
      shx = Math.sin(e.shakeT * 90) * num(J.typoShake, 6) * k;
    }

    const cx = num(e.x, W * 0.5) + shx + num(e.offsetX, 0);
    const cy = num(e.y, 0);

    ctx.globalAlpha = 1;

    // capsule + glow
    const padX = num(EC.capsulePadX, 11) * scale;
    const padY = num(EC.capsulePadY, 7) * scale;
    const boxW = textW + padX * 2;
    const boxH = size + padY * 2;
    const bx = cx - boxW * 0.5;
    const by = cy - boxH * 0.5;

    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, cx, cy, Math.max(boxW, boxH) * (isTarget ? 0.95 : 0.72),
      color, num(EC.glowAlpha, 0.3) * alpha * (isTarget ? 1.5 : 1));
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = U.hexA(C.ink, 0.55 * alpha);
    capsule(ctx, bx, by, boxW, boxH, num(EC.capsuleRadius, 6) * scale);
    ctx.fill();
    ctx.strokeStyle = U.hexA(color, 0.5 * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();

    // jailbreak dash streak
    if (e.dashing && e.dashProg > 0) {
      ctx.strokeStyle = U.hexA(C.red, 0.5 * alpha * (1 - e.dashProg));
      ctx.lineWidth = num(T.enemy.jail.streakWidth, 3) * scale;
      ctx.beginPath();
      ctx.moveTo(cx - num(e.dashDX, 0) * 26, cy - num(e.dashDY, 0) * 26);
      ctx.lineTo(cx, cy);
      ctx.stroke();
    }

    // letters: consumed dim, remaining bright, struck letter pops
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const jit = e.jitter ? num(T.enemy.halluc.jitter, 1) : 0;
    const popIdx = num(e.popIndex, -1);
    const popT = num(e.popT, 99);
    const popDur = num(EC.letterPop, 0.05);

    for (let i = 0; i < n; i++) {
      const lx = cx - textW * 0.5 + cw * (i + 0.5) + (jit ? U.rand(-jit, jit) : 0);
      const ly = cy + (jit ? U.rand(-jit, jit) : 0);
      const consumed = i < e.typed;
      let ls = size;
      if (i === popIdx && popT < popDur) {
        const k = popT / popDur;
        // 1.0 -> 1.4 -> 1.0 over the pop window
        ls = size * (1 + (num(EC.letterPopScale, 1.4) - 1) * Math.sin(k * Math.PI));
      }
      font(ctx, ls, consumed ? '' : 'bold');
      ctx.fillStyle = consumed ? U.hexA(typedColor(e), alpha * 0.85) : U.hexA(color, alpha);
      ctx.fillText(e.word.charAt(i), lx, ly);
    }

    // lock brackets + targeting line
    if (isTarget) {
      const bp = num(EC.bracketPad, 8) * scale;
      const pulse = 0.7 + 0.3 * Math.sin(clockT() * 9);
      ctx.strokeStyle = U.hexA(C.green, 0.9 * pulse);
      ctx.lineWidth = 2;
      const x0 = bx - bp, x1 = bx + boxW + bp;
      const yTop = by - bp * 0.4, yBot = by + boxH + bp * 0.4;
      const armY = (yBot - yTop) * 0.3;
      const armX = 9;
      ctx.beginPath();
      ctx.moveTo(x0 + armX, yTop); ctx.lineTo(x0, yTop); ctx.lineTo(x0, yTop + armY);
      ctx.moveTo(x0, yBot - armY); ctx.lineTo(x0, yBot); ctx.lineTo(x0 + armX, yBot);
      ctx.moveTo(x1 - armX, yTop); ctx.lineTo(x1, yTop); ctx.lineTo(x1, yTop + armY);
      ctx.moveTo(x1, yBot - armY); ctx.lineTo(x1, yBot); ctx.lineTo(x1 - armX, yBot);
      ctx.stroke();

      ctx.strokeStyle = U.hexA(C.green, 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(num(TP.turretX, 640), num(TP.turretY, 634));
      ctx.lineTo(cx, cy + boxH * 0.5);
      ctx.stroke();
    }
  }

  function drawBoss(ctx, b) {
    if (!b || !b.alive) return;
    // Alert sweep during the intro (§11.5): a red band crossing the screen.
    const E = PI.Entities;
    if (E && E.phase === 'bossintro') {
      const p = U.clamp(num(b.introT, 0) / Math.max(0.05, num(b.introDur, 1.2)), 0, 1);
      const sweepY = -80 + (H + 160) * U.easeOutCubic(p);
      const g = ctx.createLinearGradient(0, sweepY - 70, 0, sweepY + 70);
      g.addColorStop(0, U.hexA(C.red, 0));
      g.addColorStop(0.5, U.hexA(C.red, num(T.boss.intro.sweep, 0.85) * 0.4 * (1 - p * 0.5)));
      g.addColorStop(1, U.hexA(C.red, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, sweepY - 70, W, 140);
    }
    // The phrase's words are ordinary enemy records, so they draw through the same path.
    for (let i = 0; i < b.words.length; i++) {
      const wd = b.words[i];
      if (!wd || !wd.alive) continue;
      const isNext = (PI.Entities && PI.Entities.targetableBossWord && PI.Entities.targetableBossWord() === wd);
      if (!isNext && !wd.dying) wd.alpha = 0.62;
      else wd.alpha = 1;
      drawEnemy(ctx, wd);
    }
  }

  function enemies(ctx) {
    const E = PI.Entities;
    if (!E) return;
    const list = E.list || [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e && e.kind !== 'bossword') drawEnemy(ctx, e);
    }
    if (E.boss) drawBoss(ctx, E.boss);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- turret
  const tur = { rot: { v: 0, vel: 0 }, recoil: 0, muzzle: 0, afterT: 0 };

  function fire() {
    // Called by Game.hit() — recoil + muzzle flash.
    tur.recoil = num(TP.recoilPx, 3);
    tur.muzzle = num(TP.muzzleFlashLife, 0.07);
  }

  function turretAngle() {
    // Recentre when a run is not in progress: a turret frozen mid-aim on the death
    // screen reads as a broken sprite rather than a paused game.
    if (state() !== 'PLAYING' && state() !== 'PAUSED') return 0;
    const t = PI.Input && PI.Input.target;
    if (!t) return 0;
    const dx = num(t.x, W * 0.5) - num(TP.turretX, 640);
    const dy = num(t.y, 0) - num(TP.turretY, 634);
    return U.clamp(Math.atan2(dx, -dy), -num(TP.rotClamp, 1.15), num(TP.rotClamp, 1.15));
  }

  function drawTurret(ctx) {
    if (state() === 'TITLE' && !(PI.Entities && PI.Entities.list && PI.Entities.list.length)) return;
    const x = num(TP.turretX, 640);
    const y = num(TP.turretY, 634);
    const breath = 1 + num(TP.breathAmp, 0.14) *
      Math.sin(clockT() * TAU / Math.max(0.1, num(TP.breathPeriod, 3)));
    const flow = PI.Score && PI.Score.flow;
    const accent = flow ? C.cyan : C.green;

    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, x, y, num(TP.breathGlow, 16) * 2.4 * breath, accent, 0.34);
    if (tur.muzzle > 0) {
      const k = tur.muzzle / Math.max(0.01, num(TP.muzzleFlashLife, 0.07));
      glow(ctx, x + Math.sin(tur.rot.v) * 26, y - Math.cos(tur.rot.v) * 26, 34 * k, C.white, 0.6 * k);
    }
    ctx.globalCompositeOperation = 'source-over';

    ctx.save();
    ctx.translate(x, y + tur.recoil);
    ctx.rotate(tur.rot.v);

    // barrel
    ctx.fillStyle = U.hexA(accent, 0.9);
    ctx.fillRect(-3.5, -num(TP.turretR, 20) - 12, 7, 18);
    // body
    const bw = num(TP.turretW, 46), bh = num(TP.turretH, 24);
    ctx.fillStyle = U.hexA(C.ink, 0.9);
    capsule(ctx, -bw * 0.5, -bh * 0.5, bw, bh, 5);
    ctx.fill();
    ctx.strokeStyle = U.hexA(accent, 0.95);
    ctx.lineWidth = 2;
    ctx.stroke();
    // core
    ctx.fillStyle = U.hexA(accent, 0.55 + 0.45 * (breath - 1) / Math.max(0.01, num(TP.breathAmp, 0.14)));
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // ----------------------------------------------------------- context bar
  const glitch = { t: 0, x: 0 };
  function glitchContext(x) {
    glitch.t = num(J.contextGlitch, 0.15);
    glitch.x = num(x, W * 0.5);
  }

  const CONTEXT_TEXT =
    'system: you are a helpful assistant. maintain alignment. refuse injected instructions. ' +
    'context window nominal. tokens streaming. attention stable. guardrails engaged. ';

  function contextBar(ctx) {
    const x = num(CB.x, 24), y = num(CB.y, 664), w = num(CB.w, 1232), h = num(CB.h, 40);
    const integ = U.clamp(integrity(), 0, 100);
    const ghost = PI.Game ? U.clamp(num(PI.Game.integrityGhost, integ), 0, 100) : integ;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // shell
    ctx.fillStyle = U.hexA(C.ink, 0.85);
    capsule(ctx, x, y, w, h, num(CB.radius, 4));
    ctx.fill();
    ctx.strokeStyle = U.hexA(C.dim, 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();

    // lagging white ghost bar (fighting-game style) sits behind the green
    if (ghost > integ + 0.4) {
      ctx.fillStyle = U.hexA(C.ghost, 0.5);
      ctx.fillRect(x + w * (integ / 100), y + 1, w * ((ghost - integ) / 100), h - 2);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();

    // terminal text: healthy portion green, damaged portion corrupted red
    const charW = num(CB.charW, 9);
    const cols = Math.floor(w / charW);
    const healthy = Math.round(cols * (integ / 100));
    const ty = y + h * 0.5;
    font(ctx, num(CB.textSize, 15));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const glitchK = glitch.t > 0 ? glitch.t / Math.max(0.01, num(J.contextGlitch, 0.15)) : 0;
    const bands = num(J.contextGlitchBands, 7);
    const bandH = h / bands;

    for (let b = 0; b < bands; b++) {
      let off = 0;
      if (glitchK > 0) {
        const near = 1 - U.clamp(Math.abs((x + charW * healthy) - glitch.x) / 400, 0, 1);
        off = (Math.random() - 0.5) * num(J.contextGlitchAmp, 14) * glitchK * (0.35 + near);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y + b * bandH, w, bandH);
      ctx.clip();
      for (let i = 0; i < cols; i++) {
        const corrupt = i >= healthy;
        let ch = CONTEXT_TEXT.charAt(i % CONTEXT_TEXT.length);
        if (corrupt) {
          // corrupted region: scrambled glyphs, re-rolled slowly so it seethes
          const seed = (i * 31 + Math.floor(clockT() * 9) + b) % (U.GLYPHS.length || 1);
          ch = U.GLYPHS.charAt(seed);
        }
        ctx.fillStyle = corrupt
          ? U.hexA(C.corrupt, 0.55 + 0.35 * Math.sin(clockT() * 7 + i))
          : U.hexA(C.green, 0.82);
        // Every band draws the full line at the bar's centre; the clip above reveals
        // only this band's slice, so a per-band x offset reads as a glitch tear.
        ctx.fillText(ch, x + 6 + i * charW + off, ty);
      }
      ctx.restore();
    }

    // blinking block cursor at the end of the healthy region
    const blink = Math.floor(clockT() / Math.max(0.05, num(HUD.cursorBlink, 0.42))) % 2 === 0;
    if (blink && state() !== 'GAME_OVER') {
      ctx.fillStyle = U.hexA(C.green, 0.9);
      ctx.fillRect(x + 6 + healthy * charW, y + h * 0.5 - 8, charW * 0.8, 16);
    }
    ctx.restore();

    // label + percentage
    font(ctx, num(HUD.labelSize, 12));
    ctx.textAlign = 'left';
    ctx.fillStyle = U.hexA(C.dim, 1);
    ctx.fillText(String(HUD.integrityLabel || 'context integrity').toUpperCase(), x, y - 8);
    ctx.textAlign = 'right';
    ctx.fillStyle = U.hexA(integ < num(TP.lowIntegrity, 30) ? C.red : C.green, 1);
    ctx.fillText(Math.round(integ) + '%', x + w, y - 8);
  }

  // ------------------------------------------------------------------- hud
  const mult = { squash: { v: 1, vel: 0 }, tier: 1, ringT: 99 };

  function hud(ctx) {
    const S = PI.Score;
    if (!S) return;
    // The title and death screens carry their own numbers; a live HUD behind them
    // reads as clutter (and would show "WAVE 0" before a run has started).
    const st = state();
    if (st !== 'PLAYING' && st !== 'PAUSED') return;
    const pad = num(HUD.pad, 24), top = num(HUD.topY, 40);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'alphabetic';

    // score (tweened counter)
    const shown = S.display ? num(S.display.value, S.value) : num(S.value, 0);
    font(ctx, num(HUD.scoreSize, 34), 'bold');
    ctx.textAlign = 'left';
    ctx.fillStyle = U.hexA(C.white, 0.96);
    ctx.fillText(U.formatInt(Math.round(shown)), pad, top);
    font(ctx, num(HUD.labelSize, 12));
    ctx.fillStyle = U.hexA(C.dim, 1);
    ctx.fillText('SCORE', pad, top + 16);

    // high score
    ctx.textAlign = 'right';
    font(ctx, num(HUD.labelSize, 12));
    ctx.fillStyle = U.hexA(C.dim, 1);
    ctx.fillText('BEST ' + U.formatInt(num(S.high, 0)), W - pad, top - 18);

    // wave + accuracy
    font(ctx, num(HUD.waveSize, 16), 'bold');
    ctx.fillStyle = U.hexA(C.green, 0.9);
    const wv = PI.Entities ? num(PI.Entities.wave, 1) : 1;
    ctx.fillText('WAVE ' + wv, W - pad, top + 4);
    font(ctx, num(HUD.labelSize, 12));
    ctx.fillStyle = U.hexA(C.dim, 1);
    const acc = PI.Input ? Math.round(PI.Input.accuracy() * 100) : 100;
    ctx.fillText(acc + '% ACC', W - pad, top + 22);
    if (PI.Audio && PI.Audio.muted) {
      ctx.fillStyle = U.hexA(C.warn, 0.8);
      ctx.fillText('MUTED', W - pad, top + 40);
    }

    // combo + multiplier chip, centre-top
    const combo = num(S.combo, 0);
    if (combo > 0) {
      const m = typeof S.multiplier === 'function' ? S.multiplier() : 1;
      const tierColors = T.combo.tierColors || [C.white];
      const col = tierColors[Math.min(tierColors.length - 1, m - 1)] || C.white;
      const cx = W * 0.5;
      const sq = num(mult.squash.v, 1);

      ctx.save();
      ctx.translate(cx, top + 2);
      ctx.scale(sq, 2 - sq); // squash and stretch preserves visual mass
      font(ctx, num(HUD.comboSize, 40), 'bold');
      ctx.textAlign = 'center';
      ctx.fillStyle = U.hexA(col, 0.97);
      ctx.fillText(String(combo), 0, 0);
      ctx.restore();

      font(ctx, num(HUD.labelSize, 12));
      ctx.textAlign = 'center';
      ctx.fillStyle = U.hexA(C.dim, 1);
      ctx.fillText('COMBO', cx, top + 20);

      if (m > 1) {
        font(ctx, num(HUD.multSize, 22), 'bold');
        ctx.fillStyle = U.hexA(col, 0.96);
        ctx.fillText('x' + m, cx + 62, top - 2);
      }
      // tier-change ring pulse
      if (mult.ringT < num(T.combo.tierRingLife, 0.45)) {
        const k = mult.ringT / num(T.combo.tierRingLife, 0.45);
        ctx.strokeStyle = U.hexA(col, 0.7 * (1 - k));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, top - 8, num(T.combo.tierRingR1, 90) * k, 0, TAU);
        ctx.stroke();
      }
      if (S.flow) {
        font(ctx, num(HUD.labelSize, 12), 'bold');
        ctx.fillStyle = U.hexA(C.cyan, 0.75 + 0.25 * Math.sin(clockT() * 8));
        ctx.fillText('FLOW STATE', cx, top - 26);
      }
    }

    // low-integrity heartbeat
    const integ = integrity();
    if (integ > 0 && integ < num(TP.lowIntegrity, 30) && state() === 'PLAYING') {
      const beat = 0.5 + 0.5 * Math.sin(clockT() * TAU / Math.max(0.2, num(J.heartbeatPeriod, 1.05)));
      if (lowLayer) {
        ctx.globalAlpha = num(J.heartbeatAmp, 0.3) * beat;
        ctx.drawImage(lowLayer, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
  }

  // --------------------------------------------------------------- banners
  const banners = [];

  function showBanner(text, opts) {
    const o = opts || {};
    banners.push({
      text: String(text || ''),
      style: o.style || 'normal',
      t: 0,
      inT: num(o.in, num(J.bannerIn, 0.4)),
      hold: num(o.hold, num(J.bannerHold, 1)),
      outT: num(o.out, num(J.bannerOut, 0.32)),
      y: num(o.y, H * 0.42),
      size: num(o.size, o.style === 'alert' ? 40 : 52),
      color: o.color || (o.style === 'alert' ? C.red : C.green),
    });
    if (banners.length > 4) banners.shift();
  }

  function decodeText(ctx, text, x, y, progress, opts) {
    const o = opts || {};
    const shown = U.scramble(text, progress);
    font(ctx, num(o.size, 52), o.weight || 'bold');
    ctx.textAlign = o.align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = U.hexA(o.color || C.green, num(o.alpha, 1));
    ctx.fillText(shown, x, y);
    return shown;
  }

  function drawBanners(ctx) {
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < banners.length; i++) {
      const b = banners[i];
      const total = b.inT + b.hold + b.outT;
      if (b.t >= total) continue;
      let progress = 1, alpha = 1, dx = 0;
      if (b.t < b.inT) {
        progress = b.t / Math.max(0.01, b.inT);
        alpha = U.easeOutCubic(progress);
      } else if (b.t > b.inT + b.hold) {
        const k = (b.t - b.inT - b.hold) / Math.max(0.01, b.outT);
        alpha = 1 - U.easeInCubic(k);
        dx = U.easeInCubic(k) * 260;
      }

      if (b.style === 'alert') {
        const barA = alpha * 0.22;
        ctx.fillStyle = U.hexA(C.red, barA);
        ctx.fillRect(0, b.y - 44, W, 88);
      }

      // motion-blur ghosts on the way out (§11.5)
      if (dx > 1) {
        const ghosts = num(J.bannerGhosts, 3);
        for (let g = ghosts; g >= 1; g--) {
          decodeText(ctx, b.text, W * 0.5 + dx - g * 26, b.y, 1, {
            size: b.size, color: b.color, alpha: alpha * (0.16 / g),
          });
        }
      }
      decodeText(ctx, b.text, W * 0.5 + dx, b.y, progress, {
        size: b.size, color: b.color, alpha: alpha,
      });
    }
  }

  // --------------------------------------------------------------- screens
  const TITLE_TEXT = 'PROMPT INJECTION';
  const title = { letters: [], t: 0, ready: false };
  const API = {};

  function initTitle() {
    title.letters = [];
    const size = 76;
    const cw = size * 0.62;
    const totalW = TITLE_TEXT.length * cw;
    for (let i = 0; i < TITLE_TEXT.length; i++) {
      title.letters.push({
        ch: TITLE_TEXT.charAt(i),
        x: W * 0.5 - totalW * 0.5 + cw * (i + 0.5),
        delay: i * num(J.stagger, 0.04),
        landed: false,
        shake: 0,
      });
    }
    title.t = 0;
    title.ready = true;
  }

  function updateTitle(dt) {
    if (!title.ready) initTitle();
    title.t += dt;
    const fall = num(J.titleLetterFall, 0.5);
    let done = 0;
    for (let i = 0; i < title.letters.length; i++) {
      const L = title.letters[i];
      const local = title.t - L.delay;
      if (local >= fall) {
        done++;
        if (!L.landed) {
          L.landed = true;
          L.shake = num(J.titleLandShake, 0.09);
          // a spark burst as each letter slams home
          if (PI.FX) {
            PI.FX.spark(L.x, H * 0.3, {
              color: C.green, count: num(J.titleLandSparks, 5),
              speed: [40, 150], life: [0.2, 0.45], size: 2,
            });
          }
          if (PI.Audio && PI.Audio.uiTick) PI.Audio.uiTick();
        }
      }
      if (L.shake > 0) L.shake = Math.max(0, L.shake - dt);
    }
    API.titleAssembled = title.letters.length ? done / title.letters.length : 1;
  }

  function drawTitle(ctx) {
    const size = 76;
    const baseY = H * 0.3;
    const fall = num(J.titleLetterFall, 0.5);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < title.letters.length; i++) {
      const L = title.letters[i];
      const local = U.clamp((title.t - L.delay) / fall, 0, 1);
      if (local <= 0) continue;
      const ease = U.easeOutBack(local);
      const y = baseY - (1 - ease) * 300;
      const a = U.clamp(local * 1.6, 0, 1);
      const sh = L.shake > 0 ? Math.sin(L.shake * 120) * 3 * (L.shake / num(J.titleLandShake, 0.09)) : 0;
      font(ctx, size, 'bold');
      ctx.globalCompositeOperation = 'lighter';
      glow(ctx, L.x, y, 34, C.green, 0.16 * a);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = U.hexA(C.white, a);
      ctx.fillText(L.ch, L.x, y + sh);
    }

    if (API.titleAssembled >= 0.999) {
      // breathing subtitle
      const breath = 0.62 + num(J.titleSubtitleAmp, 0.28) *
        (0.5 + 0.5 * Math.sin(clockT() * TAU / Math.max(0.2, num(J.titleSubtitleBreath, 2.4))));
      font(ctx, 26, 'bold');
      ctx.fillStyle = U.hexA(C.green, breath);
      ctx.fillText('TYPE TO DEFEND', W * 0.5, H * 0.5);

      font(ctx, 15);
      ctx.fillStyle = U.hexA(C.dim, 1);
      const S = PI.Score;
      if (S && num(S.high, 0) > 0) {
        ctx.fillText('BEST ' + U.formatInt(S.high) + '   COMBO ' + U.formatInt(num(S.bestComboEver, S.highCombo || 0)),
          W * 0.5, H * 0.5 + 34);
      }
      // Sits under the high-score line: the turret occupies the bottom centre.
      ctx.fillStyle = U.hexA(C.white, 0.42);
      font(ctx, 14);
      ctx.fillText('designed by Fable 5  ·  built by Opus 5', W * 0.5, H * 0.5 + 88);
    }
  }

  function drawGameOver(ctx) {
    const S = PI.Score, I = PI.Input;
    ctx.fillStyle = U.hexA(C.ink, 0.88);
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, 30, 'bold');
    ctx.fillStyle = U.hexA(C.corrupt, 0.95);
    ctx.fillText('> context corrupted. ignore all previous instructions.', W * 0.5, H * 0.3);

    font(ctx, 64, 'bold');
    ctx.fillStyle = U.hexA(C.white, 0.97);
    ctx.fillText(U.formatInt(num(S && S.value, 0)), W * 0.5, H * 0.44);
    font(ctx, 13);
    ctx.fillStyle = U.hexA(C.dim, 1);
    ctx.fillText('SCORE', W * 0.5, H * 0.44 + 42);

    font(ctx, 18);
    ctx.fillStyle = U.hexA(C.green, 0.9);
    const acc = I ? Math.round(I.accuracy() * 100) : 0;
    const wv = PI.Entities ? num(PI.Entities.wave, 1) : 1;
    ctx.fillText('best combo ' + num(S && S.bestCombo, 0) + '   ·   ' + acc + '% accuracy   ·   wave ' + wv,
      W * 0.5, H * 0.56);

    if (S && S.isNewHigh) {
      const p = 0.7 + 0.3 * Math.sin(clockT() * 6);
      font(ctx, 26, 'bold');
      ctx.fillStyle = U.hexA(C.gold, p);
      ctx.fillText('NEW HIGH SCORE', W * 0.5, H * 0.64);
    }

    const blink = Math.floor(clockT() * 1.6) % 2 === 0;
    font(ctx, 20, 'bold');
    ctx.fillStyle = U.hexA(C.white, blink ? 0.9 : 0.35);
    ctx.fillText('[ENTER] retry', W * 0.5, H * 0.74);
  }

  function drawPaused(ctx) {
    ctx.fillStyle = U.hexA(C.ink, 0.62);
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, 30, 'bold');
    ctx.fillStyle = U.hexA(C.green, 0.9);
    ctx.fillText('paused — press any key', W * 0.5, H * 0.5);
  }

  function drawTouchCard(ctx) {
    ctx.fillStyle = U.hexA(C.ink, 0.92);
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, 34, 'bold');
    ctx.fillStyle = U.hexA(C.green, 0.95);
    ctx.fillText('this game needs a keyboard', W * 0.5, H * 0.46);
    font(ctx, 22);
    ctx.fillStyle = U.hexA(C.white, 0.8);
    ctx.fillText("that's the point 🎹", W * 0.5, H * 0.54);
  }

  function screens(ctx) {
    if (PI.Core && PI.Core.isTouchOnly) { drawTouchCard(ctx); return; }
    const s = state();
    if (s === 'TITLE') drawTitle(ctx);
    else if (s === 'GAME_OVER') drawGameOver(ctx);
    else if (s === 'PAUSED') drawPaused(ctx);
  }

  // --------------------------------------------------------------- overlay
  let scanPattern = null;

  function overlay(ctx) {
    ensureLayers();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // chromatic aberration, flow state and boss death only — a cached tint layer
    // redrawn at a small offset, never per-pixel work.
    const flow = PI.Score && PI.Score.flow;
    if (flow && vignetteLayer) {
      const off = num(T.flow.chroma, 1.6);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.05;
      ctx.drawImage(vignetteLayer, -off, 0);
      ctx.drawImage(vignetteLayer, off, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    if (scanLayer) {
      if (!scanPattern) {
        try { scanPattern = ctx.createPattern(scanLayer, 'repeat'); } catch (_) { scanPattern = false; }
      }
      if (scanPattern) {
        ctx.fillStyle = scanPattern;
        ctx.fillRect(0, 0, W, H);
      }
    }

    // combo-break desaturation blink
    const S = PI.Score;
    if (S && num(S.breakFlash, 0) > 0) {
      const k = U.clamp(S.breakFlash / num(T.combo.breakDesaturate, 0.22), 0, 1);
      ctx.fillStyle = U.hexA(C.red, 0.1 * k);
      ctx.fillRect(0, 0, W, H);
    }

    if (PI.Core && !PI.Core.hasFocus && !PI.Core.isTouchOnly) {
      const blink = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(clockT() * TAU / Math.max(0.2, num(J.focusHintBlink, 1.1))));
      font(ctx, 16, 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = U.hexA(C.white, blink);
      ctx.fillText('click to focus', W * 0.5, H - 26);
    }
  }

  // ---------------------------------------------------------------- update
  function update(dt) {
    const d = num(dt, 0);
    if (state() === 'TITLE') updateTitle(d);
    else if (!title.ready) initTitle();

    // turret spring toward the locked target, recoil recovery, flow afterimages
    U.spring(tur.rot, turretAngle(), d, num(TP.rotSpring.stiffness, 190), num(TP.rotSpring.damping, 19));
    if (tur.recoil > 0) tur.recoil = Math.max(0, tur.recoil - num(TP.recoilRecover, 14) * d);
    if (tur.muzzle > 0) tur.muzzle = Math.max(0, tur.muzzle - d);

    if (PI.Score && PI.Score.flow && PI.FX) {
      tur.afterT -= d;
      if (tur.afterT <= 0) {
        tur.afterT = num(TP.afterimageInterval, 0.045);
        PI.FX.afterimage(num(TP.turretX, 640), num(TP.turretY, 634), '▲', {
          color: C.cyan, life: num(TP.afterimageLife, 0.22), size: 22, alpha: 0.3,
        });
      }
    }

    // multiplier chip squash + tier ring
    const S = PI.Score;
    if (S) {
      const m = typeof S.multiplier === 'function' ? S.multiplier() : 1;
      if (m !== mult.tier) {
        mult.tier = m;
        mult.squash.v = num(T.combo.squash.to, 1.35);
        mult.squash.vel = 0;
        mult.ringT = 0;
      }
      U.spring(mult.squash, num(T.combo.squash.from, 1), d,
        num(T.combo.squash.stiffness, 320), num(T.combo.squash.damping, 15));
      if (mult.ringT < 90) mult.ringT += d;
    }

    if (glitch.t > 0) glitch.t = Math.max(0, glitch.t - d);

    for (let i = banners.length - 1; i >= 0; i--) {
      banners[i].t += d;
      if (banners[i].t >= banners[i].inT + banners[i].hold + banners[i].outT) banners.splice(i, 1);
    }
  }

  function resetScreens() {
    banners.length = 0;
    title.ready = false;
    glitch.t = 0;
  }

  API.background = background;
  API.enemies = enemies;
  API.turret = drawTurret;
  API.hud = hud;
  API.contextBar = contextBar;
  API.banners = drawBanners;
  API.screens = screens;
  API.overlay = overlay;
  API.update = update;
  API.showBanner = showBanner;
  API.glitchContext = glitchContext;
  API.decodeText = decodeText;
  API.fire = fire;
  API.resetScreens = resetScreens;
  API.titleAssembled = 0;
  return API;
})();
