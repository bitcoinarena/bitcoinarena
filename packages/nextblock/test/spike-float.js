// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Spike B, part one: is plain floating-point arithmetic identical across
// engines, once the transcendental library is out of the picture?
//
// This is the same question WebAssembly answers by construction. If +,-,*,/
// agree here, then a WASM physics engine's determinism rests only on it
// compiling its own libm in - which it does - and on the four holes named in
// IMPLEMENTATION.md 1.1.

const say = (m) => { if (typeof print === 'function') print(m); else console.log(m); };

// A float-heavy integration that mimics a physics step: velocity, drag, a
// spring, and a chaotic coupling so errors cannot cancel.
let x = 0.1, y = -0.37, vx = 1.9, vy = 0.44;
for (let i = 0; i < 2000000; i++) {
  const ax = -x * 0.7 + vy * 0.013;
  const ay = -y * 0.9 - vx * 0.017;
  vx = (vx + ax * 0.016) * 0.9993;
  vy = (vy + ay * 0.016) * 0.9993;
  x += vx * 0.016;
  y += vy * 0.016;
  if (x > 1e6 || x < -1e6) x *= 0.5;
  if (y > 1e6 || y < -1e6) y *= 0.5;
}

// exact bit patterns, not a rounded printout
const bits = (v) => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v);
  let s = '';
  for (let i = 0; i < 8; i++) s += ('0' + b.getUint8(i).toString(16)).slice(-2);
  return s;
};
say('arith x ' + bits(x));
say('arith y ' + bits(y));
say('arith v ' + bits(vx) + ' ' + bits(vy));

// And the contrast: the library functions the design bans.
say('sin     ' + bits(Math.sin(1.2345678901234)));
say('exp     ' + bits(Math.exp(9.87654321)));
say('pow     ' + bits(Math.pow(1.0000001, 12345678)));
say('sqrt    ' + bits(Math.sqrt(2.3456789)));
