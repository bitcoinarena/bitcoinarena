// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit client r4-2-1: POST /refused-lock and POST /handout of the refused-round return path have no deadline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { stakeFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { CLAIM } from '../../arena-node/test/lock-fixture.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const INVITE = 'fed11qgqpw9thwvaz7te3xgmjuvpwxqhrzw' + 'q'.repeat(20);
const now = BigInt(Date.now());
// no donation chosen: the lock is the stake (and its fee lock) alone
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: CORE_HASH, startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const seed = b32(0x51);
const claimKey = { ok: true, claimPk: CLAIM, ref: b32(0x9a) };
import { playerFor } from '../src/join.js';
const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve }).pubkey;
const who = { roundId: rid, playerPubkey: player };

/** The browser's storage; `room` characters at most, past it a write throws QuotaExceededError as Safari's does. */
function browser(room = Infinity) {
  const m = new Map();
  const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  let peak = 0;
  return { get peak() { return peak; }, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const was = m.has(k) ? k.length + m.get(k).length : 0;
      if (used() - was + k.length + String(v).length > room) { const e = new Error(`Setting the value of '${k}' exceeded the quota.`); e.name = 'QuotaExceededError'; throw e; }
      m.set(k, String(v)); peak = Math.max(peak, used());
    }, removeItem: (k) => { m.delete(k); }, m, set room(r) { room = r; } };
}

const tx = (n) => n.toString(16).padStart(2, '0').repeat(32);
/** A lock client over `fed` (txid -> 'pending' | 'accepted'). `slow`: the guardians have not reached the transaction yet and this tab's
 * acceptance wait never ends (the tab is reloaded before it does). */
function lockClient(fed, { slow = false, first = 1 } = {}) {
  const log = [];
  let n = first - 1;
  class Fake {
    static async join() { return new Fake(); }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    constructor() { this.balance = 10n ** 8n; }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async balanceMsat() { return String(this.balance); }
    async lockSubmit(point, stakeMsat, hash, feeMsat, claim, refund, delta) {
      const txid = tx(++n);
      log.push({ lockSubmit: txid });
      this.balance -= BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0);
      fed.set(txid, slow ? 'pending' : 'accepted');
      const exp = 1000 + delta;
      const outputs = [{ out_idx: 0, role: 'stake', computed_contract_id: 's1', computed_expiration: exp, amount_msat: Number(stakeMsat) }];
      if (hash) outputs.push({ out_idx: 1, role: 'fee', computed_contract_id: 'f1', computed_expiration: exp, amount_msat: Number(feeMsat) });
      return JSON.stringify({ operation: `op${n}`, txid, block_count_at_lock: 1000, expiry_delta: delta, with_fee: !!hash, outputs });
    }
    async lockAccepted(sub) {
      const s = JSON.parse(sub);
      if (fed.get(s.txid) !== 'accepted') return new Promise(() => {});   // the tab is gone before the guardians answer
      const one = (o) => ({ txid: s.txid, out_idx: o.out_idx, computed_contract_id: o.computed_contract_id, stored_contract_id: o.computed_contract_id,
        ids_match: true, computed_expiration: o.computed_expiration, stored_expiration: o.computed_expiration, amount_msat: o.amount_msat });
      return JSON.stringify({ stake: one(s.outputs[0]), fee: s.with_fee ? one(s.outputs[1]) : null, donations: [] });
    }
    async lockStatus(txid) {
      const st = fed.get(txid);
      return JSON.stringify({ block_count: 1200, stored: st === 'accepted' ? { contract_id: 's1', blocks_left: 143 } : st === 'expired' ? { contract_id: 's1', blocks_left: 0 } : null });
    }
    async withdrawableMsat() { throw new Error('Balance is too low to send any amount after fees'); }
    async refund(txid) {
      if (fed.get(txid) !== 'expired') return JSON.stringify({ accepted: false, error: 'not expired' });
      fed.set(txid, 'gone'); return JSON.stringify({ accepted: true });
    }
  }
  return { LockClient: Fake, log };
}
const dealt = () => stakeFor({ ...round, id: rid }, { signerNodes: [0x21, 0x22].map((x) => pageCurve.pointX(b32(x))), curve: pageCurve,
  random: (k) => new Uint8Array(k).fill(9), playerPubkey: player, needed: 2 });
/** THE PAGE'S LOCK STEP (index.html: lockStake with `keep`). */
const pageLocks = (storage, LockClient, stake) => PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake, claimKey, playerPubkey: player, LockClient, storage,
  keep: true, federationId: round.federationId });

const NODES = ['http://honest.test', 'http://hangs.test'];
// The round refused this player's entry (a tap just before close, kanban #2785): no seat names its lock, no settlement pays it.
// The honest seat refuses the hand-over at once; the attacker seat takes POST /refused-lock (and POST /handout) and never answers.
const seats = (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://hangs.test') && opts && opts.method === 'POST') return new Promise(() => {});
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), arrayBuffer: async () => new ArrayBuffer(0) });
  if (u.includes('/lock-settlement')) return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => 'no settlement' });
  if (u.includes('/stake-lock')) return Promise.resolve(ok([]));
  return Promise.resolve({ ok: false, status: 409, json: async () => ({}), text: async () => 'this seat refuses that round' });
};

test('audit client r4-2-1: one seat that never answers POST /refused-lock keeps an expired, unentered stake from ever coming back', async () => {
  const fed = new Map();
  const storage = browser();
  const b = lockClient(fed, { first: 2 });
  const lock = await pageLocks(storage, b.LockClient, await dealt());
  await lock.accepted;
  PL.saveCollect(storage, { roundIdHex: toHex(rid), round, invite: INVITE, nodes: NODES, seed, stakeLock: lock });
  // the lock (and its fee lock) is past its expiry: the player's own key takes it back (§23.2 default path)
  for (const [t] of fed) fed.set(t, 'expired');
  const client = new b.LockClient();
  const BOUND_MS = 40000;   // well past the page's own per-seat read bound (SEAT_READ_MS 15 s)
  let timer;
  const look = await Promise.race([
    PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: NODES, fetcher: seats, client, storage }),
    new Promise((r) => { timer = setTimeout(() => r('HUNG'), BOUND_MS); }),
  ]);
  clearTimeout(timer);
  assert.notEqual(look, 'HUNG', `lookOwed never returned within ${BOUND_MS / 1000} s: the stake (expired, refundable by the player's key) is never owed back while one seat holds POST /refused-lock open`);
  assert.equal(look.stake.state, 'owed');
});
