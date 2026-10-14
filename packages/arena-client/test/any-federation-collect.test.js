// 2026.0.3 STEP 7 - THE WINNER COLLECTS IN EVERY FEDERATION THAT PAID IT (kanban #348). A round that takes any federation settles one
// transaction per federation; the seats list each with what it paid (/lock-settlement `federations`). The page refunds each payout
// contract to its key into the player's wallet of THAT federation, notes each, and a reload asks only for what is left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redeemPayoutsAcross } from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const rid = b32(0x5f), seed = b32(0x51);
const round = { id: rid, protocolVersion: 3, federationId: new Uint8Array(32), stakeMsat: 1000000n };
const tab = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test('a winner paid in two federations collects each into that federation\'s wallet; a reload asks for nothing twice; a loser for nothing', async () => {
  const winner = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
  const pk = toHex(refundKeyOf(winner.pubkey));
  const listing = { state: 'ACCEPTED', federations: [
    { federation: A, state: 'ACCEPTED', txid: 'a1'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk, msat: '496000' }, { kind: 'signer node', pk: '02' + '11'.repeat(32), msat: '2000' }] } },
    { federation: B, state: 'ACCEPTED', txid: 'b1'.repeat(32), moved: { payouts: [{ kind: 'signer node', pk: '02' + '11'.repeat(32), msat: '4000' }, { kind: 'qualifier', pk, msat: '995000' }] } },
  ] };
  const fetcher = async () => ({ ok: true, status: 200, json: async () => listing });
  const asked = [];
  const clientFor = async (fid) => ({ refund: async (txid, outIdx, fields, secret) => {
    asked.push({ fid, txid, outIdx, msat: JSON.parse(fields).amountMsat, secret });
    return JSON.stringify({ accepted: true });
  } });
  const storage = tab();
  const got = await redeemPayoutsAcross({ round, roundId: rid, seed, curve: pageCurve, storage, nodes: ['http://a'], clientFor, fetcher });
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(asked.map((a) => [a.fid, a.txid.slice(0, 2), a.outIdx, a.msat]), [[A, 'a1', 0, '496000'], [B, 'b1', 1, '995000']]);
  assert.ok(asked.every((a) => a.secret === toHex(winner.secret)), 'each refunded under the winner\'s own key');
  assert.equal(got.collected.reduce((t, c) => t + c.amountMsat, 0n), 1491000n);
  // a reload: both noted, the wallets asked nothing
  asked.length = 0;
  const again = await redeemPayoutsAcross({ round, roundId: rid, seed, curve: pageCurve, storage, nodes: ['http://a'], clientFor, fetcher });
  assert.equal(again.ok, true); assert.equal(asked.length, 0); assert.ok(again.collected.every((c) => c.kept));
  // a federation whose wallet cannot be reached waits; the other is collected
  const half = await redeemPayoutsAcross({ round, roundId: rid, seed, curve: pageCurve, storage: tab(), nodes: ['http://a'], fetcher,
    clientFor: async (fid) => { if (fid === B) throw new Error('federation B is not reachable'); return clientFor(fid); } });
  assert.equal(half.ok, false); assert.equal(half.collected.length, 1); assert.match(half.why, /bbbbbbbb: federation B is not reachable/);
  // a loser: nothing to collect, nothing asked
  asked.length = 0;
  const lost = await redeemPayoutsAcross({ round, roundId: rid, seed: b32(0x52), curve: pageCurve, storage: tab(), nodes: ['http://a'], clientFor, fetcher });
  assert.equal(lost.ok, false); assert.equal(lost.final, true); assert.equal(asked.length, 0);
  console.log(`  collected ${got.collected.map((c) => `${c.federation.slice(0, 4)} ${c.amountMsat}`).join(' + ')} msat; partial: ${half.why}`);
});
