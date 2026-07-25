// 10-core.js — PI.Core : the engine floor.
// Owns the canvas + DOM, letterbox scaling, the clamped fixed-timestep loop, the
// state machine, camera juice (trauma shake / hitstop / time-scale / punch / flash),
// keyboard plumbing into PI.Input and the window.__PI debug surface.
// DESIGN.md §14 (canvas, loop, states, iframe/focus) + §11/§11.5 (juice).
PI.Core = (function () {

  const T = PI.TUNING, V = T.view, J = T.juice;
  const W = V.W, H = V.H;                       // logical resolution (1280x720)
  const DPR_MAX = V.dprMax || 2;
  const DT_CLAMP = V.dtClamp || 0.05;           // §14: dt clamped to 50ms
  const FPS_SMOOTH = 0.9;                       // exponential fps smoothing
  const PRINTABLE = /^[a-z0-9 '\-=]$/i;         // §4: the only typeable characters
  const MAX_ERRORS = 50;

  const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
    ? window.requestAnimationFrame.bind(window)
    : function (cb) { return setTimeout(function () { cb(PI.U.now() * 1000); }, 16); };

  // ---------------------------------------------------------------- state vars
  let canvas = null, ctx = null;
  let booted = false, attached = false, running = false, listening = false;
  let dpr = 1, dprSeen = 1, scale = 1, offX = 0, offY = 0, cssW = W, cssH = H;
  let needResize = true, rafId = 0, lastT = 0;

  let time = 0, realTime = 0, frame = 0, fps = 60;
  let timeScale = 1, tsFrom = 1, tsHold = 0, tsRampT = 0, tsRampDur = 0;
  let hitstopT = 0;

  let trauma = 0;
  const shake = { x: 0, y: 0 };
  let punchAmt = 0, punchT = 0, punchDur = 0;

  let state = 'TITLE', resumeState = 'PLAYING', pausedByBlur = false;
  let initialStateFired = false;
  let hasFocus = true, swallowNext = false, audioKicked = false;
  let overlayHooked = false, overlayFrame = -1;
  let errHooked = false, debugHooked = false;

  const errors = [];
  // full-screen flash pool (§11.5 boss death / §11 kill flashes) — never allocates in-loop
  const flashes = [];
  for (let i = 0; i < 6; i++) flashes.push({ active: false, a: 0, t: 0, dur: 0, color: '#ffffff' });

  // ---------------------------------------------------------------- diagnostics
  function pushError(msg) {
    if (errors.length >= MAX_ERRORS) return;
    let s;
    try { s = String(msg); } catch (_) { s = 'unstringifiable error'; }
    errors.push(s);
  }

  function installErrorHooks() {
    if (errHooked || typeof window === 'undefined' || !window.addEventListener) return;
    errHooked = true;
    window.addEventListener('error', function (e) {
      const m = (e && (e.message || (e.error && e.error.message))) || 'error';
      pushError(m);
    });
    window.addEventListener('unhandledrejection', function (e) {
      const r = e && e.reason;
      pushError((r && (r.message || r)) || 'unhandledrejection');
    });
  }

  function installDebug() {
    if (debugHooked || typeof window === 'undefined') return;
    debugHooked = true;
    window.__PI = {
      state: function () { return state; },
      fps: function () { return fps; },
      score: function () { return PI.Score ? PI.Score.value : 0; },
      combo: function () { return PI.Score ? PI.Score.combo : 0; },
      flow: function () { return !!(PI.Score && PI.Score.flow); },
      integrity: function () { return PI.Game ? PI.Game.integrity : 0; },
      wave: function () { return PI.Entities ? PI.Entities.wave : 0; },
      boss: function () { return !!(PI.Entities && PI.Entities.boss); },
      enemies: function () {
        const l = (PI.Entities && PI.Entities.list) ? PI.Entities.list : [];
        const out = [];
        for (let i = 0; i < l.length; i++) {
          const e = l[i];
          out.push({ word: e.word, typed: e.typed, x: e.x, y: e.y, type: e.type, kind: e.kind });
        }
        return out;
      },
      target: function () { return (PI.Input && PI.Input.target) ? PI.Input.target.word : null; },
      particles: function () { return PI.FX ? PI.FX.count() : 0; },
      accuracy: function () { return PI.Input ? PI.Input.accuracy() : 1; },
      setWave: function (n) { if (PI.Entities) PI.Entities.startWave(n); },
      spawn: function (t) { return PI.Entities ? PI.Entities.spawn(t) : null; },
      setIntegrity: function (v) { if (PI.Game) PI.Game.integrity = v; },
      setCombo: function (v) { if (PI.Score) PI.Score.combo = v; },
      stress: function (n) { if (PI.FX) PI.FX.stress(n); },
      mute: function () { if (PI.Audio) PI.Audio.toggleMute(); },
      start: function () { if (PI.Game) PI.Game.newRun(); },
      errors: errors
    };
  }

  // ---------------------------------------------------------------- canvas/DOM
  function makeCanvas() {
    let c = null;
    try { c = document.getElementById('game'); } catch (_) { c = null; }
    if (!c || !c.getContext) {
      c = document.createElement('canvas');
      c.id = 'game';
    }
    canvas = c;
    canvas.width = Math.round(W); canvas.height = Math.round(H);
    canvas.setAttribute('tabindex', '0');
    const s = canvas.style;
    s.position = 'fixed'; s.left = '0'; s.top = '0';
    s.width = '100%'; s.height = '100%';
    s.display = 'block'; s.outline = 'none';
    s.background = '#000';
    s.touchAction = 'none';
    s.imageRendering = 'auto';
    try {
      ctx = canvas.getContext('2d', { alpha: false, desynchronized: false });
    } catch (_) { ctx = null; }
    if (!ctx) ctx = canvas.getContext('2d');
  }

  function styleHost() {
    try {
      const de = document.documentElement, b = document.body;
      if (de && de.style) { de.style.margin = '0'; de.style.height = '100%'; de.style.background = PI.C.bg; }
      if (b && b.style) {
        b.style.margin = '0'; b.style.padding = '0'; b.style.height = '100%';
        b.style.overflow = 'hidden'; b.style.background = PI.C.bg;
      }
    } catch (_) { /* hostile host page — the canvas still works */ }
  }

  function attach() {
    if (attached || !canvas) return;
    if (canvas.parentNode) { attached = true; return; }
    if (document.body) { document.body.appendChild(canvas); attached = true; needResize = true; return; }
    document.addEventListener('DOMContentLoaded', function once() {
      document.removeEventListener('DOMContentLoaded', once);
      if (!attached && document.body) {
        document.body.appendChild(canvas);
        attached = true; styleHost(); needResize = true;
      }
    });
  }

  // Letterbox: scale = min(cw/1280, ch/720), centred, black bars around it.
  function resize() {
    if (!canvas || !ctx) return;
    let cw = 0, ch = 0;
    try {
      const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
      if (r && r.width > 8 && r.height > 8) { cw = r.width; ch = r.height; }
    } catch (_) { /* ignore */ }
    if (!(cw > 8) || !(ch > 8)) {
      cw = (typeof window !== 'undefined' && window.innerWidth) || W;
      ch = (typeof window !== 'undefined' && window.innerHeight) || H;
    }
    dprSeen = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    dpr = PI.U.clamp(dprSeen, 1, DPR_MAX);
    cssW = cw; cssH = ch;
    const bw = Math.max(1, Math.round(cw * dpr));
    const bh = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    scale = Math.min(cw / W, ch / H);
    offX = (cw - W * scale) * 0.5;
    offY = (ch - H * scale) * 0.5;
    api.scale = scale; api.dpr = dpr; api.cssW = cssW; api.cssH = cssH;
    api.offX = offX; api.offY = offY;
  }

  // ---------------------------------------------------------------- time-scale
  function setTimeScale(v, seconds) {
    const val = (typeof v === 'number' && isFinite(v)) ? PI.U.clamp(v, 0, 4) : 1;
    timeScale = val;
    tsFrom = val;
    tsHold = (typeof seconds === 'number' && seconds > 0) ? seconds : 0;
    tsRampT = 0;
    tsRampDur = (val === 1) ? 0 : (J.slowmoRamp || 0.35);
    if (val === 1) tsHold = 0;
    api.timeScale = timeScale;
  }

  // Holds the requested scale for `seconds`, then eases back to 1 (easeOutCubic).
  function updateTimeScale(raw) {
    if (timeScale === 1 && tsHold <= 0 && tsRampDur <= 0) return;
    let step = raw;
    if (tsHold > 0) {
      tsHold -= step;
      if (tsHold > 0) return;
      step = -tsHold;            // carry the remainder into the ramp
      tsHold = 0;
    }
    if (tsRampDur > 0) {
      tsRampT += step;
      const p = PI.U.clamp(tsRampT / tsRampDur, 0, 1);
      timeScale = tsFrom + (1 - tsFrom) * PI.U.easeOutCubic(p);
      if (p >= 1) { timeScale = 1; tsFrom = 1; tsRampDur = 0; tsRampT = 0; }
    } else {
      timeScale = 1;
    }
  }

  function hitstop(seconds) {
    const s = (typeof seconds === 'number' && seconds > 0)
      ? Math.min(seconds, 0.4)
      : (J.hitstop || 0.08);
    if (s > hitstopT) hitstopT = s;
  }

  // ---------------------------------------------------------------- camera
  function addTrauma(amount) {
    if (typeof amount !== 'number' || !isFinite(amount)) return trauma;
    trauma = PI.U.clamp(trauma + amount, 0, 1);
    api.trauma = trauma;
    return trauma;
  }

  function punch(zoomAmount, seconds) {
    const z = (typeof zoomAmount === 'number' && isFinite(zoomAmount))
      ? PI.U.clamp(zoomAmount, -0.4, 0.6)
      : (J.punch || 0.08);
    const d = (typeof seconds === 'number' && seconds > 0) ? seconds : (J.punchTime || 0.26);
    // a stronger punch always wins; a weaker one never truncates the live one
    if (Math.abs(z) >= Math.abs(punchZoom())) { punchAmt = z; punchDur = d; punchT = 0; }
  }

  function punchZoom() {
    if (punchDur <= 0 || punchAmt === 0) return 0;
    const p = PI.U.clamp(punchT / punchDur, 0, 1);
    return punchAmt * (1 - PI.U.easeOutCubic(p));
  }

  function flash(alpha, seconds, color) {
    const a = (typeof alpha === 'number' && isFinite(alpha)) ? PI.U.clamp(alpha, 0, 1) : 0.2;
    if (a <= 0) return;
    const dur = (typeof seconds === 'number' && seconds > 0)
      ? seconds
      : ((J.flash && J.flash.time) || 0.16);
    let slot = null;
    for (let i = 0; i < flashes.length; i++) { if (!flashes[i].active) { slot = flashes[i]; break; } }
    if (!slot) {                                   // recycle the most-finished flash
      let best = 0;
      for (let i = 1; i < flashes.length; i++) {
        if ((flashes[i].t / flashes[i].dur) > (flashes[best].t / flashes[best].dur)) best = i;
      }
      slot = flashes[best];
    }
    slot.active = true; slot.a = a; slot.t = 0; slot.dur = dur;
    slot.color = (typeof color === 'string' && color) ? color : PI.C.white;
  }

  // camDt is 0 during hitstop, so an impact freezes the camera state (and keeps
  // the shake vibrating at full amplitude) for the duration of the stop.
  function updateCamera(camDt) {
    if (trauma > 0 && camDt > 0) trauma = Math.max(0, trauma - (J.traumaDecay || 1.8) * camDt);
    const amp = trauma * trauma * (J.shakeMax || 24);   // §11: offset = trauma^2 * max
    if (amp > 0.01) {
      const ang = Math.random() * 6.2831853;
      const mag = amp * (0.62 + Math.random() * 0.38);
      shake.x = Math.cos(ang) * mag;
      shake.y = Math.sin(ang) * mag * 0.85;
    } else if (shake.x !== 0 || shake.y !== 0) {
      shake.x = 0; shake.y = 0;
    }
    if (punchDur > 0) {
      punchT += camDt;
      if (punchT >= punchDur) { punchT = 0; punchDur = 0; punchAmt = 0; }
    }
    for (let i = 0; i < flashes.length; i++) {
      const f = flashes[i];
      if (!f.active) continue;
      f.t += camDt;
      if (f.t >= f.dur) f.active = false;
    }
    api.trauma = trauma;
  }

  // ---------------------------------------------------------------- states
  function setState(s) {
    if (typeof s !== 'string' || s === state) return state;
    const prev = state;
    state = s;
    api.state = s;
    initialStateFired = true;
    if (s !== 'PAUSED') { pausedByBlur = false; api.pausedByBlur = false; swallowNext = false; }
    if (PI.Game && typeof PI.Game.onState === 'function') PI.Game.onState(prev, s);
    return state;
  }

  function autoPause() {
    if (state !== 'PLAYING') return;
    resumeState = 'PLAYING';
    pausedByBlur = true;
    api.pausedByBlur = true;
    swallowNext = true;               // §14: the resuming keystroke is swallowed
    state = 'PAUSED';
    api.state = state;
    if (PI.Game && typeof PI.Game.onState === 'function') PI.Game.onState('PLAYING', 'PAUSED');
  }

  function resumeFromBlur() {
    if (state !== 'PAUSED' || !pausedByBlur) return false;
    pausedByBlur = false;
    api.pausedByBlur = false;
    setState(resumeState || 'PLAYING');
    return true;
  }

  // ---------------------------------------------------------------- input
  function kickAudio() {
    if (audioKicked) return;
    audioKicked = true;
    // §13: one shared AudioContext, created inside a user gesture. Audio.init()
    // is contracted to be idempotent, so Input may also call it harmlessly.
    try { if (PI.Audio && typeof PI.Audio.init === 'function') PI.Audio.init(); } catch (_) { }
  }

  function onKeyDown(e) {
    if (!e) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;      // leave browser shortcuts alone
    let k = e.key;
    if (typeof k !== 'string') return;
    if (k === 'Spacebar') k = ' ';                        // legacy key name
    if (k === 'Esc') k = 'Escape';

    hasFocus = true; api.hasFocus = true;
    kickAudio();

    const printable = (k.length === 1 && PRINTABLE.test(k));
    const isEnter = (k === 'Enter');
    const isEsc = (k === 'Escape');
    if (printable || isEnter || isEsc) {
      // stop space/enter from scrolling or activating the host page
      if (typeof e.preventDefault === 'function') e.preventDefault();
    } else {
      return;
    }
    if (e.repeat) return;                                 // auto-repeat is not a keystroke

    if (swallowNext) { swallowNext = false; resumeFromBlur(); return; }
    if (state === 'PAUSED' && pausedByBlur) { resumeFromBlur(); return; }

    const In = PI.Input;
    if (!In) return;
    if (printable) { if (typeof In.key === 'function') In.key(k.toLowerCase()); return; }
    if (isEnter) { if (typeof In.enter === 'function') In.enter(); return; }
    if (typeof In.escape === 'function') In.escape();
  }

  function focusSelf() {
    try {
      if (canvas && canvas.focus) canvas.focus({ preventScroll: true });
    } catch (_) {
      try { canvas.focus(); } catch (_2) { /* ignore */ }
    }
    try { if (typeof window !== 'undefined' && window.focus) window.focus(); } catch (_) { }
    hasFocus = true; api.hasFocus = true;
  }

  function onPointerDown() { focusSelf(); kickAudio(); }
  function onFocus() { hasFocus = true; api.hasFocus = true; }
  function onBlur() { hasFocus = false; api.hasFocus = false; autoPause(); }
  function onVisibility() {
    let hidden = false;
    try { hidden = !!document.hidden; } catch (_) { hidden = false; }
    if (hidden) { hasFocus = false; api.hasFocus = false; autoPause(); }
  }
  function onResize() { needResize = true; }

  function detectTouchOnly() {
    try {
      const nav = (typeof navigator !== 'undefined') ? navigator : null;
      const pts = (nav && typeof nav.maxTouchPoints === 'number') ? nav.maxTouchPoints : 0;
      let fine = false;
      if (typeof window !== 'undefined' && window.matchMedia) {
        const mm = window.matchMedia('(pointer:fine)');
        fine = !!(mm && mm.matches);
      }
      return pts > 0 && !fine;
    } catch (_) { return false; }
  }

  function installListeners() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('keydown', onKeyDown, false);
    window.addEventListener('resize', onResize, false);
    window.addEventListener('orientationchange', onResize, false);
    window.addEventListener('focus', onFocus, false);
    window.addEventListener('blur', onBlur, false);
    window.addEventListener('pointerdown', onPointerDown, true);
    try { window.addEventListener('touchstart', onPointerDown, { passive: true }); } catch (_) { }
    try { document.addEventListener('visibilitychange', onVisibility, false); } catch (_) { }
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(onResize).observe(canvas); } catch (_) { }
    }
  }

  // ---------------------------------------------------------------- draw
  // PI.Game.draw()'s documented order ends with PI.Render.overlay, and Core is
  // also contracted to draw the CRT hook. Wrapping overlay once makes it run
  // exactly once per frame whichever side calls it (no doubled scanlines).
  function hookOverlay() {
    if (overlayHooked) return;
    const R = PI.Render;
    if (!R || typeof R.overlay !== 'function') return;
    overlayHooked = true;
    const orig = R.overlay;
    R.overlay = function (c) {
      if (overlayFrame === frame) return;
      overlayFrame = frame;
      return orig.call(R, c || ctx);
    };
  }

  function drawFlashes(c) {
    let any = false;
    for (let i = 0; i < flashes.length; i++) { if (flashes[i].active) { any = true; break; } }
    if (!any) return;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < flashes.length; i++) {
      const f = flashes[i];
      if (!f.active) continue;
      const p = f.dur > 0 ? PI.U.clamp(f.t / f.dur, 0, 1) : 1;
      const a = f.a * (1 - PI.U.easeOutCubic(p));
      if (a <= 0.002) continue;
      c.globalAlpha = a;
      c.fillStyle = f.color;
      c.fillRect(0, 0, W, H);
    }
    c.restore();
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  function draw() {
    if (!ctx || !canvas) return;
    const s = scale * dpr;
    // black letterbox bars over the entire backing store
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // logical 1280x720 viewport, clipped so nothing bleeds into the bars
    ctx.setTransform(s, 0, 0, s, offX * dpr, offY * dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    ctx.fillStyle = PI.C.bg;
    ctx.fillRect(0, 0, W, H);
    // camera: zoom punch about the centre + trauma shake
    ctx.save();
    const z = 1 + punchZoom();
    if (z !== 1) {
      ctx.translate(W * 0.5, H * 0.5);
      ctx.scale(z, z);
      ctx.translate(-W * 0.5, -H * 0.5);
    }
    if (shake.x !== 0 || shake.y !== 0) ctx.translate(shake.x, shake.y);
    if (PI.Game && typeof PI.Game.draw === 'function') PI.Game.draw();
    ctx.restore();
    // overlays live in stable logical space (they must not shake with the world)
    drawFlashes(ctx);
    if (PI.Render && typeof PI.Render.overlay === 'function') PI.Render.overlay(ctx);
    ctx.restore();
  }

  // ---------------------------------------------------------------- loop
  function frameStep(ts) {
    rafId = raf(frameStep);        // re-armed first: a throw below can't kill the loop
    frame++;

    const nowS = (typeof ts === 'number' && isFinite(ts)) ? ts / 1000 : PI.U.now();
    let rawUn = nowS - lastT;
    lastT = nowS;
    if (!(rawUn > 0)) rawUn = 1 / 60;
    if (rawUn > 0 && rawUn < 0.5) fps = fps * FPS_SMOOTH + (1 / rawUn) * (1 - FPS_SMOOTH);
    const raw = rawUn > DT_CLAMP ? DT_CLAMP : rawUn;   // §14: 50ms clamp
    realTime += raw;

    if (((typeof window !== 'undefined' && window.devicePixelRatio) || 1) !== dprSeen) needResize = true;
    if (needResize) { needResize = false; resize(); }

    updateTimeScale(raw);
    const stopped = hitstopT > 0;
    if (stopped) hitstopT = Math.max(0, hitstopT - raw);
    const dt = stopped ? 0 : raw * timeScale;
    const camDt = stopped ? 0 : raw;

    time += dt;
    updateCamera(camDt);

    api.dt = dt; api.time = time; api.realTime = realTime;
    api.timeScale = timeScale; api.fps = fps; api.frame = frame;

    hookOverlay();
    // Some Game implementations set the opening state inside boot(), where
    // setState('TITLE') is a no-op because Core already starts in TITLE. Fire one
    // synthetic entry event so the title screen always gets its onState call.
    if (!initialStateFired) {
      initialStateFired = true;
      if (PI.Game && typeof PI.Game.onState === 'function') PI.Game.onState(null, state);
    }
    if (PI.Game && typeof PI.Game.update === 'function') PI.Game.update(dt);
    draw();
  }

  function start() {
    if (running) return;
    running = true;
    lastT = PI.U.now();
    rafId = raf(frameStep);
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    if (booted) return api;
    booted = true;
    installErrorHooks();
    installDebug();
    if (typeof document === 'undefined') return api;
    makeCanvas();
    api.canvas = canvas;
    api.ctx = ctx;
    styleHost();
    attach();
    resize();
    installListeners();
    api.isTouchOnly = detectTouchOnly();
    try { hasFocus = (document.hasFocus ? !!document.hasFocus() : true); } catch (_) { hasFocus = true; }
    api.hasFocus = hasFocus;
    start();
    return api;
  }

  const api = {
    // surfaces
    canvas: null, ctx: null, W: W, H: H,
    // clock
    time: 0, dt: 0, realTime: 0, frame: 0, fps: 60,
    timeScale: 1,
    // camera
    trauma: 0, shake: shake,
    // machine
    state: state, pausedByBlur: false,
    // environment
    hasFocus: true, isTouchOnly: false,
    scale: 1, dpr: 1, cssW: W, cssH: H, offX: 0, offY: 0,
    // api
    setState: setState,
    setTimeScale: setTimeScale,
    hitstop: hitstop,
    addTrauma: addTrauma,
    punch: punch,
    flash: flash,
    resize: resize,
    focus: focusSelf,
    boot: boot
  };
  // PI.Core.hitstop is the method (per contract); the remaining freeze time is
  // readable as PI.Core.hitstopT for anything that wants to know.
  Object.defineProperty(api, 'hitstopT', { get: function () { return hitstopT; } });

  installErrorHooks();
  installDebug();

  return api;
})();
