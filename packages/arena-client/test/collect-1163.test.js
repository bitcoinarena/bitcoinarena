// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1163 (the 2026-11-06 state-machine audit): THE COLLECT - one seat's word finalised it, and a partial collect marked it done.
//
// Each test asks what the page asks (lookOwed, then collectIntoPlayerWallet's answer into markCollectDone, then tidyStorage) with seats
// that lie, and asserts what must hold. On the old source each fails: the measure is the FACTS line each prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { MIN_ENTRY_WINDOW_MS } from '../../arena-protocol/src/constants.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, taggedHash, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf, lockFieldsToJson, lockFieldsFromJson } from '../../arena-protocol/src/stake-lock.js';
import { arenaLockContractId } from '../../arena-protocol/src/arena-lock.js';
import { keyAgg, xonlyOf } from '../../arena-node/src/musig2.js';
import { CORE_HASH } from '../../arena-node/tools/core-hash.mjs';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const now = BigInt(Date.now());
// settlementSlots 2: the settlement's threshold is 2 of 2
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
const player = playerFor({ ...round, id: rid }, { seed, curve: pageCurve });
const mine = toHex(refundKeyOf(player.pubkey));
const CLAIM_SECRET = b32(0x77);
const CLAIM_PK = Uint8Array.from([0x02, ...schnorr.getPublicKey(CLAIM_SECRET)]);
const STORED = 'c0'.repeat(32);   // the contract id the guardians hold at the lock's outpoint
const fields = { paymentImage: { kind: 'point', bytes: Uint8Array.from([0x03, ...b32(0x5e)]) }, amountMsat: 980000n, claimPk: CLAIM_PK, refundPk: refundKeyOf(player.pubkey), expiration: 464 };
const realForfeit = toHex(schnorr.sign(fromHex(STORED), CLAIM_SECRET));
const FAKE = 'ab'.repeat(64);

/**
 * Seats: `say[host]` is what that seat answers - `settled` (its settlement pays `payees`), `forfeit` (a signature, or a refusal text).
 * Every seat names the same lock (findLock).
 */
const seats = (say) => async (url) => {
  const host = new URL(url).host;
  const s = say[host] || {};
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify(s.settled === false ? { state: 'NONE' }
    : { state: 'ACCEPTED', txid: s.txid || 'ef'.repeat(32), moved: { payouts: (s.payees || []).map((pk) => ({ kind: 'qualifier', pk, msat: '978000' })) } }), { status: 200 });
  if (url.includes('/stake-lock')) return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
  if (url.includes('/forfeit')) return /^[0-9a-f]{128}$/.test(String(s.forfeit || '')) ? new Response(JSON.stringify({ signature: s.forfeit, contractId: STORED, claimPk: toHex(CLAIM_PK) }), { status: 200 })
    : new Response(s.forfeit || 'not a qualifier', { status: 409 });
  return new Response('no', { status: 404 });
};
/** The federation as the player wallet reads it: the lock at its outpoint, `blocksLeft` before its expiry; the payout contract held too. */
const wallet = (blocksLeft) => ({
  async lockStatus() { return JSON.stringify({ block_count: 464 - blocksLeft, stored: { contract_id: STORED, blocks_left: blocksLeft } }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; },
});
const look = (say, blocksLeft = 100) => PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: Object.keys(say).map((h) => `http://${h}`), fetcher: seats(say), client: wallet(blocksLeft) });

test('#1163 one seat omitting the player does not make the payout "none" (old: the first ACCEPTED answer was the settlement)', async () => {
  // the liar answers first; the honest seat pays the player
  const lied = await look({ 'liar.test': { payees: [], forfeit: realForfeit }, 'honest.test': { payees: [mine], forfeit: realForfeit } });
  // and two seats that agree the player is not paid outweigh one that says it is
  const agreed = await look({ 'liar.test': { payees: [mine], forfeit: 'nope' }, 'a.test': { payees: [], forfeit: 'nope' }, 'b.test': { payees: [], forfeit: 'nope' } });
  const facts = { liarFirst: lied.payout.state, twoAgreeNone: agreed.payout.state, settledByOne: (await PL.settlementOf({ roundId: rid, nodes: ['http://x.test'], fetcher: seats({ 'x.test': { payees: [] } }), needed: 2 })).ok };
  console.log('  FACTS #1163 settlement:', JSON.stringify(facts));
  assert.equal(lied.payout.state, 'owed', 'one seat omitting the player made the payout final as none');
  assert.equal(agreed.payout.state, 'none');
  assert.equal(facts.settledByOne, false, 'one seat\'s answer was taken where the round\'s threshold is two');
});

test('#1163 a forfeit whose signature does not verify is not "owed": the next seat is asked, and past the expiry the refund is owed (old: the first 128 hex taken, redeemed for ever)', async () => {
  const faked = await look({ 'liar.test': { payees: [mine], forfeit: FAKE }, 'b.test': { payees: [mine], forfeit: 'that run is inside its window' } });
  const next = await look({ 'liar.test': { payees: [mine], forfeit: FAKE }, 'b.test': { payees: [mine], forfeit: realForfeit } });
  const expired = await look({ 'liar.test': { payees: [mine], forfeit: FAKE }, 'b.test': { payees: [mine], forfeit: FAKE } }, 0);
  const facts = { fakeOnly: `${faked.stake.state}/${faked.stake.how || ''}`, fakeThenReal: `${next.stake.state}/${next.stake.how}`, fakePastExpiry: `${expired.stake.state}/${expired.stake.how}` };
  console.log('  FACTS #1163 forfeit:', JSON.stringify(facts));
  assert.notEqual(faked.stake.state, 'owed', 'a forfeit that does not verify made the stake owed');
  assert.deepEqual([next.stake.state, next.stake.how], ['owed', 'forfeit']);
  assert.deepEqual([expired.stake.state, expired.stake.how], ['owed', 'refund'], 'past its expiry the stake is the player key\'s, and the fake forfeit kept it from the refund');
  // AN ARENA LOCK'S FORFEIT: the BIP-327 aggregate of the named signers' keys, checked here (forfeitCheck)
  const secrets = [1n, 2n, 3n, 5n, 7n];
  const keyOf = (k) => schnorr.getPublicKey(Uint8Array.from(Buffer.from(k.toString(16).padStart(64, '0'), 'hex')));
  const arena = lockFieldsFromJson({ paymentImage: { kind: 'point', bytes: toHex(fields.paymentImage.bytes) }, amountMsat: '980000', expiration: 464, roundId: toHex(rid),
    claimKeys: [1n, 2n, 3n, 4n, 5n, 6n, 7n].map((k) => toHex(keyOf(k))), threshold: 5, refundPk: toHex(fields.refundPk) });
  const sig = aggregateSign(arenaLockContractId(arena), secrets);
  const check = PL.forfeitCheck ? PL.forfeitCheck({ curve: pageCurve, fields: arena }) : null;
  assert.ok(check, 'no forfeit check');
  assert.equal(check({ signature: toHex(sig), signers: [0, 1, 2, 4, 6] }), true, 'a real named forfeit did not verify');
  assert.equal(check({ signature: toHex(sig), signers: [0, 1, 2, 3, 6] }), false, 'a forfeit verified for other signers than signed it');
  assert.equal(check({ signature: FAKE, signers: [0, 1, 2, 4, 6] }), false);
  // the key it checks against is the seats' own KeyAgg (arena-node musig2.js), not one of this test's making
  const seatKey = xonlyOf(keyAgg([0, 1, 2, 4, 6].map((i) => Uint8Array.from([0x02, ...arena.claimKeys[i]]))));
  assert.equal(schnorr.verify(sig, arenaLockContractId(arena), seatKey), true, 'the page\'s aggregate is not the seats\'');
});

test('#1163 "lost" on the seats\' error text never closes the round while the lock is held: waiting, and past the expiry the refund is owed (old: lost, final)', async () => {
  const say = { 'a.test': { payees: [], forfeit: 'that run is FAILED with score 0 and this round\'s minimum is 1: not a qualifier' },
    'b.test': { payees: [], forfeit: 'that run is FAILED with score 0 and this round\'s minimum is 1: not a qualifier' } };
  const held = await look(say, 100);
  const expired = await look(say, 0);
  const facts = { held: `${held.stake.state} final=${held.final}`, expired: `${expired.stake.state}/${expired.stake.how} final=${expired.final}` };
  console.log('  FACTS #1163 lost:', JSON.stringify(facts));
  assert.equal(held.final, false, 'the seats\' "with score" text closed a round whose stake is still in its lock');
  assert.equal(held.stakeLost, true, 'the seats said the run lost, and the look does not say so');
  assert.deepEqual([expired.stake.state, expired.stake.how], ['owed', 'refund']);
});

test('#1163 a partial collect does not mark the record done, and its lock wallet is not removed (old: done, and tidyStorage removed the wallet an hour later)', async () => {
  const m = new Map();
  const storage = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const ridHex = toHex(rid);
  PL.saveCollect(storage, { roundIdHex: ridHex, round, invite: 'fed11x', nodes: ['http://a.test'], seed, stakeLock: null });
  const lockdb = `arena.lockdb.${ridHex.slice(0, 16)}.${toHex(sha256(PL.lockSecretFor(seed, rid))).slice(0, 16)}.k`;   // the wallet lockStoreFor names (kanban #1265)
  m.set(lockdb, 'notes');
  // THE LOOK: payout owed, stake still waiting; THE COLLECT: the payout came in
  const lo = { payout: { state: 'owed', msat: 978000n }, stake: { state: 'waiting', msat: 980000n, why: 'inside its window' }, payoutMsat: 978000n, stakeMsat: 0n, refundMsat: 0n, owedMsat: 978000n, inTabMsat: 0n, final: false };
  const co = { collected: true, creditedMsat: 978000n, got: { payout: { ok: true, final: true }, stake: null, refund: null } };
  // the page's call, as index.html makes it
  const marked = PL.markCollectDone(storage, ridHex, { payout: PL.owedToLine(lo), stake: null }, seed, 0, { look: lo, co });
  // an hour and more later, the tidy
  const rec = [...m].find(([k]) => k.startsWith('arena.collect.'));
  const r = JSON.parse(rec[1]); m.set(rec[0], JSON.stringify({ ...r, savedMs: Date.now() - 2 * 3600000 }));
  PL.tidyStorage(storage, { seeds: [toHex(seed)], current: toHex(seed) });
  // A RECORD AN OLDER PAGE MARKED DONE (no tabMsat) KEEPS ITS WALLET TOO, until the browser is full
  m.set(rec[0], JSON.stringify({ ...JSON.parse(m.get(rec[0])), done: { payout: 'x', stake: null } }));
  PL.tidyStorage(storage, { seeds: [toHex(seed)], current: toHex(seed) });
  const keptLegacy = m.has(lockdb);
  const facts = { marked, done: !!JSON.parse(m.get(rec[0])).done, lockWalletKept: m.has(lockdb), state: PL.collectState ? PL.collectState(lo, co) : null };
  console.log('  FACTS #1163 partial collect:', JSON.stringify(facts));
  assert.equal(marked, false, 'a collect of the payout alone marked the round done with its stake still in its lock');
  assert.equal(keptLegacy, true, 'the round\'s lock wallet was removed under a record that never read it empty');
  // AND ONCE EVERY PART IS FINAL AND THE WALLET EMPTY: done, with the wallet's 0 written, and the tidy may take the wallet
  const all = { ...lo, stake: { state: 'owed', how: 'forfeit', msat: 980000n }, stakeMsat: 980000n };
  const coAll = { collected: true, got: { payout: { ok: true }, stake: { ok: true }, refund: null } };
  assert.equal(PL.markCollectDone(storage, ridHex, { payout: 'all', stake: null }, seed, 0, { look: all, co: coAll }), true);
  assert.equal(JSON.parse(m.get(rec[0])).done.tabMsat, '0');
  m.set(rec[0], JSON.stringify({ ...JSON.parse(m.get(rec[0])), savedMs: Date.now() - 2 * 3600000 }));
  PL.tidyStorage(storage, { seeds: [toHex(seed)], current: toHex(seed) });
  assert.equal(m.has(lockdb), false, 'a done round whose wallet read empty kept its wallet for good');
});

/** A BIP-327 aggregate signature by `secrets` (each key lifted to 02 || x, in order, no tweak) over `msg`. */
function aggregateSign(msg, secrets) {
  const n = secp256k1.Point.Fn.ORDER;
  const evenSecret = (k) => (secp256k1.Point.BASE.multiply(k).toAffine().y & 1n ? n - k : k);
  const pks = secrets.map((k) => Uint8Array.from([0x02, ...schnorr.getPublicKey(Uint8Array.from(Buffer.from(k.toString(16).padStart(64, '0'), 'hex')))]));
  const cat = (ps) => Uint8Array.from(Buffer.concat(ps.map((p) => Buffer.from(p))));
  const list = taggedHash('KeyAgg list', cat(pks));
  const second = pks.find((p) => toHex(p) !== toHex(pks[0]));
  const coef = (p) => (second && toHex(p) === toHex(second) ? 1n : BigInt('0x' + toHex(taggedHash('KeyAgg coefficient', cat([list, p])))) % n);
  const d = secrets.reduce((t, k, i) => (t + coef(pks[i]) * evenSecret(k)) % n, 0n);
  return schnorr.sign(msg, Uint8Array.from(Buffer.from(d.toString(16).padStart(64, '0'), 'hex')));
}
// KANBAN #1220 (audit 3 #1210 PAGE-1): the payout and stake notes were keyed by round and order only, so a second phrase of this browser in
// the same round (two tabs are two players; both enter a game round as order 0) read the first phrase's note as its own: its payout and stake
// "collected", its record closed while both stayed in their contracts. Now a note names the phrase's refund key; an old-shape note is not read.
test('#1220 another phrase\'s note in the same round is not this phrase\'s: its payout stays owed (old: collected)', async () => {
  const kept = new Map();
  const storage = { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
  const seedQ = b32(0x52);
  const mineQ = toHex(refundKeyOf(playerFor({ ...round, id: rid }, { seed: seedQ, curve: pageCurve }).pubkey));
  const note = JSON.stringify({ ok: true, txid: 'ef'.repeat(32), outIdx: 0, amountMsat: '978000' });
  kept.set(`arena.payout.${toHex(rid)}`, note);                          // phrase Q's note as the old page wrote it
  kept.set(`arena.stakeback.${toHex(rid)}`, note);
  kept.set(`arena.payout.${toHex(rid)}.${mineQ.slice(0, 16)}`, note);    // and as this page writes it
  const say = { 'a.test': { payees: [mine, mineQ], forfeit: realForfeit }, 'b.test': { payees: [mine, mineQ], forfeit: realForfeit } };
  const nodes = Object.keys(say).map((h) => `http://${h}`);
  const p = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes, fetcher: seats(say), client: wallet(100), storage });
  const q = await PL.lookOwed({ round, roundId: rid, seed: seedQ, curve: pageCurve, nodes, fetcher: seats(say), client: wallet(100), storage });
  console.log('  FACTS #1220:', JSON.stringify({ p: { payout: p.payout.state, stake: p.stake && p.stake.state }, q: { payout: q.payout.state } }));
  assert.equal(p.payout.state, 'owed', 'phrase P read phrase Q\'s note as its own payout collected');
  assert.notEqual(p.stake && p.stake.state, 'collected', 'phrase P read phrase Q\'s stake note as its own');
  assert.equal(q.payout.state, 'collected', 'phrase Q still reads its own note');
});

// KANBAN #1238 (audit 2 #1204 CLIENT-1): one seat lists an invented lock first (its own claim key, a made-up outpoint) and signs its forfeit;
// the guardians hold only the real lock. The look forfeited locks[0] and read the stake "owed by forfeit" for good; the expiry refund was never asked.
const LIAR_SECRET = b32(0x66);
const fakeFields = { ...fields, claimPk: Uint8Array.from([0x02, ...schnorr.getPublicKey(LIAR_SECRET)]) };
const REAL_AT = `${'cd'.repeat(32)}:0`, FAKE_AT = `${'aa'.repeat(32)}:0`;
const liarSeats = ({ honestAnswers = true } = {}) => async (url) => {
  const host = new URL(url).host;
  if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [] } }), { status: 200 });
  if (url.includes('/stake-lock')) {
    if (host === 'liar.test') return new Response(JSON.stringify([{ entryId: 'ff'.repeat(32), outpoint: FAKE_AT, fields: lockFieldsToJson(fakeFields), contractId: 'f0'.repeat(32) }]), { status: 200 });
    if (!honestAnswers) throw new Error('timed out');
    return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: REAL_AT, fields: lockFieldsToJson(fields), contractId: STORED }]), { status: 200 });
  }
  if (url.includes('/forfeit')) {
    // the liar signs a forfeit of its own lock; nobody forfeits the real one (the player lost)
    if (host === 'liar.test' && url.includes(`entry=${'ff'.repeat(32)}`)) return new Response(JSON.stringify({ signature: toHex(schnorr.sign(fromHex('f0'.repeat(32)), LIAR_SECRET)), contractId: 'f0'.repeat(32), claimPk: toHex(fakeFields.claimPk) }), { status: 200 });
    return new Response('that run is FAILED with score 0 and this round\'s minimum is 1: not a qualifier', { status: 409 });
  }
  return new Response('no', { status: 404 });
};
// the guardians hold the real lock only, `blocksLeft` before its expiry
const realOnly = (blocksLeft) => ({
  async lockStatus(txid, outIdx) { return JSON.stringify({ block_count: 464 - blocksLeft, stored: `${txid}:${outIdx}` === REAL_AT ? { contract_id: STORED, blocks_left: blocksLeft } : null }); },
  async withdrawableMsat() { return '0'; }, async balanceMsat() { return '0'; },
});

test('#1238 an invented lock listed first is not forfeited in place of the real one: past the expiry the refund is owed; the liar alone is not "gone" while the real lock is held', async () => {
  const lookWith = (fetcher, blocksLeft, extra = {}) => PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: ['http://liar.test', 'http://honest.test'], fetcher, client: realOnly(blocksLeft), ...extra });
  const expired = await lookWith(liarSeats(), 0);
  const held = await lookWith(liarSeats(), 100);
  const alone = await lookWith(liarSeats({ honestAnswers: false }), 0, { kept: { lock: { outpoint: { txid: fromHex('cd'.repeat(32)), outIdx: 0n }, fields } } });
  const facts = { expired: `${expired.stake.state}/${expired.stake.how || ''}`, held: `${held.stake.state}/${held.stake.how || ''} final=${held.final}`, liarAlone: `${alone.stake.state}/${alone.stake.how || ''} final=${alone.final}` };
  console.log('  FACTS #1238:', JSON.stringify(facts));
  assert.deepEqual([expired.stake.state, expired.stake.how], ['owed', 'refund'], 'the liar\'s forfeit of its own lock stood in for the real one');
  assert.notEqual(held.stake.how, 'forfeit', 'inside the expiry the stake waits, it is not owed by the liar\'s forfeit');
  assert.equal(held.final, false);
  assert.notEqual(alone.stake.state, 'gone', 'the liar alone made a held stake read gone');
  assert.equal(alone.final, false);
});

// KANBAN #1250 (audit 3 #1210 FIXES-16): with no saved lock in this browser, one seat answering [] made the stake "none" - final - while the round's own
// seats timed out and the lock was still held
test('#1250 no saved lock: one seat\'s empty answer while the others time out is "waiting", not the final "none"; the threshold of answers is "none"', async () => {
  const fetcherOf = (emptyHosts) => async (url) => {
    const host = new URL(url).host;
    if (url.includes('/lock-settlement')) return new Response(JSON.stringify({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [] } }), { status: 200 });
    if (url.includes('/stake-lock')) { if (emptyHosts.includes(host)) return new Response('[]', { status: 200 }); throw new Error('timed out'); }
    return new Response('no', { status: 404 });
  };
  const lookWith = (emptyHosts) => PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: ['http://a.test', 'http://b.test'], fetcher: fetcherOf(emptyHosts), client: wallet(100) });
  const one = await lookWith(['a.test']);
  const both = await lookWith(['a.test', 'b.test']);
  console.log('  FACTS #1250:', JSON.stringify({ oneAnswered: `${one.stake.state} final=${one.final}`, bothAnswered: `${both.stake.state} final=${both.final}` }));
  assert.equal(one.stake.state, 'waiting', 'one seat\'s [] closed the stake as none');
  assert.equal(one.final, false);
  assert.equal(both.stake.state, 'none');
});

// KANBAN #1251 (audit 3 #1210 FIXES-14): the collect record was a raw setItem; refused for quota, a saved stake lock had no collect record at all
test('#1251 a collect record refused for quota is kept once the storage-full handler made room', () => {
  const m = new Map(); let refuse = 1;
  const storage = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), removeItem: (k) => m.delete(k),
    setItem: (k, v) => { if (k.startsWith('arena.collect.') && refuse > 0) { refuse--; const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); } };
  let freed = 0;
  PL.onStorageFull(() => { freed++; });
  try {
    const saved = PL.saveCollect(storage, { roundIdHex: toHex(rid), round, invite: 'fed11x', nodes: ['http://a.test'], seed, stakeLock: null });
    const kept = PL.savedCollects(storage, { seed }).length;
    console.log('  FACTS #1251:', JSON.stringify({ saved, freed, kept }));
    assert.equal(saved, true); assert.equal(freed, 1); assert.equal(kept, 1, 'the collect record was lost to the quota');
  } finally { PL.onStorageFull(null); }
});

// KANBAN #1255 (audit 3 #1210 FIXES-15): a record the pre-#1163 page marked done (the payout redeemed, the stake's forfeit not signed yet) was
// skipped by every pass and never looked at again - its stake stayed in its lock until a manual Rescan. Now such a done (no tabMsat) is opened
// once, the next pass looks at it, and it is written done again only when collectState says so.
test('#1255 a done written by an older page (no tabMsat) is opened once and its stake is found owed; a done read by collectState stays done', async () => {
  const m = new Map();
  const storage = { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  const ridHex = toHex(rid);
  PL.saveCollect(storage, { roundIdHex: ridHex, round, invite: 'fed11x', nodes: ['http://a.test'], seed, stakeLock: null });
  PL.saveCollect(storage, { roundIdHex: ridHex, round, invite: 'fed11x', nodes: ['http://a.test'], seed, stakeLock: null, order: 1 });
  const [legacyKey, newKey] = [...m.keys()].filter((k) => k.startsWith('arena.collect.')).sort();
  m.set(legacyKey, JSON.stringify({ ...JSON.parse(m.get(legacyKey)), done: { payout: '978 sat collected', stake: null } }));
  m.set(newKey, JSON.stringify({ ...JSON.parse(m.get(newKey)), done: { payout: 'all', stake: 'all', tabMsat: '0' } }));
  const skippedBefore = PL.savedCollects(storage, { seed }).filter((r) => !r.done).length;
  const opened = PL.reopenUncheckedDone(storage);
  const openAfter = PL.savedCollects(storage, { seed }).filter((r) => !r.done).map((r) => r.order);
  // the pass's look of the reopened record: the payout already in, the stake's forfeit signed now - owed
  const lo = await look({ 'a.test': { payees: [mine], forfeit: realForfeit }, 'b.test': { payees: [mine], forfeit: realForfeit } });
  // once per record: a second open (another tab, a reload) leaves it, and a done written again without tabMsat is not opened a third time
  const again = PL.reopenUncheckedDone(storage);
  m.set(legacyKey, JSON.stringify({ ...JSON.parse(m.get(legacyKey)), done: { payout: 'x', stake: null } }));
  const third = PL.reopenUncheckedDone(storage);
  const facts = { skippedBefore, opened, openAfter, stake: `${lo.stake.state}/${lo.stake.how}`, again, third, newStillDone: !!JSON.parse(m.get(newKey)).done };
  console.log('  FACTS #1255:', JSON.stringify(facts));
  assert.equal(skippedBefore, 0, 'both records start done');
  assert.equal(opened, 1, 'the older page\'s done was not opened again');
  assert.deepEqual(openAfter, [0], 'only the done without tabMsat is open');
  assert.deepEqual([lo.stake.state, lo.stake.how], ['owed', 'forfeit'], 'the stake of the reopened record is owed');
  assert.equal(again, 0); assert.equal(third, 0, 'a record was opened more than once');
  assert.equal(facts.newStillDone, true, 'a done read by collectState was opened');
});

// KANBAN #1265 (audit 4 #1257 CLIENT-1 path e): a look whose client cannot read the round wallet's balance (a Rescan's `{ lockStatus }` wrapper for a round
// another tab holds) read inTabMsat 0, and the record was marked done with the wallet's 0 - the tidy then removed a wallet that held e-cash.
test('#1265 a look that never read the round wallet says so (null), and that is not "done"', async () => {
  const say = { 'a.test': { payees: [], forfeit: 'not a qualifier' }, 'b.test': { payees: [], forfeit: 'not a qualifier' } };
  const wrapper = { lockStatus: wallet(0).lockStatus };
  const lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: Object.keys(say).map((h) => `http://${h}`), fetcher: seats(say), client: wrapper });
  const full = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: Object.keys(say).map((h) => `http://${h}`), fetcher: seats(say), client: wallet(0) });
  const facts = { wrapper: { inTabMsat: lo.inTabMsat === null ? null : String(lo.inTabMsat), state: PL.collectState(lo, null).state }, fullClient: { inTabMsat: String(full.inTabMsat), state: PL.collectState(full, null).state } };
  console.log('  FACTS #1265 look:', JSON.stringify(facts));
  assert.equal(lo.inTabMsat, null, 'a wallet never read was read empty');
  assert.notEqual(PL.collectState(lo, null).state, 'done');
  assert.equal(full.inTabMsat, 0n);
});

// KANBAN #1273 (audit 4 #1257 seats-5): findLock kept only the first seat's copy of each outpoint - one seat listed first answered the real lock's
// outpoint with a field changed, the honest copies were dropped, and a restored seed's stake read not owed. Every version is kept now.
test('#1273 a seat listed first that answers the real outpoint with a changed claim key does not hide the real lock: its stake is owed by forfeit', async () => {
  const other = Uint8Array.from([0x02, ...schnorr.getPublicKey(b32(0x78))]);
  const shadow = (say) => async (url) => {
    const host = new URL(url).host;
    if (url.includes('/stake-lock')) {
      const f = host === 'liar.test' ? { ...fields, claimPk: other } : fields;
      return new Response(JSON.stringify([{ entryId: 'ee'.repeat(32), outpoint: `${'cd'.repeat(32)}:0`, fields: lockFieldsToJson(f), contractId: STORED }]), { status: 200 });
    }
    return seats(say)(url);
  };
  const say = { 'liar.test': { payees: [mine], forfeit: realForfeit }, 'b.test': { payees: [mine], forfeit: realForfeit } };
  const lo = await PL.lookOwed({ round, roundId: rid, seed, curve: pageCurve, nodes: Object.keys(say).map((h) => `http://${h}`), fetcher: shadow(say), client: wallet(100) });
  const named = await PL.findLock({ roundId: rid, playerPubkey: player.pubkey, nodes: Object.keys(say).map((h) => `http://${h}`), fetcher: shadow(say) });
  console.log('  FACTS #1273:', JSON.stringify({ versionsKept: named.length, stake: `${lo.stake.state}/${lo.stake.how || ''}` }));
  assert.equal(named.length, 2, 'both seats\' versions of the outpoint are kept');
  assert.deepEqual([lo.stake.state, lo.stake.how], ['owed', 'forfeit'], 'the shadowed real lock was not found');
});
