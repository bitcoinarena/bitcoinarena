// THE COUNTER'S CORE (test/cores/counter.js registers it): a file of its own and nothing else, as a node runs a core - in
// its sandbox, importing no module of the node's (kanban #328, spec §0A.6).
// sha256 of a string's UTF-8 bytes, as hex, in the language alone: a core runs in a sandbox with no node:crypto (§0A.6)
const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
  0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70,
  0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
function sha256hex(text) {
  const msg = Array.from(unescape(encodeURIComponent(text)), (c) => c.charCodeAt(0));
  const bits = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 7; i >= 0; i--) msg.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 0xff);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const W = new Array(64);
  const r = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < msg.length; o += 64) {
    for (let t = 0; t < 16; t++) W[t] = (msg[o + 4 * t] << 24) | (msg[o + 4 * t + 1] << 16) | (msg[o + 4 * t + 2] << 8) | msg[o + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const s0 = r(W[t - 15], 7) ^ r(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = r(W[t - 2], 17) ^ r(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) | 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export const CORE = Object.freeze({
  name: 'counter (a second title)',
  // its run length is its config's (R3): a round names it as blockTicks, and the signer node checks it against this
  runTicks: (config = {}) => config.ticks ?? 120,
  INPUT_WORDS: 5,
  start: (seedWord, config = {}) => ({ seed: seedWord | 0, sum: 0, ticks: 0, target: config.target ?? 1000, length: config.ticks ?? 120 }),
  eventsOf: () => ({ count: { liquidations: 0, loads: 0 }, before() {} }),
  step(st, w) {
    if (st.ticks >= st.length) return;
    st.sum = (st.sum + (w[0] | 0)) | 0;
    st.ticks++;
  },
  stateHash: (st) => sha256hex(`counter:${st.seed}:${st.sum}:${st.ticks}:${st.target}:${st.length}`),
  result: (st) => ({ outcome: st.ticks < st.length ? null : (st.sum >= st.target ? 'DELIVERED' : 'FAILED'), score: st.sum, heat: 0 }),
  picture: (st) => ({ x: st.sum, z: st.ticks, heading: 0 }),
});
