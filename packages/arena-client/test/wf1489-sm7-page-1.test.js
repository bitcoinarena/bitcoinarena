// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM7-PAGE-1 (state-machine audit round 7, area page): A ROUND FOUND OWED IN ANOTHER FEDERATION IS KEPT WITH THE LOBBY'S INVITE.
//
// The collect record (SM-L2) carries the invite its round's wallet is opened with. The join writes the round's own federation's invite
// (index.html swaps the lobby's for ARENA_FED_LOADS / rememberedInvite when the round is in another federation). The 24 h scan
// findTheRoundsOwed (a restored phrase, a record lost to a full browser) writes `invite: named.federation` - the LOBBY's - for every round
// it finds, whatever federation the round is in. The lock client refuses that invite for the round's federation (lib.rs start: "that invite
// is to federation A, and this round's stake goes into B"), so every look and collect of the record throws for good: collectFailed every
// pass, the payout never redeemed - and the scan never writes the record again (knownBySeed skips a kept round). On the way, openPlayerWallet
// writes the lobby's invite as the remembered invite of the round's federation (rememberInvite before the join).
//
// Drives index.html's own findTheRoundsOwed (lifted), the real findOwedRounds / saveCollect / savedCollects / playerWallet, and a lock client
// fake that checks the invite as lib.rs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { inviteNamesFederation } from '../src/federations.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { pageFunction } from './page-script.js';
import { signedSeats } from './settled-signed.js';   // kanban #2108: seats sign their /settled answers

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const b32 = (n) => new Uint8Array(32).fill(n);
const FED_A = b32(0xa1), FED_B = b32(0xb2);
const INVITE_A = inviteForGuardians(FED_A, [{ url: 'wss://a.example/', peer: 0 }]);
const INVITE_B = inviteForGuardians(FED_B, [{ url: 'wss://b.example/', peer: 0 }]);
const now = BigInt(Date.now());
// a paying round of federation B (the lobby names federation A)
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x13), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
  gameId: b32(0x15), simCoreHash: b32(0x14), startTimeMs: now - 3600000n, entryCloseMs: now - 3600000n + MIN_ENTRY_WINDOW_MS + 600000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: FED_B,
  stakeExpiryBlocks: 144, publicationRelays: ['http://127.0.0.1:9'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), committeeTimeMs: now - 7200000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 1000000n,
  bondMinSats: 50000n, blockTicks: 10800, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(0x31), b32(0x32)],
};
const rid = roundId(round);
const RID = toHex(rid);
const seed = b32(0x51);
const SEED = toHex(seed);
const mine = toHex(refundKeyOf(playerFor({ ...round, id: rid }, { seed, curve: pageCurve }).pubkey));
const NODES = ['http://a.test', 'http://b.test'];

function memStore() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
// the seats: the round settled in the last 24 h pays this phrase's key; its contract answered by id
const seats = async (url) => {
  if (url.includes('/settled')) return new Response(JSON.stringify({ rounds: [{ id: RID, madeMs: Date.now() - 60000, payouts: [mine], refunds: [] }] }), { status: 200 });
  if (url.includes('/round?id=')) return new Response(encodeRoundContract(round), { status: 200 });
  return new Response('no', { status: 404 });
};
// the lock client's own check (lock-client/src/lib.rs LockClient::start): the invite must name the federation the wallet is for
const LockClient = {
  async join(invite, federationHex) {
    if (!inviteNamesFederation(invite, federationHex)) throw new Error(`that invite is to another federation, and this round's stake goes into ${federationHex}`);
    return { async balanceMsat() { return '0'; }, async withdrawableMsat() { return '0'; } };
  },
};

// index.html's own scan, lifted
const SCAN_FROM = '    async function findTheRoundsOwed(named) {';
const SCAN_END = "      } catch (e) { console.error('[arena] owed: ' + e.message); return []; }\n    }\n";
test('wf1489-sm7-page-1: a round of another federation found by the 24 h scan is kept with an invite of ITS federation, and its wallet opens', async () => {
  const storage = memStore();
  storage.setItem('arena.seeds', JSON.stringify([{ hex: SEED }]));
  // the lift: the slice from the function's head to its end
  const html = (await import('node:fs')).readFileSync(PAGE, 'utf8');
  const a = html.indexOf(SCAN_FROM); assert.ok(a > 0, 'index.html holds findTheRoundsOwed');
  const b = html.indexOf(SCAN_END, a); assert.ok(b > a);
  const slice = html.slice(a, b + SCAN_END.length);
  const ARENACLIENT = { ...PL, toHex, fromHex, findOwedRounds: (ask) => PL.findOwedRounds({ ...ask, fetcher: signedSeats(seats).fetcher }) };
  const window = { ARENA_CURVE: pageCurve, ARENA_TRACK: () => {}, ARENA_BROWSER_STORE: () => storage,
    ARENA_FED_LOADS: new Map([[toHex(FED_B), { federation: toHex(FED_B), invite: INVITE_B }]]) };
  let looked = 0;
  const findTheRoundsOwed = pageFunction(PAGE, ['window', 'ARENACLIENT', 'collectSeed', 'vault', 'OWED_LOOKBACK_MS', 'lookThePayout'], [slice], 'return findTheRoundsOwed;')(
    window, ARENACLIENT, () => seed, () => storage, 24 * 3600 * 1000, () => { looked++; });
  // the lobby: federation A's invite, the seats that settled the round
  const found = await findTheRoundsOwed({ federation: INVITE_A, nodes: NODES });
  assert.deepEqual(found, [RID], 'the scan finds the round that pays this phrase');
  assert.equal(looked, 1);
  const rec = PL.savedCollects(storage, { seed })[0];
  assert.ok(rec, 'the found round is kept as a collect record');
  assert.equal(toHex(rec.round.federationId), toHex(FED_B));
  const named = inviteNamesFederation(rec.invite, toHex(FED_B));
  console.log(`FACTS sm7-page-1: round ${RID.slice(0, 8)} in federation ${toHex(FED_B).slice(0, 8)}; record kept with the invite of federation `
    + `${inviteNamesFederation(rec.invite, toHex(FED_A)) ? toHex(FED_A).slice(0, 8) + ' (the lobby\'s)' : named ? toHex(FED_B).slice(0, 8) : 'unknown'}`);
  // THE COLLECT OPENS THE ROUND'S WALLET WITH THE RECORD'S INVITE (roundAsk -> collectIntoPlayerWallet -> playerWallet): it must open
  let err = null;
  try { await PL.playerWallet({ round: rec.round, invite: rec.invite, seed, LockClient, storage }); } catch (e) { err = e.message; }
  console.log(`FACTS sm7-page-1: the payout's wallet ${err ? 'does NOT open: ' + err : 'opens'}; remembered invite of ${toHex(FED_B).slice(0, 8)} names `
    + `${inviteNamesFederation(PL.rememberedInvite(storage, FED_B), toHex(FED_B)) ? 'its own federation' : 'another federation'}`);
  assert.ok(named, 'the collect record of a round in federation B names federation A\'s invite (the lobby\'s): the round\'s wallet can never be opened from it');
  assert.equal(err, null, 'the found round\'s payout can never be collected: every open of its wallet is refused for the invite');
  assert.ok(inviteNamesFederation(PL.rememberedInvite(storage, FED_B), toHex(FED_B)), 'federation B\'s remembered invite is overwritten with federation A\'s');
});

// kanban #2104: a record the scan kept before the fix (the lobby's invite for a round of federation B) is repaired on read, once B's invite is known;
// a round of B with no invite of B known is not kept by the scan (found again later); the remembered invite of B never takes A's
test('kanban #2104: an old record with another federation\'s invite is repaired on read; the remembered invite of B never names A', async () => {
  const storage = memStore();
  storage.setItem('arena.seeds', JSON.stringify([{ hex: SEED }]));
  assert.ok(PL.saveCollect(storage, { roundIdHex: RID, round, invite: INVITE_A, nodes: NODES, seed, order: 0 }));
  const before = PL.savedCollects(storage, { seed })[0];
  // no invite of B known: left as it is (still not B's), nothing made up
  assert.equal(PL.recordsToCollect(storage, { tabSeed: seed }).collectable[0].invite, INVITE_A);
  // B's verified status read: the record now names B, its savedMs unchanged
  const loads = new Map([[toHex(FED_B), { invite: INVITE_B }]]);
  assert.equal(PL.recordsToCollect(storage, { tabSeed: seed, loads }).collectable[0].invite, INVITE_B);
  const after = PL.savedCollects(storage, { seed })[0];
  assert.equal(after.invite, INVITE_B, 'the repair is kept');
  assert.equal(after.savedMs, before.savedMs, 'only the invite is rewritten');
  // the scan's choice with nothing of B known: null (the round is not kept with A's invite)
  assert.equal(PL.inviteForRound({ round, lobby: INVITE_A, loads: null, storage: memStore() }), null);
  assert.equal(PL.inviteForRound({ round, lobby: INVITE_B }), INVITE_B);
  // the remembered invite of B is not overwritten by an open with A's (the join is refused, the memory stays B's)
  const s2 = memStore();
  s2.setItem('arena.federation.invite.' + toHex(FED_B), INVITE_B);
  try { await PL.openPlayerWallet({ federationId: FED_B, invite: INVITE_A, seed, LockClient, storage: s2 }); } catch { /* refused, as lib.rs does */ }
  assert.equal(PL.rememberedInvite(s2, FED_B), INVITE_B);
});
