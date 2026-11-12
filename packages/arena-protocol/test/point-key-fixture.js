// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// A FIXTURE KEY THAT IS A CURVE POINT (kanban #1489, #1675): donation recipient keys must be secp256k1 points now (point.js), not
// only 0x02/0x03 || 32 bytes. `pointKey(prefix, fill)` is prefix || 32 bytes of `fill`, its LAST byte stepped up until the x is on
// the curve - so a fixture's key still reads "02a1a1a1..." in every shortened hex a test compares, and is a real key.
import { onCurveX } from '../src/point.js';

export function pointKey(prefix, fill) {
  const x = new Uint8Array(32).fill(fill);
  while (!onCurveX(x)) x[31] = (x[31] + 1) & 0xff;
  return Uint8Array.of(prefix, ...x);
}

/** A copy of a 33-byte fixture key, its last byte stepped up until its x is on the curve (a key that already is one is unchanged). */
export function asPoint(k) {
  const out = Uint8Array.from(k);
  while (!onCurveX(out.subarray(1))) out[32] = (out[32] + 1) & 0xff;
  return out;
}
