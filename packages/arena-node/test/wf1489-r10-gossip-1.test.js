// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r10 gossip #1 (P5 no limits): POST /referral-name keeps EVERY validly-signed program name in referral_names,
// one row per distinct site key, with no bound - and, kept 'new', gossips it to every network seat. A referral name is
// "said by the key itself" (BIP-340 by the site key), so a stranger with no bond, no earnings and no round mints an
// unlimited number of fresh site keys, signs a name for each, and POSTs them. keepReferralName checks only the signature
// and the newest-wins step; it never checks that the key ever earned a referral fee (donation_outputs), holds a bond, or
// that this seat already keeps too many names. So one stranger grows referral_names without limit AND, through the
// 'new' gossip fan-out in server.js, makes every one of the ~14 seats store the same unbounded pile.
//
// SAFE BEHAVIOUR (fails on 85f803d70): a seat bounds how many never-earning referral names it keeps. Here one stranger
// offers 2000 names under 2000 fresh keys; a seat that bounds them keeps far fewer than it was offered. On HEAD every
// one is kept (size === 2000), so the assertion fails - the table (and the network it is gossiped to) grows without limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { keepReferralName, referralNames } from '../src/referral-names.js';
import { encodeReferralName, decodeReferralName, referralNameId } from '../../arena-protocol/src/referral-name.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const NOW = 1_800_000_000_000;

// one stranger, one fresh (guaranteed-distinct) keypair per name - each a VALID, self-signed referral name
const freshName = (i) => {
  const secret = new Uint8Array(32);
  // a distinct non-zero secret per i: a big-endian counter in the low 6 bytes over a fixed high prefix
  secret.fill(0x11);
  let v = i + 1;
  for (let p = 31; p >= 26 && v > 0; p--) { secret[p] = v & 0xff; v = Math.floor(v / 256); }
  const site = Uint8Array.from([0x02, ...schnorr.getPublicKey(secret)]);
  const r = { site, name: `prog-${i}`, atMs: BigInt(NOW - 1000) };
  return { record: toHex(encodeReferralName(r)), signature: toHex(schnorr.sign(referralNameId(r), secret)) };
};

test('a stranger cannot grow referral_names without limit (P5): fresh-key names are bounded', () => {
  const db = new DatabaseSync(':memory:');
  const OFFERED = 2000;
  let kept = 0, refused = 0;
  for (let i = 0; i < OFFERED; i++) {
    const got = keepReferralName(db, freshName(i), { verify, nowMs: NOW });
    if (got.ok && got.kept === 'new') kept += 1;
    else if (!got.ok) refused += 1;
  }
  const held = referralNames(db).size;
  // the keys are distinct and valid: each one kept is its own row, each one past the bound refused (so not 'new', not gossiped; kanban #1927)
  assert.equal(held, kept, 'each distinct site key is its own referral_names row');
  assert.equal(kept + refused, OFFERED, 'every offer is either kept as new or refused');
  // SAFE: a seat must not keep an unbounded pile of never-earning names from one stranger.
  // A sane cap is well below what was offered; HEAD keeps all 2000 (no cap) and fails here.
  assert.ok(held <= 256, `referral_names grew to ${held} rows from ${OFFERED} stranger-minted keys: no bound on the door (gossiped network-wide)`);
});

test('a key that earned a referral fee is kept past the bound, and a kept site still answers (kanban #1927)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE donation_outputs (recipient_pk TEXT, item TEXT, amount_msat TEXT)');
  for (let i = 0; i < 300; i++) keepReferralName(db, freshName(i), { verify, nowMs: NOW });
  assert.equal(referralNames(db).size, 256);
  const earner = freshName(5000);
  const before = keepReferralName(db, earner, { verify, nowMs: NOW });
  assert.equal(before.ok, false, 'an unearned new key past the bound is refused');
  assert.equal(before.status, 429);
  // the same key once it earned a 'website' payout here: kept
  const siteHex = toHex(decodeReferralName(fromHex(earner.record)).site);
  db.prepare("INSERT INTO donation_outputs VALUES (?, 'website', '1000')").run(siteHex);
  const after = keepReferralName(db, earner, { verify, nowMs: NOW });
  assert.equal(after.ok, true); assert.equal(after.kept, 'new'); assert.equal(after.site, siteHex);
  // a site kept before the bound filled is still answered (here the same record: held)
  assert.equal(keepReferralName(db, freshName(3), { verify, nowMs: NOW }).kept, 'held');
});
