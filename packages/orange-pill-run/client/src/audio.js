// Orange Pill Run - sound (kanban #3251, owner 2026-11-22): an ORIGINAL 8-bit loop and synthesized effects, all WebAudio, no files.
// Drawing/audio only: nothing here touches the simulation. worldEvents() reads two snapshots of the world the renderer already sees and names
// what happened between them; main.js plays them. The AudioContext is made on the first user gesture (the Play button: the iOS rule), the
// music ducks under effects, everything pauses while the tab is hidden, and the speaker setting (on / effects only / off) is remembered.

/** What one step did, from the world's counters (pure; node tests check it). */
export function snapWorld(W) {
  const p = W.p, s = W.stats;
  return { coins: s.coins, blocks: s.blocks, stomps: s.stomps, hits: s.hits, powers: s.powers, high: s.high, cp: p.cp, hurtT: p.hurtT, shield: p.shield, boost: p.boost,
    vy: p.vy, dying: p.dying, done: W.done, finished: s.finished };
}
export function worldEvents(a, b) {
  if (!a || !b) return [];
  const ev = [];
  if (b.stomps > a.stomps) ev.push("stomp");
  else if (b.vy < a.vy - 3 && b.vy < 0 && !b.dying) ev.push("jump");
  if (b.coins > a.coins) ev.push("coin");
  if (b.blocks > a.blocks) ev.push("coin");
  if (b.powers > a.powers || (b.shield && !a.shield) || b.boost > a.boost + 100 || (b.high && !a.high)) ev.push("power");
  if (b.hits > a.hits) ev.push("death");
  else if (b.hurtT > a.hurtT + 30 && !b.dying) ev.push("hurt");
  if (b.cp > a.cp) ev.push("checkpoint");
  if (b.done && !a.done) ev.push(b.finished ? "flag" : "timeup");
  return ev;
}

// ---------- the music: an original loop, C major, 140 bpm, 16 bars of eighth notes ----------
// Notes as MIDI numbers, 0 = rest; each array entry is one eighth. Written for this game; chords I-vi-IV-V and I-iii-IV-V-ish turns.
export const BPM = 140;
const LEAD = [
  72, 0, 76, 79, 0, 79, 77, 76,   74, 0, 74, 77, 76, 74, 72, 0,
  69, 0, 72, 76, 0, 74, 72, 69,   71, 72, 74, 0, 67, 0, 0, 0,
  65, 0, 69, 72, 0, 72, 74, 72,   71, 0, 67, 71, 74, 0, 79, 77,
  76, 0, 72, 0, 74, 76, 77, 79,   81, 0, 79, 0, 77, 76, 74, 0,
  72, 0, 76, 79, 0, 79, 77, 76,   74, 0, 74, 77, 76, 74, 72, 0,
  76, 0, 77, 79, 0, 81, 79, 76,   77, 0, 76, 74, 72, 0, 74, 76,
  77, 0, 76, 74, 0, 72, 74, 76,   74, 0, 71, 0, 67, 69, 71, 74,
  72, 0, 67, 0, 64, 67, 72, 0,    84, 0, 0, 0, 0, 0, 0, 0,
];
const ROOTS = [48, 45, 41, 43, 48, 45, 41, 43, 48, 52, 53, 55, 53, 43, 48, 48];   // one per bar: C Am F G C Am F G C E F G F G C C
const BASS = [];
for (const r of ROOTS) BASS.push(r, 0, r + 12, 0, r + 7, 0, r + 12, r + 7);
const HATS = [];
for (let i = 0; i < 16; i++) HATS.push(2, 1, 1, 1, 2, 1, 1, 0);   // 2 = snare-ish, 1 = hat
export const LOOP = { lead: LEAD, bass: BASS, hats: HATS, eighths: LEAD.length };
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

const SKEY = "orange-pill-run-sound";
export const SOUND_MODES = ["on", "fx", "off"];   // music + effects, effects only, nothing
export function makeAudio({ store = null, doc = typeof document !== "undefined" ? document : null } = {}) {
  let mode = "on";
  try { const v = store && store.getItem(SKEY); if (SOUND_MODES.includes(v)) mode = v; } catch (_) { /* no storage */ }
  let ctx = null, master = null, musicBus = null, fxBus = null, noiseBuf = null, timer = null, nextT = 0, idx = 0, playing = false;
  const AC = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;

  function unlock() {   // call from a user gesture
    if (!AC) return false;
    try {
      if (!ctx) {
        ctx = new AC();
        master = ctx.createGain(); master.gain.value = 0.5; master.connect(ctx.destination);
        musicBus = ctx.createGain(); musicBus.gain.value = 0.32; musicBus.connect(master);
        fxBus = ctx.createGain(); fxBus.gain.value = 0.55; fxBus.connect(master);
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0); let x = 1;
        for (let i = 0; i < d.length; i++) { x = (x * 16807) % 2147483647; d[i] = (x / 2147483647) * 2 - 1; }   // its own noise, not Math.random
      }
      if (ctx.state === "suspended" && !(doc && doc.hidden)) ctx.resume();
      return true;
    } catch (_) { return false; }
  }
  function tone(bus, type, f, t, dur, vol, slide = null) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(bus, t, dur, vol, hp = 6000) {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = "highpass"; f.frequency.value = hp;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f); f.connect(g); g.connect(bus); s.start(t); s.stop(t + dur + 0.02);
  }
  const E8 = 60 / BPM / 2;
  function schedule() {
    if (!ctx || !playing) return;
    while (nextT < ctx.currentTime + 0.12) {
      const i = idx % LOOP.eighths, l = LOOP.lead[i], b = LOOP.bass[i], h = LOOP.hats[i];
      if (l) tone(musicBus, "square", hz(l), nextT, E8 * 0.9, 0.16);
      if (b) tone(musicBus, "triangle", hz(b), nextT, E8 * 0.95, 0.42);
      if (h === 2) noise(musicBus, nextT, 0.09, 0.22, 1800); else if (h === 1) noise(musicBus, nextT, 0.03, 0.09, 7000);
      nextT += E8; idx++;
    }
  }
  function startMusic() {
    if (!ctx || mode !== "on") return;
    if (playing) return;
    playing = true; idx = 0; nextT = ctx.currentTime + 0.05;
    schedule(); timer = setInterval(schedule, 25);
  }
  function stopMusic() { playing = false; if (timer) clearInterval(timer); timer = null; }
  function duck() {
    if (!musicBus) return;
    const t = ctx.currentTime;
    musicBus.gain.cancelScheduledValues(t); musicBus.gain.setValueAtTime(0.2, t); musicBus.gain.linearRampToValueAtTime(0.32, t + 0.25);
  }
  const FX = {
    jump: (t) => tone(fxBus, "square", 330, t, 0.16, 0.18, 660),
    coin: (t) => { tone(fxBus, "square", 1318, t, 0.06, 0.15); tone(fxBus, "square", 1976, t + 0.06, 0.16, 0.15); },
    stomp: (t) => { tone(fxBus, "square", 220, t, 0.1, 0.25, 70); noise(fxBus, t, 0.08, 0.2, 900); },
    power: (t) => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(fxBus, "square", f, t + i * 0.055, 0.1, 0.16)),
    hurt: (t) => tone(fxBus, "sawtooth", 440, t, 0.25, 0.18, 110),
    death: (t) => { [494, 466, 440, 392].forEach((f, i) => tone(fxBus, "square", f, t + i * 0.12, 0.13, 0.17)); noise(fxBus, t, 0.3, 0.12, 400); },
    checkpoint: (t) => [784, 988, 1175].forEach((f, i) => tone(fxBus, "triangle", f, t + i * 0.07, 0.14, 0.4)),
    flag: (t) => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(fxBus, "square", f, t + i * 0.1, i === 5 ? 0.5 : 0.12, 0.17)),
    timeup: (t) => [659, 587, 523, 392].forEach((f, i) => tone(fxBus, "triangle", f, t + i * 0.16, 0.2, 0.45)),
  };
  function play(name) {
    if (!ctx || mode === "off" || ctx.state !== "running" || !FX[name]) return;
    try { if (playing) duck(); FX[name](ctx.currentTime + 0.005); } catch (_) { /* never break the game over a sound */ }
  }
  function setMode(m) {
    if (!SOUND_MODES.includes(m)) return mode;
    mode = m;
    try { store && store.setItem(SKEY, m); } catch (_) { /* no storage */ }
    if (mode !== "on") stopMusic();
    if (master) master.gain.value = mode === "off" ? 0 : 0.5;
    return mode;
  }
  const next = () => setMode(SOUND_MODES[(SOUND_MODES.indexOf(mode) + 1) % SOUND_MODES.length]);
  if (doc) doc.addEventListener("visibilitychange", () => { if (!ctx) return; try { if (doc.hidden) ctx.suspend(); else ctx.resume(); } catch (_) {} });
  return { unlock, startMusic, stopMusic, play, setMode, next, get mode() { return mode; }, get state() { return ctx ? ctx.state : "none"; }, get musicOn() { return playing; } };
}
