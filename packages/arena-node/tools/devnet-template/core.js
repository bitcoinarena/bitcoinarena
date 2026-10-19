// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// COIN COUNT, THE DEVNET'S GAME TEMPLATE: THE RULES (kanban #362, PLATFORM-RESEARCH item 15). Copy this directory with
// `devnet.mjs new-game <dir> <name>` and change these rules into your own; every node replays your players' runs with them.
//
// THE CORE RUNS IN A SANDBOX (arena-node/src/core-sandbox.js): no network, no file system, no clock, no Math.random, no
// imports outside its own file. So it is pure integer arithmetic over the round's seed and the player's inputs, and it
// carries its own SHA-256 for the state hash (the engine's integer-only one, arena-protocol/src/sha256.js, copied in below).
// Its id is the SHA-256 of this file: change one byte and it is another core, which a new manifest version must list.
//
// THE GAME: a run is RUN_TICKS ticks; each tick the player presses a number (the first of the five input words), 0 to 9;
// the seed makes some ticks "gold" (worth three times). The score is the sum. A run is DELIVERED once it has run its length.
const RUN_TICKS = 600;
const clamp = (n) => (Number.isInteger(n) && n > 0 ? (n > 9 ? 9 : n) : 0);
// a tick is gold when the seed, mixed with the tick, lands on 0 mod 7 - the same on every machine, from integers only
const gold = (seed, tick) => ((Math.imul(seed ^ tick, 0x9e3779b1) >>> 0) % 7) === 0;

export const CORE = Object.freeze({
  name: 'coin-count',
  /** The longest run a round may ask, and the run when it names none. */
  RUN_TICKS,
  runTicksFits: (t) => Number.isInteger(t) && t >= 1 && t <= RUN_TICKS,
  /** Every tick carries five input words; this game reads the first. */
  INPUT_WORDS: 5,
  /** A run from the round's seed word, ending after the round's run length. */
  start: (seedWord, config, { runTicks } = {}) => ({ seed: seedWord | 0, sum: 0, ticks: 0, length: runTicks === undefined ? RUN_TICKS : runTicks }),
  /** The transcript's own events, applied before the tick they name: this game has none. */
  eventsOf: () => ({ count: { liquidations: 0, loads: 0, samples: 0, tapes: 0 }, before() {} }),
  /** One tick of the player's five words. */
  step(st, words) {
    if (st.ticks >= st.length) return;
    const n = clamp(words[0]);
    st.sum += gold(st.seed, st.ticks) ? 3 * n : n;
    st.ticks += 1;
  },
  /** The state as 32 bytes, hex: what a player's signed checkpoint mark commits to and every replay must reach. */
  stateHash: (st) => sha256hex(bytesOf(st.seed, st.sum, st.ticks, st.length)),
  /** What the run came to: DELIVERED with its score once it ran its length; null while it is still running. */
  result: (st) => ({ outcome: st.ticks < st.length ? null : 'DELIVERED', score: st.sum, heat: 0 }),
});

/** Four 32-bit integers, big-endian. */
function bytesOf(...ints) {
  const out = new Uint8Array(ints.length * 4);
  ints.forEach((v, i) => { out[4 * i] = (v >>> 24) & 255; out[4 * i + 1] = (v >>> 16) & 255; out[4 * i + 2] = (v >>> 8) & 255; out[4 * i + 3] = v & 255; });
  return out;
}

// ---- SHA-256 in integer-only JavaScript, the engine's own (arena-protocol/src/sha256.js) ----
const K = new Int32Array([
  0x428a2f98|0, 0x71374491|0, 0xb5c0fbcf|0, 0xe9b5dba5|0, 0x3956c25b|0, 0x59f111f1|0, 0x923f82a4|0, 0xab1c5ed5|0,
  0xd807aa98|0, 0x12835b01|0, 0x243185be|0, 0x550c7dc3|0, 0x72be5d74|0, 0x80deb1fe|0, 0x9bdc06a7|0, 0xc19bf174|0,
  0xe49b69c1|0, 0xefbe4786|0, 0x0fc19dc6|0, 0x240ca1cc|0, 0x2de92c6f|0, 0x4a7484aa|0, 0x5cb0a9dc|0, 0x76f988da|0,
  0x983e5152|0, 0xa831c66d|0, 0xb00327c8|0, 0xbf597fc7|0, 0xc6e00bf3|0, 0xd5a79147|0, 0x06ca6351|0, 0x14292967|0,
  0x27b70a85|0, 0x2e1b2138|0, 0x4d2c6dfc|0, 0x53380d13|0, 0x650a7354|0, 0x766a0abb|0, 0x81c2c92e|0, 0x92722c85|0,
  0xa2bfe8a1|0, 0xa81a664b|0, 0xc24b8b70|0, 0xc76c51a3|0, 0xd192e819|0, 0xd6990624|0, 0xf40e3585|0, 0x106aa070|0,
  0x19a4c116|0, 0x1e376c08|0, 0x2748774c|0, 0x34b0bcb5|0, 0x391c0cb3|0, 0x4ed8aa4a|0, 0x5b9cca4f|0, 0x682e6ff3|0,
  0x748f82ee|0, 0x78a5636f|0, 0x84c87814|0, 0x8cc70208|0, 0x90befffa|0, 0xa4506ceb|0, 0xbef9a3f7|0, 0xc67178f2|0,
]);
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) | 0;
function sha256hex(bytes) {
  const len = bytes.length;
  const blocks = ((len + 9 + 63) / 64) | 0;
  const padded = new Uint8Array(blocks << 6);
  padded.set(bytes);
  padded[len] = 128;
  const bitLenHi = Math.floor(len / 536870912), bitLenLo = (len << 3) >>> 0, tail = (blocks << 6) - 8;
  for (let i = 0; i < 4; i++) { padded[tail + i] = (bitLenHi >>> (24 - 8 * i)) & 255; padded[tail + 4 + i] = (bitLenLo >>> (24 - 8 * i)) & 255; }
  const h = new Int32Array([0x6a09e667|0, 0xbb67ae85|0, 0x3c6ef372|0, 0xa54ff53a|0, 0x510e527f|0, 0x9b05688c|0, 0x1f83d9ab|0, 0x5be0cd19|0]);
  const w = new Int32Array(64);
  for (let b = 0; b < blocks; b++) {
    const off = b << 6;
    for (let i = 0; i < 16; i++) { const j = off + (i << 2); w[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) | 0; }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) | 0, s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) | 0;
      w[i] = (((w[i - 16] + s0) | 0) + ((w[i - 7] + s1) | 0)) | 0;
    }
    let [a, bb, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) | 0, ch = ((e & f) ^ (~e & g)) | 0;
      const t1 = ((((hh + S1) | 0) + ((ch + K[i]) | 0)) + w[i]) | 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) | 0, maj = ((a & bb) ^ (a & c) ^ (bb & c)) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + ((S0 + maj) | 0)) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + bb) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += (h[i] >>> 0).toString(16).padStart(8, '0');
  return out;
}
