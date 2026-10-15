// THE ITEMS THIS CORE KNOWS (kanban #369, the first in-game item of #365): what an item changes in a run, and the hash a manifest names
// it by - the unlock a purchase pays for. A run is handed the unlocks of the items its entry plays with (adapter.js start); an unlock
// this core does not know changes nothing. Kept beside the hashed state, as the run length is: a run without an item hashes as before.
import { sha256hex } from './sha256.js';
import { BED_LENGTH } from './rules/cargo.js';
import { TOP_SPEED, DRIVE_ACCEL } from './rules/vehicle.js';

/** THE LARGER TRUCK (the owner 2026-10-15: "a larger truck for 500 satoshis. It can load 30% more packages and is slightly faster";
 * the pick the same evening: "Slightly faster is acceleration ... 15% higher acceleration than the stock truck, in the same core
 * units", the top speed not raised): the bed 1.3 times as long (3.9 m: 30 % more room, so the same load fills less of it), the drive
 * acceleration 1.15 times (5.00 m/s^2 at rest against 4.35), and the taper's reference speed set so that flat out, on flat ground, it
 * tops out exactly where the larger truck accepted before it did: 25.30 m/s (tools/measure-large-truck.mjs; the standard truck 24.39).
 * More acceleration alone would have raised that, since the top speed is where the tapered drive meets the drag. */
export const LARGE_TRUCK = Object.freeze({
  id: 'large-truck',
  bedLength: 255590,          // 3.9 m, Q16.16 (BED_LENGTH 196608 x 1.3, floored)
  driveAccel: 327844,         // 5.00 m/s^2, Q16.16 (DRIVE_ACCEL 285082 x 1.15, floored)
  topSpeed: 2235175,          // 34.11 m/s taper reference, Q16.16: flat out 25.297 m/s, the accepted larger truck's (its 2339635 with 285082)
});
/** Its unlock: the hash of what it is, so a manifest names exactly these numbers. */
// ASCII BY HAND: a core runs in a sandbox with no TextEncoder (arena-node core-sandbox.js), and its text here is plain ASCII
const ascii = (t) => Uint8Array.from(t, (c) => c.charCodeAt(0));
export const LARGE_TRUCK_UNLOCK = sha256hex(ascii(`nextblock item large-truck v2: bed ${LARGE_TRUCK.bedLength}, drive ${LARGE_TRUCK.driveAccel}, top speed ${LARGE_TRUCK.topSpeed}`));

/** The truck a run drives: the larger one when its unlocks name it, else null (the standard truck, BED_LENGTH / TOP_SPEED / DRIVE_ACCEL). */
export function truckFor(unlocks = []) {
  const set = new Set((unlocks || []).map((u) => String(u).toLowerCase()));
  return set.has(LARGE_TRUCK_UNLOCK) ? { bedLength: LARGE_TRUCK.bedLength, topSpeed: LARGE_TRUCK.topSpeed, driveAccel: LARGE_TRUCK.driveAccel } : null;
}
export { BED_LENGTH, TOP_SPEED, DRIVE_ACCEL };
