// SHA-256 in integer-only JavaScript.
//
// The core cannot use node:crypto (it runs in the browser) or SubtleCrypto (it
// is async, and hashing sits inside a synchronous tick). Everything here is
// 32-bit integer work, which the specification defines exactly.

const K = new Int32Array([
  0x428a2f98|0, 0x71374491|0, 0xb5c0fbcf|0, 0xe9b5dba5|0, 0x3956c25b|0, 0x59f111f1|0,
  0x923f82a4|0, 0xab1c5ed5|0, 0xd807aa98|0, 0x12835b01|0, 0x243185be|0, 0x550c7dc3|0,
  0x72be5d74|0, 0x80deb1fe|0, 0x9bdc06a7|0, 0xc19bf174|0, 0xe49b69c1|0, 0xefbe4786|0,
  0x0fc19dc6|0, 0x240ca1cc|0, 0x2de92c6f|0, 0x4a7484aa|0, 0x5cb0a9dc|0, 0x76f988da|0,
  0x983e5152|0, 0xa831c66d|0, 0xb00327c8|0, 0xbf597fc7|0, 0xc6e00bf3|0, 0xd5a79147|0,
  0x06ca6351|0, 0x14292967|0, 0x27b70a85|0, 0x2e1b2138|0, 0x4d2c6dfc|0, 0x53380d13|0,
  0x650a7354|0, 0x766a0abb|0, 0x81c2c92e|0, 0x92722c85|0, 0xa2bfe8a1|0, 0xa81a664b|0,
  0xc24b8b70|0, 0xc76c51a3|0, 0xd192e819|0, 0xd6990624|0, 0xf40e3585|0, 0x106aa070|0,
  0x19a4c116|0, 0x1e376c08|0, 0x2748774c|0, 0x34b0bcb5|0, 0x391c0cb3|0, 0x4ed8aa4a|0,
  0x5b9cca4f|0, 0x682e6ff3|0, 0x748f82ee|0, 0x78a5636f|0, 0x84c87814|0, 0x8cc70208|0,
  0x90befffa|0, 0xa4506ceb|0, 0xbef9a3f7|0, 0xc67178f2|0,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) | 0;

/** Returns the 32 raw digest bytes. */
export function sha256bytes(bytes) {
  return words(bytes);
}

/** Returns a 64-character lower-case hex digest of the bytes given. */
export function sha256hex(bytes) {
  const w = words(bytes);
  const digits = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i++) out += digits[(w[i] >>> 4) & 15] + digits[w[i] & 15];
  return out;
}

function words(bytes) {
  const len = bytes.length;
  const bitLenHi = Math.floor(len / 536870912);
  const bitLenLo = (len << 3) >>> 0;

  const blocks = ((len + 9 + 63) / 64) | 0;
  const padded = new Uint8Array(blocks << 6);
  padded.set(bytes);
  padded[len] = 128;
  const tail = (blocks << 6) - 8;
  padded[tail] = (bitLenHi >>> 24) & 255;
  padded[tail + 1] = (bitLenHi >>> 16) & 255;
  padded[tail + 2] = (bitLenHi >>> 8) & 255;
  padded[tail + 3] = bitLenHi & 255;
  padded[tail + 4] = (bitLenLo >>> 24) & 255;
  padded[tail + 5] = (bitLenLo >>> 16) & 255;
  padded[tail + 6] = (bitLenLo >>> 8) & 255;
  padded[tail + 7] = bitLenLo & 255;

  let h0 = 0x6a09e667|0, h1 = 0xbb67ae85|0, h2 = 0x3c6ef372|0, h3 = 0xa54ff53a|0;
  let h4 = 0x510e527f|0, h5 = 0x9b05688c|0, h6 = 0x1f83d9ab|0, h7 = 0x5be0cd19|0;
  const w = new Int32Array(64);

  for (let b = 0; b < blocks; b++) {
    const off = b << 6;
    for (let i = 0; i < 16; i++) {
      const j = off + (i << 2);
      w[i] = ((padded[j] << 24) | (padded[j+1] << 16) | (padded[j+2] << 8) | padded[j+3]) | 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) | 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) | 0;
      w[i] = (((w[i-16] + s0) | 0) + ((w[i-7] + s1) | 0)) | 0;
    }
    let a = h0, bb = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) | 0;
      const ch = ((e & f) ^ (~e & g)) | 0;
      const t1 = ((((h + S1) | 0) + ((ch + K[i]) | 0)) + w[i]) | 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) | 0;
      const maj = ((a & bb) ^ (a & c) ^ (bb & c)) | 0;
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    const v = hs[i], o = i << 2;
    out[o] = (v >>> 24) & 255;
    out[o + 1] = (v >>> 16) & 255;
    out[o + 2] = (v >>> 8) & 255;
    out[o + 3] = v & 255;
  }
  return out;
}
