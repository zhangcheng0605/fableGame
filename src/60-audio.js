// 60-audio.js — PI.Audio : 100% WebAudio synthesis (DESIGN.md §11 SFX + §13).
// No audio files, no fetch, no decodeAudioData. ONE AudioContext, created lazily
// inside init() (first keystroke — autoplay policy). Every public method is a
// no-op that never throws when the context is missing, suspended, closed or muted.
// Graph:  voices -> sfxBus ----\
//         music layers -> musicBus -> musicFilter -> master -> limiter -> out
PI.Audio = (function () {

  // ------------------------------------------------------------------ tuning
  const T = (PI.TUNING && PI.TUNING.audio) || {};
  const SCORE = (PI.TUNING && PI.TUNING.score) || {};

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function list(v, d) { return (v && v.length) ? v : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function ratio(semi) { return Math.pow(2, semi / 12); }

  const MASTER_G = num(T.master, 0.42);
  const MUSIC_G = num(T.musicGain, 0.16);
  const SFX_G = num(T.sfxGain, 0.6);
  const BPM = num(T.bpm, 110);
  const SIXTEENTH = (60 / BPM) / 4;              // ~136ms at 110 BPM
  const BASS_F = num(T.bassNote, 55);            // Hz (A1), not a MIDI number
  const BASS_LEN = num(T.bassLen, 0.26);
  const PAD_F = num(T.padNote, 110);
  const ARP_NOTES = list(T.arpNotes, [0, 7, 12, 15, 19, 24]);
  const ARP_BASE = PAD_F * 2;                    // arpeggio sits an octave above the pad
  const ARP_G = num(T.arpGain, 0.1);
  const DRONE_F = num(T.droneNote, 41);
  const DRONE_G = num(T.droneGain, 0.09);
  const KEY_BASE = num(T.keyBase, 330);
  const KEY_LEN = num(T.keyLen, 0.045);
  const KEY_G = num(T.keyGain, 0.22);
  // §11: "pitch rises with each successive letter" — pentatonic so runs stay
  // musical; wraps after 8 steps. (TUNING.keyStep is a linear-Hz alternative,
  // kept in TUNING but unused: ratios sound better across the whole word.)
  const KEY_STEPS = [0, 2, 4, 7, 9, 12, 14, 16];
  const TYPO_F = num(T.typoFreq, 88);
  const TYPO_LEN = num(T.typoLen, 0.16);
  const TYPO_G = num(T.typoGain, 0.3);
  const KILL_SCALE = list(T.killScale, [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27]);
  const KILL_BASE = num(T.killBase, 392);
  const KILL_LEN = num(T.killLen, 0.19);
  const KILL_G = num(T.killGain, 0.24);
  const EXP_LEN = num(T.explodeLen, 0.3);
  const EXP_G = num(T.explodeGain, 0.3);
  const BOSSHIT_LEN = num(T.bossHitLen, 0.26);
  const BOSSDIE_LEN = num(T.bossDieLen, 1.5);
  const LEAK_LEN = num(T.leakLen, 0.5);
  const LEAK_F = num(T.leakFreq, 130);
  const BREAK_LEN = num(T.comboBreakLen, 0.5);
  const TICK_F = num(T.uiTickFreq, 880);
  const TICK_LEN = num(T.uiTickLen, 0.03);
  const WAVE_LEN = num(T.waveStartLen, 0.4);
  const INTENSITY_TC = 1 / Math.max(0.2, num(T.intensityLerp, 2.2));
  const MUTE_KEY = (typeof SCORE.muteKey === 'string') ? SCORE.muteKey : 'pi_muted';

  const MAX_SFX = 24;          // concurrent sfx voices; extras are dropped
  const MAX_MUSIC = 20;
  const LOOKAHEAD = 0.2;       // schedule 200ms ahead...
  const TICK_MS = 25;          // ...from a 25ms setInterval scheduler (§13)
  const ARP_GATE = 0.5;        // arpeggio layer only plays at high intensity

  // one bar of 16ths; null = rest. Semitone offsets from BASS_F.
  const BASS_PAT = [0, null, null, null, 0, null, null, 7,
                    0, null, null, null, 5, null, 7, null];

  // ------------------------------------------------------------------- state
  let ctx = null, master = null, limiter = null, sfxBus = null;
  let musicBus = null, musicFilter = null;
  let bassG = null, hatG = null, arpG = null;
  let noiseBuf = null;
  let sfxVoices = 0, musicVoices = 0;
  let muted = false;
  let musicOn = false, schedId = 0, nextNote = 0, step = 0, bar = 0, arpI = 0;
  let intensity = 0;
  let drone = null;            // { a, b, c, gain, filter } or null

  try {
    muted = (window.localStorage && window.localStorage.getItem(MUTE_KEY) === '1');
  } catch (_) { muted = false; }

  // -------------------------------------------------------------- graph/init
  function makeNoise() {
    // 2s of white noise, generated once and looped by every noise voice.
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function init() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        ctx = new AC();

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -8;
        limiter.knee.value = 6;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.18;
        limiter.connect(ctx.destination);

        master = ctx.createGain();
        master.gain.value = muted ? 0.0001 : MASTER_G;
        master.connect(limiter);

        sfxBus = ctx.createGain();
        sfxBus.gain.value = SFX_G;
        sfxBus.connect(master);

        musicFilter = ctx.createBiquadFilter();
        musicFilter.type = 'lowpass';
        musicFilter.frequency.value = 900 + 2600 * intensity;
        musicFilter.Q.value = 0.7;
        musicFilter.connect(master);

        musicBus = ctx.createGain();
        musicBus.gain.value = musicOn ? MUSIC_G : 0.0001;
        musicBus.connect(musicFilter);

        bassG = ctx.createGain(); bassG.gain.value = 1;
        hatG = ctx.createGain(); hatG.gain.value = 0.28 + 0.72 * intensity;
        arpG = ctx.createGain(); arpG.gain.value = intensity < ARP_GATE ? 0.0001 : 1;
        bassG.connect(musicBus); hatG.connect(musicBus); arpG.connect(musicBus);

        noiseBuf = makeNoise();
      }
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume();
      if (musicOn && !schedId) startSched();
      return true;
    } catch (_) { return false; }
  }

  function nowT() { return ctx ? ctx.currentTime : 0; }

  function ready() {
    if (!ctx || muted) return false;
    const st = ctx.state;
    if (st === 'closed') return false;
    if (st === 'suspended' || st === 'interrupted') {
      try { ctx.resume(); } catch (_) { }
      return false;                      // drop this one event rather than pile up
    }
    return true;
  }

  // ------------------------------------------------------------ voice plumbing
  function drop(src, chain) {
    try { src.disconnect(); } catch (_) { }
    for (let i = 0; i < chain.length; i++) { try { chain[i].disconnect(); } catch (_) { } }
  }

  // Starts + stops every node it is given and disconnects the whole chain when
  // the source ends, so nothing leaks. Past the voice cap the voice is dropped.
  function spawn(src, chain, t0, dur, isMusic, offset) {
    if (isMusic ? (musicVoices >= MAX_MUSIC) : (sfxVoices >= MAX_SFX)) {
      drop(src, chain);
      return false;
    }
    if (isMusic) musicVoices++; else sfxVoices++;
    let done = false;
    function fin() {
      if (done) return;
      done = true;
      if (isMusic) { musicVoices = Math.max(0, musicVoices - 1); }
      else { sfxVoices = Math.max(0, sfxVoices - 1); }
      drop(src, chain);
    }
    src.onended = fin;
    try {
      if (src.buffer) src.start(t0, offset || 0); else src.start(t0);
      src.stop(t0 + dur);
    } catch (_) { fin(); return false; }
    // safety net in case 'ended' never fires (context closed mid-flight)
    try { setTimeout(fin, Math.max(60, (t0 - nowT() + dur + 0.35) * 1000)); } catch (_) { }
    return true;
  }

  function envelope(p, t0, dur, peak, atk, hold) {
    const pk = Math.max(0.0002, peak);
    const a = Math.min(Math.max(0.001, atk), dur * 0.5);
    try {
      p.setValueAtTime(0.0001, t0);
      p.linearRampToValueAtTime(pk, t0 + a);
      if (hold > 0) p.setValueAtTime(pk, t0 + Math.min(dur * 0.9, a + hold));
      p.exponentialRampToValueAtTime(0.0001, t0 + dur);
    } catch (_) { }
  }

  // filter tail shared by tone()/noise(): o.filter type, o.fc start, o.fc1 end, o.q
  function filterTail(g, dest, t0, dur, o, chain) {
    if (!o.filter) { g.connect(dest); return; }
    const bq = ctx.createBiquadFilter();
    bq.type = o.filter;
    bq.frequency.setValueAtTime(Math.max(30, num(o.fc, 900)), t0);
    if (o.fc1) {
      try { bq.frequency.exponentialRampToValueAtTime(Math.max(30, o.fc1), t0 + dur); } catch (_) { }
    }
    if (o.q) bq.Q.value = o.q;
    g.connect(bq); bq.connect(dest);
    chain.push(bq);
  }

  function tone(type, f0, f1, t0, dur, peak, dest, o) {
    if (!ctx || !ready()) return null;
    o = o || {};
    let osc, g;
    try { osc = ctx.createOscillator(); g = ctx.createGain(); } catch (_) { return null; }
    osc.type = type;
    const chain = [g];
    osc.connect(g);
    filterTail(g, dest || sfxBus, t0, dur, o, chain);
    try {
      osc.frequency.setValueAtTime(Math.max(8, f0), t0);
      if (f1 && f1 !== f0) {
        const te = t0 + dur * num(o.sweepT, 1);
        if (o.linear) osc.frequency.linearRampToValueAtTime(Math.max(8, f1), te);
        else osc.frequency.exponentialRampToValueAtTime(Math.max(8, f1), te);
      }
      if (o.detune) osc.detune.value = o.detune;
    } catch (_) { }
    envelope(g.gain, t0, dur, peak, num(o.attack, 0.004), num(o.hold, 0));
    if (!spawn(osc, chain, t0, dur + 0.02, o.music)) return null;
    return g;
  }

  function noise(t0, dur, peak, dest, o) {
    if (!ctx || !noiseBuf || !ready()) return null;
    o = o || {};
    let src, g;
    try { src = ctx.createBufferSource(); g = ctx.createGain(); } catch (_) { return null; }
    src.buffer = noiseBuf;
    src.loop = true;
    try {
      if (o.rate) src.playbackRate.setValueAtTime(Math.max(0.05, o.rate), t0);
      if (o.rate1) src.playbackRate.exponentialRampToValueAtTime(Math.max(0.05, o.rate1), t0 + dur);
    } catch (_) { }
    const chain = [g];
    src.connect(g);
    filterTail(g, dest || sfxBus, t0, dur, o, chain);
    envelope(g.gain, t0, dur, peak, num(o.attack, 0.003), num(o.hold, 0));
    if (!spawn(src, chain, t0, dur + 0.02, o.music, rnd(0, 1.5))) return null;
    return g;
  }

  // ------------------------------------------------------------------ SFX §11
  // Correct keystroke: short pulse blip, pitch rises with the letter index.
  function key(stepIdx) {
    if (!ready()) return;
    const t = nowT() + 0.003;
    const i = Math.abs(Math.floor(num(stepIdx, 0))) % KEY_STEPS.length;
    const f = KEY_BASE * ratio(KEY_STEPS[i]);
    tone('square', f, f * 1.06, t, KEY_LEN + 0.03, KEY_G, sfxBus,
      { attack: 0.001, filter: 'lowpass', fc: 5200, q: 0.8 });
    tone('triangle', f * 2, f * 2, t, KEY_LEN * 0.6, KEY_G * 0.25, sfxBus, { attack: 0.001 });
  }

  // Typo: harsh low buzz + a noise slap (§11 "unmissable").
  function typo() {
    if (!ready()) return;
    const t = nowT() + 0.003;
    tone('sawtooth', TYPO_F, TYPO_F * 0.86, t, TYPO_LEN, TYPO_G, sfxBus,
      { attack: 0.001, filter: 'lowpass', fc: 700, fc1: 260, q: 4 });
    tone('square', TYPO_F * 1.5, TYPO_F * 1.4, t, TYPO_LEN * 0.8, TYPO_G * 0.45, sfxBus,
      { attack: 0.001, detune: 22, filter: 'lowpass', fc: 900 });
    noise(t, 0.07, TYPO_G * 0.6, sfxBus, { attack: 0.001, filter: 'bandpass', fc: 240, q: 1.4 });
  }

  // Kill: noise burst + pitched chime that walks a scale with the combo, so a
  // streak literally plays a melody (§11).
  function kill(stepIdx) {
    if (!ready()) return;
    const t = nowT() + 0.003;
    const i = Math.abs(Math.floor(num(stepIdx, 0))) % KILL_SCALE.length;
    const f = KILL_BASE * ratio(KILL_SCALE[i]);
    noise(t, 0.085, 0.42, sfxBus, { attack: 0.001, filter: 'highpass', fc: 1500, fc1: 5200 });
    tone('triangle', f, f, t, KILL_LEN, KILL_G, sfxBus, { attack: 0.002 });
    tone('sine', f * 2, f * 2, t, KILL_LEN * 0.7, KILL_G * 0.45, sfxBus, { attack: 0.001 });
    tone('sine', f * 3.01, f * 3.01, t + 0.008, KILL_LEN * 0.4, KILL_G * 0.16, sfxBus, { attack: 0.001 });
  }

  // size: 'basic' | 'elite' | 'boss' | a scalar (a big number reads as pixels).
  function sizeOf(size) {
    if (typeof size === 'string') {
      if (size === 'boss') return 1.6;
      if (size === 'elite') return 1.15;
      if (size === 'basic') return 0.8;
      return 1;
    }
    const s = num(size, 1);
    return clamp(s > 3 ? s / 40 : s, 0.5, 2.2);
  }

  function explode(size) {
    if (!ready()) return;
    const s = sizeOf(size);
    const t = nowT() + 0.003;
    const dur = EXP_LEN * (0.7 + 0.55 * s);
    noise(t, dur, EXP_G * (0.7 + 0.4 * s), sfxBus,
      { attack: 0.002, filter: 'lowpass', fc: 2400 * s, fc1: 160, q: 1.1, rate: 1.15, rate1: 0.55 });
    tone('sine', 190 * s, 34, t, dur * 0.92, EXP_G * 0.85, sfxBus, { attack: 0.002 });
    tone('sawtooth', 130 * s, 42, t, dur * 0.5, EXP_G * 0.24, sfxBus,
      { attack: 0.001, filter: 'lowpass', fc: 950, fc1: 130 });
  }

  // Boss intro klaxon: two-tone saw sweep, three cycles (§11.5 boss intro).
  function klaxon() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    for (let i = 0; i < 3; i++) {
      const a = t + i * 0.3;
      tone('sawtooth', 520, 700, a, 0.15, 0.24, sfxBus,
        { attack: 0.012, filter: 'bandpass', fc: 900, q: 2.6 });
      tone('sawtooth', 522, 702, a, 0.15, 0.12, sfxBus,
        { attack: 0.012, detune: -18, filter: 'bandpass', fc: 1400, q: 2.2 });
      tone('sawtooth', 700, 520, a + 0.15, 0.15, 0.24, sfxBus,
        { attack: 0.012, filter: 'bandpass', fc: 900, q: 2.6 });
    }
    tone('sine', 70, 52, t, 0.9, 0.22, sfxBus, { attack: 0.02, hold: 0.4 });
  }

  // Boss word destroyed: heavy metallic thunk.
  function bossHit() {
    if (!ready()) return;
    const t = nowT() + 0.003;
    tone('sine', 260, 62, t, BOSSHIT_LEN, 0.34, sfxBus, { attack: 0.002 });
    tone('square', 180, 90, t, BOSSHIT_LEN * 0.5, 0.12, sfxBus,
      { attack: 0.001, filter: 'lowpass', fc: 1200, fc1: 400 });
    noise(t, BOSSHIT_LEN * 0.7, 0.34, sfxBus,
      { attack: 0.001, filter: 'bandpass', fc: 1900, fc1: 700, q: 3.5 });
    tone('triangle', 1320, 990, t, 0.12, 0.09, sfxBus, { attack: 0.001 });
  }

  // Boss death: long descending sweep + noise wash + a closing boom (§11.5).
  function bossDie() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    const d = BOSSDIE_LEN;
    tone('sawtooth', 880, 55, t, d, 0.3, sfxBus,
      { attack: 0.01, filter: 'lowpass', fc: 3200, fc1: 220, q: 2 });
    tone('square', 660, 41, t + 0.02, d * 0.95, 0.11, sfxBus,
      { attack: 0.01, detune: 14, filter: 'lowpass', fc: 1800, fc1: 200 });
    noise(t, d * 1.05, 0.3, sfxBus,
      { attack: 0.01, filter: 'lowpass', fc: 5200, fc1: 200, rate: 1.5, rate1: 0.35 });
    tone('sine', 1760, 1230, t, d * 0.75, 0.06, sfxBus, { attack: 0.02 });
    // final impact once the sweep bottoms out
    const b = t + d * 0.62;
    tone('sine', 120, 30, b, 0.75, 0.36, sfxBus, { attack: 0.003 });
    noise(b, 0.5, 0.26, sfxBus, { attack: 0.002, filter: 'lowpass', fc: 1400, fc1: 120 });
  }

  // Combo break: glass shatter — noise + a high resonant band, fast decay (§9).
  function comboBreak() {
    if (!ready()) return;
    const t = nowT() + 0.003;
    noise(t, 0.07, 0.5, sfxBus, { attack: 0.001, filter: 'highpass', fc: 2600 });
    noise(t, BREAK_LEN, 0.24, sfxBus,
      { attack: 0.001, filter: 'bandpass', fc: 3800, fc1: 2100, q: 12, rate: 1.1, rate1: 0.8 });
    for (let i = 0; i < 4; i++) {
      const f = rnd(1900, 3400);
      tone('triangle', f, f * 0.82, t + 0.015 + i * 0.045, 0.13, 0.085, sfxBus, { attack: 0.001 });
    }
    tone('sine', 180, 66, t, 0.3, 0.2, sfxBus, { attack: 0.002 });
  }

  // FLOW STATE in: bright rising arpeggio (§9/§11.5).
  function flowStart() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    const steps = [0, 4, 7, 12, 16, 19];
    for (let i = 0; i < steps.length; i++) {
      const f = 440 * ratio(steps[i]);
      const a = t + i * 0.055;
      tone('square', f, f, a, 0.22, 0.15, sfxBus,
        { attack: 0.002, filter: 'lowpass', fc: 4200, q: 1 });
      tone('triangle', f * 2, f * 2, a, 0.16, 0.07, sfxBus, { attack: 0.001 });
    }
    noise(t, 0.4, 0.14, sfxBus, { attack: 0.12, filter: 'highpass', fc: 2000, fc1: 8000 });
  }

  // FLOW STATE out: record-scratch-ish downward noise sweep.
  function flowEnd() {
    if (!ready()) return;
    const t = nowT() + 0.003;
    noise(t, 0.42, 0.32, sfxBus,
      { attack: 0.004, filter: 'bandpass', fc: 3200, fc1: 220, q: 5, rate: 1.7, rate1: 0.25 });
    tone('sawtooth', 520, 90, t, 0.36, 0.16, sfxBus,
      { attack: 0.004, filter: 'lowpass', fc: 2400, fc1: 300 });
  }

  // temp=0 : crystalline chime cluster (§10 freeze).
  function freeze() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    const f = [1568, 2093, 2637, 3136, 3520];
    for (let i = 0; i < f.length; i++) {
      const a = t + i * 0.035;
      tone('sine', f[i], f[i] * 0.998, a, 0.7 - i * 0.06, 0.11, sfxBus, { attack: 0.002 });
      tone('sine', f[i] * 2.002, f[i] * 2, a, 0.22, 0.03, sfxBus, { attack: 0.001 });
    }
    noise(t, 0.5, 0.1, sfxBus, { attack: 0.05, filter: 'highpass', fc: 6000 });
    tone('sine', 196, 174, t, 0.6, 0.1, sfxBus, { attack: 0.02 });
  }

  // rlhf : popcorn cascade matching the staggered enemy explosions (§10 purge).
  function purge() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    for (let i = 0; i < 10; i++) {
      const a = t + i * 0.055;
      noise(a, 0.075, 0.24, sfxBus,
        { attack: 0.001, filter: 'bandpass', fc: 700 + i * 260, q: 2.2, rate: 1 + i * 0.06 });
      tone('square', 220 * ratio(i * 2), 140, a, 0.06, 0.07, sfxBus, { attack: 0.001 });
    }
    tone('sine', 110, 55, t, 0.5, 0.2, sfxBus, { attack: 0.004 });
  }

  // stop : a snap (§10 stop sequence).
  function stopSeq() {
    if (!ready()) return;
    const t = nowT() + 0.003;
    noise(t, 0.05, 0.5, sfxBus, { attack: 0.0008, filter: 'highpass', fc: 3000 });
    tone('square', 900, 170, t, 0.055, 0.2, sfxBus, { attack: 0.0008 });
    tone('sine', 150, 60, t, 0.14, 0.16, sfxBus, { attack: 0.002 });
  }

  // A golden system command was completed: bright, obviously-good chime pair.
  function command() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    tone('triangle', 880, 880, t, 0.2, 0.16, sfxBus, { attack: 0.002 });
    tone('triangle', 1320, 1320, t + 0.07, 0.3, 0.14, sfxBus, { attack: 0.002 });
    tone('sine', 1760, 1760, t + 0.14, 0.35, 0.08, sfxBus, { attack: 0.002 });
    noise(t, 0.28, 0.1, sfxBus, { attack: 0.02, filter: 'highpass', fc: 4500, fc1: 9000 });
  }

  function uiTick() {
    if (!ready()) return;
    const t = nowT() + 0.002;
    tone('sine', TICK_F, TICK_F * 0.94, t, TICK_LEN + 0.02, 0.11, sfxBus, { attack: 0.001 });
  }

  // Wave banner sting (§8 breather).
  function waveStart() {
    if (!ready()) return;
    const t = nowT() + 0.003;
    tone('triangle', 440, 440, t, WAVE_LEN * 0.45, 0.14, sfxBus, { attack: 0.003 });
    tone('triangle', 660, 660, t + WAVE_LEN * 0.4, WAVE_LEN * 0.6, 0.14, sfxBus, { attack: 0.003 });
    noise(t, WAVE_LEN * 0.5, 0.08, sfxBus, { attack: 0.08, filter: 'highpass', fc: 3000, fc1: 7000 });
  }

  // NEW HIGH SCORE: triumphant 4-note motif (§9).
  function highScore() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    const steps = [0, 4, 7, 12];
    for (let i = 0; i < steps.length; i++) {
      const f = 523.25 * ratio(steps[i]);
      const a = t + i * 0.14;
      const last = (i === steps.length - 1);
      tone('square', f, f, a, last ? 0.9 : 0.2, 0.14, sfxBus,
        { attack: 0.004, hold: last ? 0.3 : 0.04, filter: 'lowpass', fc: 4600, q: 0.9 });
      tone('triangle', f * 1.5, f * 1.5, a, last ? 0.8 : 0.18, 0.07, sfxBus, { attack: 0.004 });
    }
    noise(t + 0.42, 0.7, 0.1, sfxBus, { attack: 0.2, filter: 'highpass', fc: 3500, fc1: 9000 });
  }

  // Enemy injected itself into the context: low detuned drop + corruption hiss.
  function leak() {
    if (!ready()) return;
    const t = nowT() + 0.003;
    tone('sawtooth', LEAK_F, 45, t, LEAK_LEN, 0.3, sfxBus,
      { attack: 0.003, filter: 'lowpass', fc: 1400, fc1: 200, q: 2 });
    tone('sawtooth', LEAK_F * 1.01, 44, t, LEAK_LEN, 0.16, sfxBus,
      { attack: 0.003, detune: 26, filter: 'lowpass', fc: 900, fc1: 160 });
    tone('square', LEAK_F * 2, 96, t, LEAK_LEN * 0.4, 0.08, sfxBus, { attack: 0.001 });
    noise(t, LEAK_LEN * 0.7, 0.2, sfxBus,
      { attack: 0.002, filter: 'bandpass', fc: 1200, fc1: 300, q: 1.6, rate: 1.2, rate1: 0.5 });
  }

  // CONTEXT CORRUPTED: the same drop, longer and lower, with a dying chord.
  function gameOver() {
    if (!ready()) return;
    const t = nowT() + 0.004;
    tone('sawtooth', 165, 33, t, 1.6, 0.26, sfxBus,
      { attack: 0.01, filter: 'lowpass', fc: 1600, fc1: 120, q: 2.4 });
    tone('sawtooth', 166.5, 32, t, 1.6, 0.16, sfxBus, { attack: 0.01, detune: 30, filter: 'lowpass', fc: 900, fc1: 110 });
    tone('sine', 110, 27, t, 1.7, 0.24, sfxBus, { attack: 0.01 });
    tone('triangle', 392, 92, t + 0.1, 1.2, 0.1, sfxBus, { attack: 0.02, filter: 'lowpass', fc: 1200, fc1: 200 });
    noise(t, 1.4, 0.16, sfxBus, { attack: 0.05, filter: 'lowpass', fc: 2200, fc1: 130, rate: 1, rate1: 0.4 });
  }

  // ------------------------------------------------------------- music (§13)
  // 110 BPM generative loop, lookahead-scheduled: bass pulse always, hat/blip
  // layer crossfaded by intensity, arpeggio only at high intensity (FLOW),
  // plus a low drone that fades in under 30% integrity (§11 ambient).
  function scheduleStep(s, t) {
    const b = BASS_PAT[s];
    if (b !== null && b !== undefined) {
      const f = BASS_F * ratio(b);
      tone('triangle', f, f * 0.985, t, BASS_LEN, 0.95, bassG,
        { attack: 0.006, music: true, filter: 'lowpass', fc: 420, q: 1.2 });
      tone('sine', f * 0.5, f * 0.5, t, BASS_LEN * 1.2, 0.5, bassG, { attack: 0.008, music: true });
    }
    // sparse pad every other bar for depth
    if (s === 0 && (bar % 2) === 0) {
      tone('sawtooth', PAD_F, PAD_F, t, 1.7, 0.1, bassG,
        { attack: 0.5, music: true, filter: 'lowpass', fc: 620, q: 0.9 });
      tone('sawtooth', PAD_F * 1.5, PAD_F * 1.5, t, 1.7, 0.06, bassG,
        { attack: 0.6, music: true, detune: 8, filter: 'lowpass', fc: 700 });
    }
    // hat / blip layer
    if ((s % 2) === 1) {
      noise(t, 0.03, (s % 4) === 3 ? 0.34 : 0.2, hatG,
        { attack: 0.001, music: true, filter: 'highpass', fc: 7000 });
    }
    if (s === 5 || s === 13) {
      const f = PAD_F * 4 * ratio(s === 5 ? 0 : 7);
      tone('square', f, f, t, 0.06, 0.16, hatG,
        { attack: 0.001, music: true, filter: 'lowpass', fc: 5000 });
    }
    // arpeggio layer — FLOW STATE only
    if (intensity >= ARP_GATE) {
      const f = ARP_BASE * ratio(ARP_NOTES[arpI % ARP_NOTES.length]);
      arpI++;
      tone('square', f, f, t, SIXTEENTH * 0.85, ARP_G * 4.2, arpG,
        { attack: 0.002, music: true, filter: 'lowpass', fc: 1400 + 3000 * intensity, q: 1.1 });
    }
  }

  function droneStart() {
    if (drone || !ctx || !musicBus) return;
    let a, b, c, g, f;
    try {
      a = ctx.createOscillator(); b = ctx.createOscillator(); c = ctx.createOscillator();
      g = ctx.createGain(); f = ctx.createBiquadFilter();
    } catch (_) { return; }
    a.type = 'sawtooth'; b.type = 'sawtooth'; c.type = 'sine';
    a.frequency.value = DRONE_F; b.frequency.value = DRONE_F * 1.006; c.frequency.value = DRONE_F * 2;
    f.type = 'lowpass'; f.frequency.value = 240; f.Q.value = 1.4;
    a.connect(f); b.connect(f); c.connect(f);
    f.connect(g); g.connect(musicBus);
    const t = nowT();
    g.gain.value = 0.0001;
    try { g.gain.linearRampToValueAtTime(DRONE_G * 6, t + 1.6); } catch (_) { }
    drone = { a: a, b: b, c: c, gain: g, filter: f, ended: 0 };
    const nodes = [a, b, c];
    for (let i = 0; i < 3; i++) {
      nodes[i].onended = function () {
        try { this.disconnect(); } catch (_) { }
        if (drone && drone.gain === g) return;
        try { f.disconnect(); g.disconnect(); } catch (_) { }
      };
      try { nodes[i].start(t); } catch (_) { }
    }
  }

  function droneStop() {
    if (!drone) return;
    const d = drone;
    drone = null;
    const t = nowT();
    try {
      d.gain.gain.cancelScheduledValues(t);
      d.gain.gain.setValueAtTime(d.gain.gain.value, t);
      d.gain.gain.linearRampToValueAtTime(0.0001, t + 0.6);
    } catch (_) { }
    try { d.a.stop(t + 0.65); d.b.stop(t + 0.65); d.c.stop(t + 0.65); } catch (_) { }
  }

  function updateDrone() {
    if (!musicOn || muted) { droneStop(); return; }
    const g = (PI.Game && typeof PI.Game.integrity === 'number') ? PI.Game.integrity : 100;
    const playing = (PI.Core && PI.Core.state === 'PLAYING');
    if (playing && g > 0 && g < 30) droneStart(); else droneStop();
  }

  function schedTick() {
    if (!ctx || !musicOn) return;
    if (!ready()) { nextNote = nowT() + 0.05; return; }
    const t = nowT();
    if (nextNote < t) nextNote = t + 0.02;          // resync after a tab stall
    let guard = 0;
    while (nextNote < t + LOOKAHEAD && guard++ < 24) {
      scheduleStep(step, nextNote);
      step++;
      if (step >= 16) { step = 0; bar++; }
      nextNote += SIXTEENTH;
    }
    updateDrone();
  }

  function startSched() {
    if (schedId || !ctx) return;
    step = 0; bar = 0; arpI = 0;
    nextNote = nowT() + 0.08;
    try { schedId = setInterval(schedTick, TICK_MS); } catch (_) { schedId = 0; }
  }

  function stopSched() {
    if (schedId) { try { clearInterval(schedId); } catch (_) { } schedId = 0; }
    droneStop();
  }

  function music(on) {
    const want = !!on;
    if (want === musicOn && (!want || schedId)) return;
    musicOn = want;
    if (want) {
      if (!ctx) init();                     // harmless if there is no gesture yet
      if (!ctx) return;                     // scheduler starts from init() later
      if (musicBus) {
        const t = nowT();
        try {
          musicBus.gain.cancelScheduledValues(t);
          musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
          musicBus.gain.linearRampToValueAtTime(MUSIC_G, t + 0.6);
        } catch (_) { }
      }
      startSched();
    } else {
      if (musicBus && ctx) {
        const t = nowT();
        try {
          musicBus.gain.cancelScheduledValues(t);
          musicBus.gain.setValueAtTime(Math.max(0.0001, musicBus.gain.value), t);
          musicBus.gain.linearRampToValueAtTime(0.0001, t + 0.25);
        } catch (_) { }
      }
      stopSched();
    }
  }

  // 0..1 — crossfades the hat/arp layers and nudges the music filter cutoff.
  function setIntensity(v) {
    intensity = clamp(num(v, 0), 0, 1);
    if (!ctx) return;
    const t = nowT();
    try {
      if (hatG) hatG.gain.setTargetAtTime(0.28 + 0.72 * intensity, t, INTENSITY_TC);
      if (arpG) arpG.gain.setTargetAtTime(intensity < ARP_GATE ? 0.0001 : 0.5 + 0.5 * intensity, t, INTENSITY_TC);
      if (musicFilter) musicFilter.frequency.setTargetAtTime(900 + 2600 * intensity, t, INTENSITY_TC);
    } catch (_) { }
  }

  // -------------------------------------------------------------- mute (§13)
  function applyMute() {
    if (!ctx || !master) return;
    const t = nowT();
    try {
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t);
      master.gain.linearRampToValueAtTime(muted ? 0.0001 : MASTER_G, t + 0.09);
    } catch (_) { }
    if (muted) droneStop();
  }

  function toggleMute() {
    muted = !muted;
    try {
      if (window.localStorage) window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch (_) { }
    applyMute();
    if (!muted && musicOn && ctx && !schedId) startSched();
    return muted;
  }

  // ------------------------------------------------------------------- export
  const api = {
    init: init,
    key: key, typo: typo, kill: kill, explode: explode,
    klaxon: klaxon, bossIntro: klaxon, bossHit: bossHit, bossDie: bossDie,
    leak: leak, comboBreak: comboBreak, flowStart: flowStart, flowEnd: flowEnd,
    freeze: freeze, purge: purge, stopSeq: stopSeq, command: command,
    uiTick: uiTick, highScore: highScore, gameOver: gameOver, waveStart: waveStart,
    music: music, setIntensity: setIntensity, toggleMute: toggleMute,
    // debug / diagnostics — not part of the contract, safe to ignore
    voices: function () { return sfxVoices + musicVoices; },
    ctxState: function () { return ctx ? ctx.state : 'none'; }
  };

  Object.defineProperty(api, 'muted', {
    enumerable: true,
    get: function () { return muted; },
    set: function (v) { if (!!v !== muted) toggleMute(); }
  });
  Object.defineProperty(api, 'intensity', {
    enumerable: true,
    get: function () { return intensity; }
  });
  Object.defineProperty(api, 'playing', {
    enumerable: true,
    get: function () { return !!schedId; }
  });

  return api;
})();
