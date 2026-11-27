// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 sm1 page-10 (state-machine audit on 1a7276a5e): A RELOCK (#3665) IS HANDED TO THE GUARDIANS WITH THE INTENT STILL NAMING THE REFUSED
// TRANSACTION. #2459 marks the intent `submitting` and tags the submission so a tab closed while lockSubmit is in flight is found again in the
// wallet's operation log. The relock's submission (tag <submitTag>.r1) runs after the intent already holds the first, refused txid: a tab closed
// while the relock is handed on leaves an intent that names tx1, so the next PLAY never asks the operation log (it does so only for an intent
// with no txid), copies tx1 (which holds nothing) aside and locks the stake a second time. The relock's stake, accepted by the guardians, sits
// under the player's refund key named in no record, no orphan copy - never refunded, and the player paid twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { stakeFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { KNOWN_GOOD_GAMES } from '../../arena-protocol/src/known-games.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const CLAIM = Uint8Array.from([0x02, ...b32(0xc1)]);   // arena-node/test/lock-fixture.js CLAIM
const INVITE = 'fed11qgqpw9thwvaz7te3xgmjuvpwxqhrzw' + 'q'.repeat(20);
const now = BigInt(Date.now());
// a pinned game of the known-good list (this branch has no nextblock package): its id, a core it lists, a config of that core
const [GAME_HEX, GAME] = Object.entries(KNOWN_GOOD_GAMES).find(([, g]) => !g.attested && !g.requiredProtocolVersion && g.cores);
const [CORE_HEX, CONFIGS] = Object.entries(GAME.cores)[0];
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: fromHex(CONFIGS[0]), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: fromHex(GAME_HEX), simCoreHash: fromHex(CORE_HEX), startTimeMs: now + MIN_ENTRY_WINDOW_MS, entryCloseMs: now + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 1000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: 10800, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const seed = b32(0x51);
const claimKey = { ok: true, claimPk: CLAIM, ref: b32(0x9a) };
const player = pageCurve.pointX(b32(0x62));
const NOTE_MSAT = 3000000n;
const browser = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m }; };

// the guardians and the lock client (as wallet-stale-spent-3665's fake): `hangOn` = the submission number whose lockSubmit never answers (tab closed)
function federation({ spent = [] } = {}) {
  const spentAtFed = new Set(spent), handedIn = [], byTag = new Map();
  let n = 0, hangOn = 0;
  class Fake {
    static async join(_inv, _fed, _secret, store) {
      const c = new Fake(); c.store = store; c.txs = new Map();
      c.notes = new Map(JSON.parse(store.entries()).filter(([k]) => k.startsWith('aa')).map(([k, v]) => [k, BigInt(parseInt(v, 16))]));
      return c;
    }
    static lockAllowanceMsat(msat) { return String(2000n + BigInt(msat) * 3000n / 1000000n); }
    async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
    async balanceMsat() { return String([...this.notes.values()].reduce((s, v) => s + v, 0n)); }
    async lockSubmittedFor(tag) { const r = byTag.get(tag); return JSON.stringify(r || null); }
    async lockSubmit(point, stakeMsat, hash, feeMsat, claim, refund, delta, _don, tag) {
      const want = BigInt(stakeMsat) + BigInt(hash ? feeMsat : 0);
      const [k] = [...this.notes].find(([, v]) => v >= want) || [];
      if (!k) throw new Error('insufficient funds');
      this.notes.delete(k); this.store.remove(k);
      const no = ++n, txid = no.toString(16).padStart(2, '0').repeat(32);
      const ok = !spentAtFed.has(k);
      if (ok) spentAtFed.add(k);
      handedIn.push({ txid, notes: [k], ok, tag, stakeMsat: String(stakeMsat) });
      if (tag) byTag.set(tag, { txid, operation: `op${no}` });
      this.txs.set(txid, { ok, notes: [k] });
      if (no === hangOn) return new Promise(() => {});     // handed to the guardians; the tab is closed before the lock client answers
      const exp = 1000 + delta;
      const outputs = [{ out_idx: 0, role: 'stake', computed_contract_id: `s${no}`, computed_expiration: exp, amount_msat: Number(stakeMsat) }];
      if (hash) outputs.push({ out_idx: 1, role: 'fee', computed_contract_id: `f${no}`, computed_expiration: exp, amount_msat: Number(feeMsat) });
      return JSON.stringify({ operation: `op${no}`, txid, block_count_at_lock: 1000, expiry_delta: delta, with_fee: !!hash, outputs });
    }
    async lockAccepted(sub) {
      const s = JSON.parse(sub), tx = this.txs.get(s.txid);
      if (!tx.ok) {
        await new Promise((r) => setTimeout(r, 20));
        for (const k of tx.notes) {
          if (spent.includes(k)) continue;   // fedimint#9497: a spent note dropped, a good one issued back
          setTimeout(() => { this.notes.set(k, NOTE_MSAT); this.store.put(k, NOTE_MSAT.toString(16)); }, 30);
        }
        throw new Error('the guardians did not accept the lock transaction: The transaction had an invalid input: 2-The note is already spent');
      }
      await new Promise((r) => setTimeout(r, 30));
      const one = (o) => ({ txid: s.txid, out_idx: o.out_idx, computed_contract_id: o.computed_contract_id, stored_contract_id: o.computed_contract_id,
        ids_match: true, computed_expiration: o.computed_expiration, stored_expiration: o.computed_expiration, amount_msat: o.amount_msat });
      return JSON.stringify({ stake: one(s.outputs[0]), fee: s.with_fee ? one(s.outputs[1]) : null, donations: [] });
    }
    async lockStatus(txid) { return JSON.stringify({ block_count: 1001, stored: null, txid }); }
  }
  return { LockClient: Fake, handedIn, hang: (no) => { hangOn = no; } };
}

const dealt = () => stakeFor({ ...round, id: rid }, { signerNodes: [0x21, 0x22].map((x) => pageCurve.pointX(b32(x))), curve: pageCurve,
  random: (k) => new Uint8Array(k).fill(9), playerPubkey: player, needed: 2 });
const pageLocks = async (storage, LockClient) => PL.lockStake({ round, roundId: rid, invite: INVITE, seed, stake: await dealt(), claimKey, playerPubkey: player,
  LockClient, storage, keep: true, federationId: round.federationId });

test('sm1 page-10: a tab closed while its relock (#3665) is handed on leaves the relock\'s accepted stake named somewhere, never a second stake over it', async () => {
  const S = browser();
  const st = PL.walletStoreFor(S, TEST_FEDERATION_ID, PL.walletSecretFor(seed, TEST_FEDERATION_ID));
  st.entries();
  for (const k of ['aa01', 'aa02', 'aa03']) st.put(k, NOTE_MSAT.toString(16));   // aa01: kept by a killed tab, the federation counts it spent
  const F = federation({ spent: ['aa01'] });
  F.hang(2);                                                   // the relock's lockSubmit: handed to the guardians, the tab closes
  let firstErr = null; void pageLocks(S, F.LockClient).catch((e) => { firstErr = e; });
  for (let i = 0; i < 100 && F.handedIn.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(F.handedIn.length, 2, `the relock was handed to the guardians (${firstErr && firstErr.message})`);
  const relock = F.handedIn[1];
  assert.equal(relock.ok, true, 'the guardians accepted the relock: its stake is locked under the player\'s refund key');
  // the tab is gone. Two minutes later the player reloads and presses PLAY again (the intent's clock moved past LOCK_INTENT_LIVE_MS)
  const iKey = [...S.m.keys()].find((k) => k.startsWith('arena.lock.intent.'));
  const intent = JSON.parse(S.getItem(iKey));
  console.log(`  FACTS sm1-page-10: handed in ${F.handedIn.map((t) => `${t.txid.slice(0, 4)}[${t.notes}] ${t.ok ? 'accepted' : 'refused'} tag ${String(t.tag).slice(-3)}`).join('; ')}; intent names ${String(intent.txid).slice(0, 4)}`);
  S.setItem(iKey, JSON.stringify({ ...intent, atMs: Number(intent.atMs) - PL.LOCK_INTENT_LIVE_MS - 1000 }));
  // the closed tab's Web Lock went with it: the reloaded page's lock step runs (this process still holds the dead tab's hung request, so the
  // reloaded page's navigator.locks is a fresh one here)
  const hadNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
  let second = null, refused = null;
  try { second = await pageLocks(S, F.LockClient); } catch (e) { refused = e.message; }
  if (hadNav) Object.defineProperty(globalThis, 'navigator', hadNav);
  const named = [...S.m.entries()].filter(([k]) => k.startsWith('arena.lock.orphan.') || k.startsWith('arena.lock.intent.') || k.startsWith('arena.lock.saved.'))
    .some(([, v]) => v.includes(relock.txid));
  console.log(`  FACTS sm1-page-10: second PLAY ${refused ? 'refused: ' + refused.slice(0, 120) : 'locked again'}; handed in now ${F.handedIn.length}; the relock's tx named in a record/orphan copy: ${named}`);
  void second;
  assert.ok(named || refused, `the relock's accepted stake (tx ${relock.txid.slice(0, 8)}) is named in no record or orphan copy while a second stake was locked (${F.handedIn.length} transactions handed in)`);
});
