// THE ARENA LOCK, PROTOCOL 27 (kanban #1044 B1, rulings #1131 and #1134): the contract's bytes and id as the fork's module hashes them, the
// gate, §23.1 step 5 for the named keys, the signer set, the commit's nonces, and offence rows (a) and (b).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex, sha256 } from '../src/hash.js';
import { netStakeMsat } from '../src/payout.js';
import { refundKeyOf } from '../src/stake-lock.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '../src/constants.js';
import { signSettlementCommit, checkSettlementCommit } from '../src/settlement-ack.js';
import {
  zKey, NAMED_CLAIM_VERSION, NAMED_CLAIM_HEIGHT, namedClaimsAt, namedClaimRefusal, runsArenaLock, encodeArenaLockContract, arenaLockContractId,
  arenaLockValid, arenaLockFieldsFromJson, arenaLockFieldsToJson, arenaLockFor, arenaLockMatchesEntry, namedSignerSet, commitNoncesOf,
} from '../src/arena-lock.js';
import { offTableClaims, forfeitsOfLostEntries, OFF_TABLE_CLAIM, FORFEIT_OF_LOST_ENTRY } from '../src/named-claim-offence.js';

const KEYS = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798,c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5,f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9,e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13,2f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe4,fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556,5cbdf0646e5db4eaa398f365f2ea7a0e3d419b7e0330e39ce92bddedcac4f9bc'.split(',').map(fromHex);
const REFUND = fromHex('022f01e5e15cca351daff3843fb70f3c2f0a1bdd05e5af888a67784ef3e10a2a01');
const b32 = (v) => new Uint8Array(32).fill(v);
// the reference lock of the fork's own unit test (fedimint-lnv2-common arena_lock/tests.rs): seats are secrets 1..7, refund secret 8
const reference = () => ({ paymentImage: { kind: 'hash', bytes: sha256(b32(0x42)) }, amountMsat: 1000000n, expiration: 500, fallbackAfter: 400, roundId: b32(0x11),
  claimKeys: KEYS.slice(), threshold: 5, refundPk: REFUND });

test('the contract id is the fork module\'s: tagged hash of the consensus encoding (vector 47842301, with fallback_after since #1281)', () => {
  assert.equal(toHex(arenaLockContractId(reference())), '47842301d8d872a4a6d9a08c5721d4d8ff32c0568ea5dc0fe31ca4f075b3b2c0');
  assert.equal(encodeArenaLockContract(reference()).length, 2 + 32 + 5 + 3 + 3 + 32 + 1 + 7 * 32 + 1 + 33);   // fallback_after 400: BigSize 3 bytes
  const other = { ...reference(), roundId: b32(0x12) };
  assert.notEqual(toHex(arenaLockContractId(other)), toHex(arenaLockContractId(reference())));
  // the JSON the wasm client takes round-trips to the same id
  assert.equal(toHex(arenaLockContractId(arenaLockFieldsFromJson(arenaLockFieldsToJson(reference())))), toHex(arenaLockContractId(reference())));
});

test('protocol 27 at NAMED_CLAIM_HEIGHT, by the census height', () => {
  assert.equal(NAMED_CLAIM_VERSION, 27);
  assert.equal(SUPPORTED_PROTOCOL_VERSIONS.at(-1), NAMED_CLAIM_VERSION);
  assert.deepEqual({ ...NAMED_CLAIM_HEIGHT }, { mainnet: 0, testnet4: null, regtest: 0, devnet: 0 });
  assert.equal(namedClaimsAt('regtest', 0), true);
  assert.equal(namedClaimsAt('testnet4', 999999), false);
  assert.equal(namedClaimsAt('testnet', 999999), false);
  assert.equal(namedClaimsAt('mainnet', 1), true);
  assert.equal(namedClaimsAt('signet', 10), false);
  const at100 = () => 100;
  assert.equal(namedClaimsAt('regtest', 99, at100), false);
  assert.equal(namedClaimsAt('regtest', 100, at100), true);
});

test('the gate: from the height, only a federation a threshold reports at LNv2 >= 1.100', () => {
  assert.equal(runsArenaLock({ major: 1, minor: 100 }), true);
  assert.equal(runsArenaLock({ major: 1, minor: 101 }), true);
  assert.equal(runsArenaLock({ major: 1, minor: 0 }), false);
  assert.equal(runsArenaLock(null), false);
  assert.equal(namedClaimRefusal({ network: 'regtest', censusHeight: 5, version: { major: 1, minor: 100 } }), null);
  assert.match(namedClaimRefusal({ network: 'regtest', censusHeight: 5, version: { major: 1, minor: 0 } }), /does not run it: LNv2 module version 1.0/);
  assert.match(namedClaimRefusal({ network: 'regtest', censusHeight: 5, version: null }), /no threshold answer/);
  // below the height a stock federation serves as before
  assert.equal(namedClaimRefusal({ network: 'testnet4', censusHeight: 160000, version: { major: 1, minor: 0 } }), null);
  assert.equal(namedClaimRefusal({ network: 'regtest', censusHeight: 99, version: null, pointOf: () => 100 }), null);
});

test('the module\'s output rule: 1..7 distinct keys, 1 <= t <= n', () => {
  assert.deepEqual(arenaLockValid(reference()), { ok: true });
  assert.match(arenaLockValid({ ...reference(), claimKeys: [KEYS[0], KEYS[1], KEYS[0]], threshold: 2 }).why, /twice/);
  assert.match(arenaLockValid({ ...reference(), threshold: 0 }).why, /zero/);
  assert.match(arenaLockValid({ ...reference(), threshold: 8 }).why, /above/);
  assert.match(arenaLockValid({ ...reference(), claimKeys: [...KEYS, b32(9)] }).why, /at most 7/);
  assert.match(arenaLockValid({ ...reference(), claimKeys: [] }).why, /no claim keys/);
});

const HEIGHT = 300;
const entry = { playerPubkey: b32(0x05), stakeCommitment: b32(0x04), stakeMsat: 100000n, feeMsat: 2000n, donationMsat: 0n,
  stakePoint: Uint8Array.from([0x03, ...b32(0x21)]), feePreimage: b32(0x07) };
const stakeLock = () => ({ ...arenaLockFor({ kind: 'stake', entry, roundId: b32(0x11), seatKeys: KEYS, threshold: 5, amountMsat: netStakeMsat(entry), imageBytes: entry.stakePoint }),
  expiration: HEIGHT + 144, fallbackAfter: HEIGHT + 3 });

test('§23.1 step 5 for an Arena lock: the round, its seats in seat order, its threshold, and every stock field', () => {
  const ok = (lock, over = {}) => arenaLockMatchesEntry({ lock, entry, kind: 'stake', roundId: b32(0x11), seatKeys: KEYS, threshold: 5, height: HEIGHT, stallBlocks: 3, ...over });
  assert.deepEqual(ok(stakeLock()), { ok: true });
  assert.equal(toHex(stakeLock().refundPk), toHex(refundKeyOf(entry.playerPubkey)));
  assert.match(ok({ ...stakeLock(), roundId: b32(0x12) }).why, /another round/);
  assert.match(ok({ ...stakeLock(), claimKeys: [KEYS[1], KEYS[0], ...KEYS.slice(2)] }).why, /seat order/);
  assert.match(ok({ ...stakeLock(), claimKeys: KEYS.slice(0, 6), threshold: 5 }).why, /seat order/);
  assert.match(ok({ ...stakeLock(), threshold: 4 }).why, /threshold 4 is not the round's 5/);
  assert.match(ok({ ...stakeLock(), amountMsat: 1n }).why, /holds 1 msat/);
  assert.match(ok({ ...stakeLock(), refundPk: REFUND }).why, /refund_pk/);
  assert.match(ok({ ...stakeLock(), expiration: HEIGHT + 144 - 13, fallbackAfter: HEIGHT + 3 - 13 }).why, /a loser could refund before settlement/);
  // the fallback height is the lock's count plus stall_blocks, nothing else (kanban #1281)
  assert.match(ok({ ...stakeLock(), fallbackAfter: HEIGHT + 2 }).why, /fallback height .* is not its block count plus stall_blocks 3/);
  assert.match(ok(stakeLock(), { stallBlocks: undefined }).why, /no stall_blocks/);
  assert.match(ok({ ...stakeLock(), claimKeys: [KEYS[0], KEYS[0], ...KEYS.slice(2)] }).why, /twice/);
  const fee = { ...arenaLockFor({ kind: 'fee', entry, roundId: b32(0x11), seatKeys: KEYS, threshold: 5, amountMsat: entry.feeMsat, imageBytes: sha256(entry.feePreimage) }), expiration: HEIGHT + 144, fallbackAfter: HEIGHT + 3 };
  assert.deepEqual(ok(fee, { kind: 'fee' }), { ok: true });
});

test('the signer set: the t lowest seats with a valid commit; a drop-out takes the next', () => {
  assert.deepEqual(namedSignerSet({ committed: [6, 0, 2, 3, 5, 1], threshold: 5 }), [0, 1, 2, 3, 5]);
  assert.deepEqual(namedSignerSet({ committed: [6, 0, 2, 3, 5, 1], threshold: 5, dropped: [1] }), [0, 2, 3, 5, 6]);
  assert.equal(namedSignerSet({ committed: [6, 0, 2, 3, 5, 1], threshold: 5, dropped: [1, 2] }), null);
  assert.equal(namedSignerSet({ committed: [0, 1, 2, 3], threshold: 5 }), null);
  assert.deepEqual(namedSignerSet({ committed: new Set([4, 4, 3, 2, 1, 0]), threshold: 5 }), [0, 1, 2, 3, 4]);
});

test('the SettlementCommit carries H(public nonce pair) in the bytes it always had', () => {
  const sk = b32(0x31), pk = schnorr.getPublicKey(sk), pubnonce = new Uint8Array(66).fill(2);
  pubnonce[33] = 3;
  const commit = { roundId: b32(0x11), settlementTxid: b32(0x22), ...commitNoncesOf(pubnonce) };
  const bytes = signSettlementCommit(commit, pk, (d) => schnorr.sign(d, sk));
  assert.equal(checkSettlementCommit(bytes, { seats: [pk], commit, verify: (s, d, k) => schnorr.verify(s, d, k) }).ok, true);
  const other = Uint8Array.from(pubnonce); other[65] ^= 1;
  assert.equal(checkSettlementCommit(bytes, { seats: [pk], commit: { ...commit, ...commitNoncesOf(other) }, verify: (s, d, k) => schnorr.verify(s, d, k) }).ok, false);
  assert.throws(() => commitNoncesOf(new Uint8Array(64)), /66 bytes/);
});

const ROUND = '11'.repeat(32);
const lockJson = { round_id: ROUND, claim_keys: KEYS.map(toHex), threshold: 5 };
const claim = (txid, signers, body = 'b0d1') => ({ kind: 'claim', txid, session: 7, outpoint: 'aa:0', signers, named_keys: signers.map((i) => toHex(KEYS[i])), lock: lockJson,
  body_id: body, one_signer_set: true });

test('offence (a) on the body id: a correct table\'s body is never an offence; another body, or two signer sets, names the signers', () => {
  const spends = [claim('c0ffee', [0, 2, 3, 5, 6]), { ...claim('c0ffee', [0, 2, 3, 5, 6]), outpoint: 'aa:1' }];
  // the txid follows S, the body does not: a correct body is no offence, whatever the txid
  assert.deepEqual(offTableClaims({ spends, roundId: ROUND, correctBodyIds: ['B0D1'] }), []);
  const got = offTableClaims({ spends, roundId: ROUND, correctBodyIds: ['beef'] });
  assert.equal(got.length, 1);
  assert.equal(got[0].offence, OFF_TABLE_CLAIM);
  assert.match(got[0].why, /not the body of a correct table/);
  assert.deepEqual(got[0].offenders, [0, 2, 3, 5, 6].map((i) => toHex(KEYS[i])).sort());
  // claims naming two sets in one transaction are false by themselves, even on a correct body
  const mixed = offTableClaims({ spends: [{ ...claim('c1', [0, 1, 2, 3, 4]), one_signer_set: false }], roundId: ROUND, correctBodyIds: ['b0d1'] });
  assert.match(mixed[0].why, /different signer sets/);
  // another round's claim, a claim whose lock was not read, a forfeit: not judged here
  assert.deepEqual(offTableClaims({ spends, roundId: '22'.repeat(32), correctBodyIds: [] }), []);
  assert.deepEqual(offTableClaims({ spends: [{ ...claim('dd', [0, 1, 2, 3, 4]), lock: null }], roundId: ROUND, correctBodyIds: [] }), []);
  assert.deepEqual(offTableClaims({ spends: [{ ...claim('dd', [0, 1, 2, 3, 4]), kind: 'cancel' }], roundId: ROUND, correctBodyIds: [] }), []);
});

test('protocol 27 acks and commits name the body id under their own tags: never read as over a txid', async () => {
  const { signSettlementAck, checkAck } = await import('../src/settlement-ack.js');
  const sk = b32(0x41), pk = schnorr.getPublicKey(sk), verify = (s, d, k) => schnorr.verify(s, d, k), sign = (d) => schnorr.sign(d, sk);
  const base = { roundId: b32(0x11), payoutTableId: b32(0x33) };
  const bodyAck = signSettlementAck({ ...base, settlementBodyId: b32(0x44) }, pk, sign);
  assert.equal(checkAck(bodyAck, { seats: [pk], ...base, settlementBodyId: b32(0x44), verify }).ok, true);
  assert.match(checkAck(bodyAck, { seats: [pk], ...base, settlementTxid: b32(0x44), verify }).why, /does not verify/);
  const txAck = signSettlementAck({ ...base, settlementTxid: b32(0x44) }, pk, sign);
  assert.match(checkAck(txAck, { seats: [pk], ...base, settlementBodyId: b32(0x44), verify }).why, /does not verify/);
  const nonces = commitNoncesOf(new Uint8Array(66).fill(2));
  const bodyCommit = { roundId: b32(0x11), settlementBodyId: b32(0x44), ...nonces };
  const word = signSettlementCommit(bodyCommit, pk, sign);
  assert.equal(checkSettlementCommit(word, { seats: [pk], commit: bodyCommit, verify }).ok, true);
  assert.equal(checkSettlementCommit(word, { seats: [pk], commit: { roundId: b32(0x11), settlementTxid: b32(0x44), ...nonces }, verify }).ok, false);
});

test('offence (b): only a forfeiter that itself signed the entry lost', () => {
  const cancel = { ...claim('f0', [0, 1, 2, 3, 4]), kind: 'cancel', outpoint: 'bb:0' };
  const entryOf = (op) => (op === 'bb:0' ? 'E1' : null);
  // seats 1 and 4 signed the entry lost; seat 6 too, but it did not forfeit
  const lostBy = (e) => (e === 'e1' ? [KEYS[1], toHex(KEYS[4]), KEYS[6]] : []);
  const got = forfeitsOfLostEntries({ spends: [cancel], entryOf, lostBy });
  assert.equal(got.length, 1);
  assert.equal(got[0].offence, FORFEIT_OF_LOST_ENTRY);
  assert.deepEqual(got[0].offenders, [toHex(KEYS[1]), toHex(KEYS[4])].sort());
  // honest: nobody of the five signed it lost (an ENTRY_VOID is not a lost result, so it is not in lostBy)
  assert.deepEqual(forfeitsOfLostEntries({ spends: [cancel], entryOf, lostBy: () => [KEYS[6]] }), []);
  // a claim is never row (b)
  assert.deepEqual(forfeitsOfLostEntries({ spends: [{ ...cancel, kind: 'claim' }], entryOf, lostBy }), []);
});

// THE PAGE'S BUNDLE CARRIES arena-lock.js (page-lock.js builds a protocol-27 entry's locks with it), and the bundle carries no curve library and drops
// imports: the module imports only this package's own files, and Z is found with plain BigInt arithmetic - the same Z as the stake-lock tool's
// arena-z-key (ruling #1135 1).
test('arena-lock.js imports only the protocol\'s own files, and Z is 02b3f7cd...2f9d', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../src/arena-lock.js', import.meta.url), 'utf8');
  for (const m of text.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';/gm)) assert.match(m[1], /^\.\//, `arena-lock.js imports ${m[1]}`);
  assert.equal(toHex(zKey()), '02b3f7cd89f2ce17f8e075d67398c8e65f9952b877c2eae657d8236af11ca82f9d');
});
