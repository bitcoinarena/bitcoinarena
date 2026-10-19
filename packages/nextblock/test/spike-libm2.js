// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
const say = (m) => { if (typeof print === 'function') print(m); else console.log(m); };
const view = new DataView(new ArrayBuffer(8));
function digest(fn, n) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < n; i++) {
    view.setFloat64(0, fn(i));
    for (let k = 0; k < 8; k++) h = Math.imul(h ^ view.getUint8(k), 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const N = 120000;
const fns = {
  sin:   (i) => Math.sin((i - 60000) / 1024),
  cos:   (i) => Math.cos((i - 60000) / 997),
  tan:   (i) => Math.tan((i - 60000) / 3072),
  atan2: (i) => Math.atan2(i - 60000, 1 + (i % 97)),
  exp:   (i) => Math.exp((i - 60000) / 4096),
  log:   (i) => Math.log(1 + i / 7),
  pow:   (i) => Math.pow(1.0000137, i % 65536),
  sqrt:  (i) => Math.sqrt(1 + i / 3),
  cbrt:  (i) => Math.cbrt(1 + i / 3),
  hypot: (i) => Math.hypot(i / 7, 1 + i / 11),
};
let line = '';
for (const k of Object.keys(fns)) line += k + '=' + digest(fns[k], N) + ' ';
say(line);
