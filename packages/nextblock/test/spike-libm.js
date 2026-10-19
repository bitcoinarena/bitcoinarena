// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Spike B, part two: do the engines' transcendental libraries actually agree,
// over a wide sweep rather than four samples?
//
// The specification permits them to differ - "implementation-approximated" -
// and that permission is the entire reason the core is fixed point. If a sweep
// of a million inputs finds no divergence, the design was cautious rather than
// necessary, which is worth knowing. If it finds one, the caution was earned.

const say = (m) => { if (typeof print === 'function') print(m); else console.log(m); };

// FNV-1a over the exact bit patterns, so one differing ULP anywhere changes
// the digest.
let h1 = 0x811c9dc5 | 0, h2 = 0x811c9dc5 | 0;
const view = new DataView(new ArrayBuffer(8));
function eat(v) {
  view.setFloat64(0, v);
  for (let i = 0; i < 8; i++) {
    const b = view.getUint8(i);
    h1 = Math.imul(h1 ^ b, 16777619);
    h2 = Math.imul(h2 ^ (b + i), 16777619);
  }
}

const N = 250000;
let firstBad = -1;
for (let i = 0; i < N; i++) {
  // spread inputs across magnitudes and signs
  const t = (i - (N >> 1)) / 1024;
  eat(Math.sin(t));
  eat(Math.cos(t * 1.37));
  eat(Math.atan2(t, 1 + (i % 97)));
  eat(Math.exp(t / 512));
  eat(Math.log(1 + (i % 100000) / 7));
  eat(Math.pow(1.0000137, i % 65536));
  eat(Math.sqrt(1 + (i % 1000000) / 3));
  eat(Math.tan(t / 3));
}
say('libm ' + (h1 >>> 0).toString(16) + ' ' + (h2 >>> 0).toString(16) + '  (' + N + ' Eingaben x 8 Funktionen)');
