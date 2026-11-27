// #1489 r20 gossip: POST /referral-name reads a name dated ahead of the seat's clock as dated "now" (#1190) - but "now" is the clock at
// each arrival, so the same old record, replayed by any stranger (it is public, every seat gossips it) after the site's real rename,
// is dated later than the rename and replaces it. Safe behaviour: a record the seat already ranked older than the kept name, posted
// again later, never takes the place of the newer name the site signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { keepReferralName, referralNames } from '../src/referral-names.js';
import { encodeReferralName, referralNameId } from '../../arena-protocol/src/referral-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const secret = new Uint8Array(32).fill(7);
const site = Uint8Array.from([0x02, ...schnorr.getPublicKey(secret)]);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const signed = (name, atMs) => {
  const r = { site, name, atMs: BigInt(atMs) };
  return { record: toHex(encodeReferralName(r)), signature: toHex(schnorr.sign(referralNameId(r), secret)) };
};
const NOW = 1_800_000_000_000;

test('a stranger replaying an old name dated ahead does not roll back the site\'s newer rename', () => {
  const db = new DatabaseSync(':memory:');
  const ahead = signed('Old Name', NOW + 9 * 60000);   // the site's clock ran 9 min ahead (inside the 10-minute bound)
  assert.equal(keepReferralName(db, ahead, { verify, nowMs: NOW }).kept, 'new');
  const rename = signed('New Name', NOW + 60000);       // the site renames itself a minute later
  assert.equal(keepReferralName(db, rename, { verify, nowMs: NOW + 60000 }).kept, 'new');
  // two minutes later a stranger posts the first record again (public: every seat hands it on)
  const replay = keepReferralName(db, ahead, { verify, nowMs: NOW + 120000 });
  assert.equal(referralNames(db).get(toHex(site)).name, 'New Name', `the replay was ${replay.kept}: the kept name rolled back to the older record`);
});
