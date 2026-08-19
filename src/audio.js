// All sound is synthesised with WebAudio — no external assets, so the whole game
// stays a single self-contained static folder.

import { clamp, rand } from './util.js';

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
    this.muted = false;
    this.lastBattle = 0;
  }

  /** Must be called from a user gesture (browser autoplay policy). */
  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.noiseBuf = this._makeNoise();
      this._startAmbience();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.05);
  }

  _makeNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _now() { return this.ctx.currentTime; }

  _env(node, { gain = 0.3, attack = 0.005, decay = 0.2, at = 0 }) {
    const g = this.ctx.createGain();
    const t = this._now() + at;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(this.master);
    return { g, t, stop: t + attack + decay + 0.02 };
  }

  tone(freq, { type = 'sine', gain = 0.25, attack = 0.005, decay = 0.2, at = 0, slideTo = null, detune = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.detune.value = detune;
    const { t, stop } = this._env(o, { gain, attack, decay, at });
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), stop);
    o.start(t); o.stop(stop);
  }

  noise({ gain = 0.3, decay = 0.3, at = 0, filter = 'lowpass', freq = 1200, q = 1, sweepTo = null } = {}) {
    if (!this.ctx || this.muted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bq = this.ctx.createBiquadFilter();
    bq.type = filter; bq.frequency.value = freq; bq.Q.value = q;
    src.connect(bq);
    const { t, stop } = this._env(bq, { gain, attack: 0.004, decay, at });
    if (sweepTo) bq.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), stop);
    src.start(t); src.stop(stop);
  }

  /* ------------------------------------------------------------- ambience */

  _startAmbience() {
    // Distant war rumble: filtered noise bed, very low.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const bq = this.ctx.createBiquadFilter();
    bq.type = 'lowpass'; bq.frequency.value = 180; bq.Q.value = 0.6;
    const g = this.ctx.createGain(); g.gain.value = 0.055;
    src.connect(bq); bq.connect(g); g.connect(this.master);
    src.start();
    this.ambience = g;
    this.ambienceFilter = bq;
  }

  /** intensity 0..1 — driven by volatility / battle activity. */
  setIntensity(v) {
    if (!this.ctx) return;
    const t = this._now();
    this.ambience?.gain.setTargetAtTime(0.03 + v * 0.09, t, 0.6);
    this.ambienceFilter?.frequency.setTargetAtTime(140 + v * 420, t, 0.6);
  }

  /* ---------------------------------------------------------------- sfx */

  /** Small-arms crackle: a snap plus a short tail, pitched randomly. */
  battle(intensity = 0.5) {
    const now = performance.now();
    if (now - this.lastBattle < 70) return;
    this.lastBattle = now;
    const g = 0.05 + intensity * 0.12;
    this.noise({ gain: g, decay: 0.05, freq: rand(1800, 4200), filter: 'bandpass', q: 3 });
    this.noise({ gain: g * 0.7, decay: 0.16, freq: rand(300, 700), filter: 'lowpass', q: 1, sweepTo: 120 });
    this.tone(rand(160, 260), { type: 'square', gain: g * 0.35, decay: 0.05, slideTo: 70 });
  }

  /** Tyres letting go: a bandpassed squeal that rises with how hard you slide. */
  skid(intensity = 0.5) {
    const now = performance.now();
    if (now - (this.lastSkid || 0) < 90) return;
    this.lastSkid = now;
    const g = 0.03 + intensity * 0.09;
    this.noise({ gain: g, decay: 0.22, freq: 900 + intensity * 1400, filter: 'bandpass', q: 6 });
    this.noise({ gain: g * 0.5, decay: 0.3, freq: 260, filter: 'lowpass', q: 1, sweepTo: 140 });
  }

  /** Tank main gun: hard crack, deep body, long tail. */
  cannon(dist = 0.5) {
    const g = clamp(0.5 - dist * 0.3, 0.12, 0.5);
    this.noise({ gain: g, decay: 0.28, freq: 2600, sweepTo: 180, q: 0.8 });
    this.tone(rand(70, 95), { type: 'sine', gain: g * 0.9, decay: 0.7, slideTo: 34 });
    this.noise({ gain: g * 0.35, decay: 1.1, freq: 420, filter: 'lowpass', sweepTo: 90, at: 0.05 });
  }

  /**
   * Bomber engines. Two detuned saws through a lowpass make a convincing prop
   * drone; returns a handle so the plane can fade it as it passes and leaves.
   */
  engine() {
    if (!this.ctx || this.muted) return null;
    const t = this._now();
    const bus = this.ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 620; lp.Q.value = 1.2;
    bus.connect(lp); lp.connect(this.master);

    const oscs = [];
    for (const [f, d] of [[62, -8], [62, 11], [124, 4]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = d;
      const g = this.ctx.createGain(); g.gain.value = f > 100 ? 0.25 : 0.5;
      o.connect(g); g.connect(bus);
      o.start(t);
      oscs.push(o);
    }
    // propeller chop
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 19;
    const lfoGain = this.ctx.createGain(); lfoGain.gain.value = 0.35;
    lfo.connect(lfoGain); lfoGain.connect(bus.gain);
    lfo.start(t);
    oscs.push(lfo);

    return {
      set: (level, pitch = 1) => {
        if (!this.ctx) return;
        const now = this._now();
        bus.gain.setTargetAtTime(Math.max(0.0001, level * 0.5), now, 0.15);
        lp.frequency.setTargetAtTime(420 + pitch * 700, now, 0.2);
        for (const o of oscs) if (o.frequency.value < 200) o.detune.setTargetAtTime((pitch - 1) * 300, now, 0.2);
      },
      stop: () => {
        if (!this.ctx) return;
        const now = this._now();
        bus.gain.setTargetAtTime(0.0001, now, 0.35);
        for (const o of oscs) { try { o.stop(now + 1.6); } catch {} }
      },
    };
  }

  /** Falling-bomb whistle over `dur` seconds. */
  whistle(dur = 1.6) {
    if (!this.ctx || this.muted) return;
    const t = this._now();
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(230, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.13, t + 0.18);
    g.gain.setValueAtTime(0.13, t + dur * 0.75);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** Air-raid siren before a big strike. */
  siren() {
    if (!this.ctx || this.muted) return;
    const t = this._now();
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(380, t);
    o.frequency.linearRampToValueAtTime(620, t + 0.9);
    o.frequency.linearRampToValueAtTime(360, t + 1.9);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.1);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1400;
    o.connect(lp); lp.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 2.2);
  }

  explosion(power = 1) {
    this.noise({ gain: clamp(0.25 * power, 0.05, 0.7), decay: 0.55 + power * 0.5, freq: 900, sweepTo: 60, q: 0.7 });
    this.tone(rand(52, 78), { type: 'sine', gain: 0.4 * power, decay: 0.8, slideTo: 24 });
  }

  stamp() {                      // postal stamp thunk
    this.noise({ gain: 0.18, decay: 0.07, freq: 2600, filter: 'bandpass', q: 3 });
    this.tone(180, { type: 'square', gain: 0.12, decay: 0.06, slideTo: 90 });
  }

  thud() {
    this.tone(120, { type: 'sine', gain: 0.2, decay: 0.14, slideTo: 60 });
    this.noise({ gain: 0.08, decay: 0.08, freq: 400 });
  }

  horn() {
    this.tone(196, { type: 'sawtooth', gain: 0.11, decay: 0.42 });
    this.tone(262, { type: 'sawtooth', gain: 0.08, decay: 0.42, at: 0.03 });
  }

  cash(mult = 1) {               // cash register on delivery
    [880, 1320, 1760].forEach((f, i) =>
      this.tone(f * (1 + (mult - 1) * 0.05), { type: 'triangle', gain: 0.16, decay: 0.18, at: i * 0.045 }));
    this.noise({ gain: 0.1, decay: 0.1, freq: 5200, filter: 'highpass' });
  }

  error() {
    this.tone(220, { type: 'square', gain: 0.14, decay: 0.12, slideTo: 130 });
  }

  click() {
    this.tone(1400, { type: 'triangle', gain: 0.06, decay: 0.04 });
  }

  numberGoUp() {                 // dramatic stinger on strong green candles
    [392, 494, 587, 784].forEach((f, i) =>
      this.tone(f, { type: 'sawtooth', gain: 0.09, decay: 0.3, at: i * 0.07 }));
  }

  numberGoDown() {
    [523, 440, 349, 262].forEach((f, i) =>
      this.tone(f, { type: 'sawtooth', gain: 0.08, decay: 0.32, at: i * 0.075 }));
  }

  blockFound() {                 // bass drop + fanfare
    this.tone(70, { type: 'sine', gain: 0.5, decay: 1.6, slideTo: 32 });
    this.noise({ gain: 0.3, decay: 1.2, freq: 3000, sweepTo: 200 });
    [523, 659, 784, 1047].forEach((f, i) =>
      this.tone(f, { type: 'triangle', gain: 0.16, decay: 0.7, at: 0.25 + i * 0.11 }));
    this.tone(1047, { type: 'triangle', gain: 0.2, decay: 1.2, at: 0.75 });
  }

  whale() {
    this.tone(58, { type: 'sine', gain: 0.35, decay: 1.1, slideTo: 110 });
    this.tone(880, { type: 'triangle', gain: 0.1, decay: 0.5, at: 0.15 });
  }
}
