// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3665 (found in #3664): a browser killed seconds after a wallet write (localStorage commits late) reopens with notes the federation
// already counted spent. Every lock that picked one was refused ("The transaction had an invalid input: 2-The note is already spent"), 183 ms
// after its submission (measured, canary 3f539d34) - but the page had already been handed the lock and its entry named the refused outpoint:
// the round VOID, four canary runs in a row. The fake lock client below is the page's: its notes read from the wallet's storage at join, a lock
// spending the first note big enough, and on a refusal the input state machine of fedimint#9497 (build-wasm.sh): the refused transaction's notes
// refunded one by one - a spent one refused and dropped, a good one issued back a little later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { stakeFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { CLAIM } from '../../arena-node/test/lock-fixture.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const INVITE = 'fed11qgqpw9thwvaz7te3xgmjuvpwxqhrzw' + 'q'.repeat(20);
const now = BigInt(Date.now());
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
const player = pageCurve.pointX(b32(0x62));
const NOTE_MSAT = 3000000n;

function browser() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}

/** The wallet as the killed tab left it in storage: `notes` (each NOTE_MSAT); `spent` of them the federation already counted spent. */
function staleWallet(storage, notes) {
  const st = PL.walletStoreFor(storage, TEST_FEDERATION_ID, PL.walletSecretFor(seed, TEST_FEDERATION_ID));
  st.entries();
  for (const k of notes) st.put(k, NOTE_MSAT.toString(16));
}

function federation({ spent = [], otherError = null } = {}) {
  const spentAtFed = new Set(spent);
  const handedIn = [];          // [{ txid, notes }] every transaction a lock client handed the guardians
  const refusedNotes = new Set();
  let n = 0, joins = 0;
  class Fake {
    static async join(_inv, _fed, _secret, store) {
      joins += 1;
      const c = new Fake();
      c.store = store;
      c.notes = new Map(JSON.parse(store.entries()).filter(([k]) => k.startsWith('aa')).map(([k, v]) => [k, BigInt(parseInt(v, 16))]));
      c.txs = new Map();
      return c;
    }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async balanceMsat() { return String([...this.notes.values()].reduce((s, v) => s + v, 0n)); }
    async lockSubmit(point, stakeMsat, hash, feeMsat, claim, refund, delta) {
      const want = BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0);
      const [k] = [...this.notes].find(([, v]) => v >= want) || [];
      if (!k) throw new Error('insufficient funds');
      this.notes.delete(k); this.store.remove(k);   // the inputs leave the wallet with the submission, as mintv2's claim_inputs
      const txid = (++n).toString(16).padStart(2, '0').repeat(32);
      handedIn.push({ txid, notes: [k] });
      const ok = !spentAtFed.has(k) && !otherError;
      if (ok) spentAtFed.add(k);
      this.txs.set(txid, { ok, notes: [k] });
      const exp = 1000 + delta;
      const outputs = [{ out_idx: 0, role: 'stake', computed_contract_id: `s${n}`, computed_expiration: exp, amount_msat: Number(stakeMsat) }];
      if (hash) outputs.push({ out_idx: 1, role: 'fee', computed_contract_id: `f${n}`, computed_expiration: exp, amount_msat: Number(feeMsat) });
      return JSON.stringify({ operation: `op${n}`, txid, block_count_at_lock: 1000, expiry_delta: delta, with_fee: !!hash, outputs });
    }
    async lockAccepted(sub) {
      const s = JSON.parse(sub);
      const tx = this.txs.get(s.txid);
      if (!tx.ok) {
        await new Promise((r) => setTimeout(r, 20));   // the refusal comes at once
        // fedimint#9497: the refused transaction's notes refunded one by one: a spent one refused and dropped, a good one issued back
        for (const k of tx.notes) {
          if (spentAtFed.has(k)) { refusedNotes.add(k); continue; }
          setTimeout(() => { this.notes.set(k, NOTE_MSAT); this.store.put(k, NOTE_MSAT.toString(16)); }, 30);
        }
        throw new Error(otherError || 'the guardians did not accept the lock transaction: The transaction had an invalid input: 2-The note is already spent');
      }
      await new Promise((r) => setTimeout(r, 30));
      const one = (o) => ({ txid: s.txid, out_idx: o.out_idx, computed_contract_id: o.computed_contract_id, stored_contract_id: o.computed_contract_id,
        ids_match: true, computed_expiration: o.computed_expiration, stored_expiration: o.computed_expiration, amount_msat: o.amount_msat });
      return JSON.stringify({ stake: one(s.outputs[0]), fee: s.with_fee ? one(s.outputs[1]) : null, donations: [] });
    }
    async lockStatus(txid) { return JSON.stringify({ block_count: 1001, stored: null, txid }); }
  }
  return { LockClient: Fake, handedIn, refusedNotes, joins: () => joins };
}

const dealt = () => stakeFor({ ...round, id: rid }, { signerNodes: [0x21, 0x22].map((x) => pageCurve.pointX(b32(x))), curve: pageCurve,
  random: (k) => new Uint8Array(k).fill(9), playerPubkey: player, needed: 2 });

/** The page's lock step (index.html): lockStake with `keep`. */
const pageLocks = async (storage, LockClient) => PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake: await dealt(), claimKey, playerPubkey: player,
  LockClient, storage, keep: true, federationId: round.federationId });

test('#3665 a wallet that kept notes the federation counts spent locks again from its good notes before the entry names the lock', async () => {
  const S = browser();
  staleWallet(S, ['aa01', 'aa02', 'aa03', 'aa04']);
  const F = federation({ spent: ['aa01', 'aa02'] });
  const made = await pageLocks(S, F.LockClient);
  const said = await made.accepted.then((a) => a, (e) => ({ refused: e.message }));
  const named = toHex(made.outpoint.txid);
  console.log(`  MEASURED #3665: handed in ${F.handedIn.map((t) => `${t.txid.slice(0, 4)}[${t.notes}]`).join(' ')}; the entry's lock ${named.slice(0, 4)}; `
    + `accepted ${JSON.stringify(said, (k, v) => (typeof v === 'bigint' ? String(v) : v))}; relocked ${made.relocked}`);
  // before the fix: the lock answered was the first one (aa01, spent) and its acceptance refused - the entry named a lock that never existed
  assert.equal(said.ok, true, 'the lock the entry names is accepted');
  const acceptedTx = F.handedIn.find((t) => t.notes.includes('aa03'));
  assert.ok(acceptedTx, 'the good note aa03 was locked');
  assert.equal(named, acceptedTx.txid, 'the lock handed to the page (its entry names it) is the accepted one');
  assert.equal(made.relocked, 2);
  // a note the federation refused is never handed in again
  const counts = new Map();
  for (const t of F.handedIn) for (const k of t.notes) counts.set(k, (counts.get(k) || 0) + 1);
  for (const k of F.refusedNotes) assert.equal(counts.get(k), 1, `${k} handed in once`);
  assert.deepEqual([...F.refusedNotes].sort(), ['aa01', 'aa02']);
  // the spent notes are gone from the wallet's storage; the good ones stay
  const st = PL.walletStoreFor(S, TEST_FEDERATION_ID, PL.walletSecretFor(seed, TEST_FEDERATION_ID));
  assert.deepEqual(JSON.parse(st.entries()).map(([k]) => k).filter((k) => k.startsWith('aa')).sort(), ['aa04']);
  // the kept record names the accepted transaction, not a refused one
  const kept = PL.savedLock(S, { roundId: rid, playerPubkey: player });
  assert.equal(toHex(kept.lock.outpoint.txid), acceptedTx.txid);
});

test('#3665 a wallet with only good notes locks once, as before', async () => {
  const S = browser();
  staleWallet(S, ['aa01', 'aa02']);
  const F = federation();
  const made = await pageLocks(S, F.LockClient);
  assert.equal((await made.accepted).ok, true);
  assert.equal(F.handedIn.length, 1);
  assert.equal(made.relocked, undefined);
});

test('#3665 a wallet whose every note is spent is refused by name - no endless relock', async () => {
  const S = browser();
  staleWallet(S, ['aa01', 'aa02']);
  const F = federation({ spent: ['aa01', 'aa02'] });
  const made = await pageLocks(S, F.LockClient);
  await assert.rejects(made.accepted, /already spent/);
  assert.equal(F.handedIn.length, 2, 'each note handed in once, then refused');
});

test('#3665 a refusal for another reason is not relocked', async () => {
  const S = browser();
  staleWallet(S, ['aa01', 'aa02']);
  const F = federation({ otherError: 'the guardians did not accept the lock transaction: some other reason' });
  const made = await pageLocks(S, F.LockClient);
  await assert.rejects(made.accepted, /some other reason/);
  assert.equal(F.handedIn.length, 1);
});
