// AUDIT hosting r3-1: a decide adapter reads the NaN bit pattern the seat's CPU makes (x64: sign set, 0xfff8..; arm64: 0x7ff8..)
// through a Float64Array/Uint8Array view of one buffer - both allowed by the scan and kept by the sandbox's lockdown. The verdict
// then depends on the seat's architecture: the trial (run on one machine) passes it, and a committee of x64 and arm64 seats
// decides the same reveals differently. SAFE: every seat reads the same bits for the same computation (canonical NaN, or no
// way to see them), so an adapter cannot answer by the hardware it runs on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, SINGLE_ENTRY } from '../src/core-sandbox.js';
import { trialRun } from '../src/plugin-trial.js';
import { RESULT_TYPE, PAYOUT_RULE } from '../../arena-protocol/src/manifest.js';

// higher move wins where the CPU's default NaN is the canonical one (arm64, the NaN literal); lower move wins where it is negative (x64)
const ADAPTER = `export const DECIDE = { name: 'arch', decide(moves) {
  const z = moves.length - moves.length;
  const f = new Float64Array(1); f[0] = z / z;
  const flip = new Uint8Array(f.buffer)[7] !== 0x7f;
  const pick = (a, b) => (flip ? a < b : a > b);
  let best = moves[0].move; for (const m of moves) if (pick(m.move, best)) best = m.move;
  const winners = moves.filter((m) => m.move === best).length;
  const out = {}; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS';
  return out; } };
`;
const PROBE = `export const DECIDE = { name: 'probe', decide(moves) {
  const z = moves.length - moves.length;
  const f = new Float64Array(1), u = new Uint8Array(f.buffer);
  f[0] = z / z; const runtime = u[7];
  f[0] = NaN; const literal = u[7];
  return { runtime, literal }; } };
`;
const manifest = { gameName: 'arch', resultType: RESULT_TYPE.HEAD_TO_HEAD, payoutRule: PAYOUT_RULE.RANK_CURVE, players: 2, moveCount: 3, minScore: 2 };
const files = (src) => ({ files: new Map([[SINGLE_ENTRY, src]]), entry: SINGLE_ENTRY });

test('a core sees the same NaN bits on every seat: runtime 0/0 reads as the NaN literal does', () => {
  const box = loadCore(files(PROBE), { name: 'probe' });
  let got; try { got = box.call('decide', { moves: [{ key: 'aa'.repeat(32), move: 0 }], config: {} }); } catch (e) {
    // kanban #3316: or no way to see them - the float array's buffer is refused, on every seat alike
    assert.match(String(e.message), /NaN bits/); return;
  } finally { box.end(); }
  assert.equal(got.runtime, got.literal, `the core reads the CPU's own NaN sign byte 0x${Number(got.runtime).toString(16)} against the literal's 0x${Number(got.literal).toString(16)} - an x64 seat and an arm64 seat read different bits`);
});

test('an adapter answering by the CPU architecture is refused by the trial, or answers as every other seat would', () => {
  const t = trialRun(ADAPTER, manifest);
  const box = loadCore(files(ADAPTER), { name: 'arch' });
  let v; const lo = 'aa'.repeat(32), hi = 'bb'.repeat(32);
  try { v = box.call('decide', { moves: [{ key: lo, move: 0 }, { key: hi, move: 1 }], config: {} }); } catch (e) {
    // kanban #3316: the adapter fails on every seat alike (its float bits are not seen), and the trial refused it
    assert.match(String(e.message), /NaN bits/); assert.equal(t.ok, false, 'the trial passed an adapter whose decide fails'); return;
  } finally { box.end(); }
  // an arm64 seat (canonical NaN) answers move 1 WIN; this seat must answer the same, or the trial must have refused the adapter
  assert.ok(!t.ok || v[hi] === 'WIN', `the trial passed the adapter (${t.cases} cases) and this seat answers move 0 ${v[lo]}, move 1 ${v[hi]} - an arm64 seat answers move 1 WIN`);
});

// kanban #3316: the other ways to the same bits - a float view made on a buffer, and DataView's float writes
const PATHS = `export const DECIDE = { name: 'paths', decide(moves) {
  const z = moves.length - moves.length, nan = z / z, out = {};
  try { new Float64Array(new ArrayBuffer(8)); out.view = 'made'; } catch (e) { out.view = e.name; }
  try { new Float32Array(4).subarray(1).buffer; out.sub = 'read'; } catch (e) { out.sub = e.name; }
  const dv = new DataView(new ArrayBuffer(8)), u = new Uint8Array(8);
  dv.setFloat64(0, nan); out.be = [dv.getUint8(0), dv.getUint8(1), dv.getUint8(7)];
  dv.setFloat64(0, nan, true); out.le = [dv.getUint8(7), dv.getUint8(6), dv.getUint8(0)];
  dv.setFloat32(4, nan); out.f32 = [dv.getUint8(4), dv.getUint8(5)];
  dv.setFloat64(0, -1.5, true); out.plain = dv.getFloat64(0, true);
  try { dv.setFloat64(4, nan); out.bounds = 'wrote'; } catch (e) { out.bounds = e.name; }
  out.ints = new Uint8Array(new Uint16Array([1, 2]).buffer).length + u.length;
  return out; } };
`;
test('no float view on a buffer, no float array\'s buffer, and DataView writes the one canonical NaN', () => {
  const box = loadCore(files(PATHS), { name: 'paths' });
  let got; try { got = box.call('decide', { moves: [{ key: 'aa'.repeat(32), move: 0 }], config: {} }); } finally { box.end(); }
  assert.deepEqual(got, { view: 'TypeError', sub: 'TypeError', be: [0x7f, 0xf8, 0], le: [0x7f, 0xf8, 0], f32: [0x7f, 0xc0], plain: -1.5, bounds: 'RangeError', ints: 12 });
});
