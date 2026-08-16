// Small math / formatting helpers. No dependencies.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const rand = (a = 1, b = null) => (b === null ? Math.random() * a : a + Math.random() * (b - a));
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const TAU = Math.PI * 2;

/** Frame-rate independent exponential approach. */
export const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** Shortest signed angle from a to b. */
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return d;
}

/** Frame-rate independent turn toward a target angle, the short way round. */
export const angleApproach = (a, b, rate, dt) => a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));

export function fmtUsd(v, digits = 0) {
  if (!isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `$${Math.round(v).toLocaleString('en-US')}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * The BTC ticker keeps cents. Rounding to the dollar makes a quiet market look
 * completely frozen even while trades are streaming in.
 */
export function fmtPrice(v) {
  if (!isFinite(v) || !v) return '$—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s | 0}s`;
  if (s < 3600) return `${(s / 60) | 0}m`;
  return `${(s / 3600) | 0}h`;
}

export function fmtNum(v, digits = 0) {
  if (!isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(digits);
}

export function fmtBtc(sats) {
  const btc = sats / 1e8;
  if (btc >= 1) return `${btc.toFixed(3)} BTC`;
  if (btc >= 0.001) return `${btc.toFixed(5)} BTC`;
  return `${Math.round(sats).toLocaleString('en-US')} sats`;
}

export function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function shortId(txid) {
  return txid ? `${txid.slice(0, 6)}…${txid.slice(-4)}` : '??????';
}

/** Deterministic-ish hash -> [0,1), used to give real txids stable "personality". */
export function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Ring buffer of numbers with O(1) push and cheap min/max scans. */
export class Ring {
  constructor(size, fill = 0) {
    this.size = size;
    this.data = new Float64Array(size).fill(fill);
    this.head = 0;
    this.count = size;
  }
  push(v) {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.size;
  }
  /** i = 0 is oldest, size-1 is newest. */
  at(i) {
    return this.data[(this.head + i) % this.size];
  }
  get latest() {
    return this.data[(this.head - 1 + this.size) % this.size];
  }
  minmax() {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < this.size; i++) {
      const v = this.data[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return [lo, hi];
  }
}

/** Tiny event emitter. */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this._h.get(ev).delete(fn);
  }
  emit(ev, payload) {
    const s = this._h.get(ev);
    if (s) for (const fn of s) { try { fn(payload); } catch (e) { console.error(`[${ev}]`, e); } }
  }
}
