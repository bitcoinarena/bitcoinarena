// EVERY FIELD OF A LOCK, BEFORE A STAKE COUNTS (§23.1 step 5, v4.6.2, F4 and
// F5). The player builds the lock; a signer node that only saw it exist would count a
// lock with a short expiry, the wrong amount or somebody else's keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/hash.js';
import { netStakeMsat } from '../src/payout.js';
import { lockMatchesEntry, refundKeyOf } from '../src/stake-lock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const CLAIM = Uint8Array.from([0x02, ...b32(0x44)]);
const HEIGHT = 1000;
const entry = {
  playerPubkey: b32(0x05), stakeCommitment: b32(0x04), stakeMsat: 100000n, feeMsat: 2000n,
  donationMsat: 0n, stakePoint: Uint8Array.from([0x03, ...b32(0x21)]), feePreimage: b32(0x07),
};
const stakeLock = () => ({
  paymentImage: { kind: 'point', bytes: new Uint8Array(entry.stakePoint) },
  amountMsat: netStakeMsat(entry), claimPk: new Uint8Array(CLAIM),
  refundPk: refundKeyOf(entry.playerPubkey), expiration: HEIGHT + 144,
});
const feeLock = () => ({
  ...stakeLock(), paymentImage: { kind: 'hash', bytes: sha256(entry.feePreimage) }, amountMsat: entry.feeMsat,
});
const check = (lock, kind = 'stake', over = {}) =>
  lockMatchesEntry({ lock, entry, kind, claimPk: CLAIM, height: HEIGHT, ...over });

test('a stake lock and a fee lock built as the entry says are counted', () => {
  assert.deepEqual(check(stakeLock()), { ok: true });
  assert.deepEqual(check(feeLock(), 'fee'), { ok: true });
  assert.deepEqual(refundKeyOf(b32(9)).slice(0, 1), Uint8Array.from([0x02]));
});

test('each field the player could get wrong is refused by name', () => {
  const cases = [
    [{ paymentImage: { kind: 'hash', bytes: b32(0x04) } }, /payment image is not the entry's stake point/],
    [{ paymentImage: { kind: 'point', bytes: Uint8Array.from([0x02, ...b32(0x21)]) } }, /not the entry's stake point/],
    [{ amountMsat: netStakeMsat(entry) - 1n }, /holds 97999 msat, and the entry's net stake is 98000/],
    [{ claimPk: Uint8Array.from([0x02, ...b32(0x45)]) }, /claim_pk is not this round's attested claim key/],
    [{ refundPk: Uint8Array.from([0x03, ...b32(0x05)]) }, /refund_pk is not the entry's player key/],
    [{ expiration: HEIGHT + 143 }, /expires at 1143, before 1000 \+ 144: a loser could refund/],
  ];
  for (const [over, why] of cases) assert.match(check({ ...stakeLock(), ...over }).why, why);
  assert.match(check(stakeLock(), 'stake', { height: undefined }).why, /no federation height/);
});

test('a fee lock opens only to H(F), and F may not be the stake\'s own secret (F5)', () => {
  assert.match(check({ ...feeLock(), paymentImage: { kind: 'hash', bytes: b32(0x04) } }, 'fee').why,
    /not H\(F\)/);
  assert.match(check({ ...feeLock(), amountMsat: 1n }, 'fee').why, /holds 1 msat, and the entry's fee is 2000/);
  const sameSecret = { ...entry, stakeCommitment: sha256(entry.feePreimage) };
  assert.match(lockMatchesEntry({ lock: feeLock(), entry: sameSecret, kind: 'fee', claimPk: CLAIM, height: HEIGHT }).why,
    /fee preimage is the stake's own secret/);
});

test('an entry with no stake point matches no stake lock', () => {
  const none = { ...entry, stakePoint: new Uint8Array(33) };
  assert.match(lockMatchesEntry({ lock: stakeLock(), entry: none, kind: 'stake', claimPk: CLAIM, height: HEIGHT }).why,
    /names no stake point/);
});
