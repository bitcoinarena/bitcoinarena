#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE REGTEST CONTRIBUTION RUN'S SIGNED RECORDS (kanban #1346), made where regtest's donation keys are (ARENA_GENESIS_KEYS, default
 * /mnt/bitcoin/blwp-genesis): a test contributor's key and referral (site) key, his ContributionAgreement signed by his own key, regtest's
 * key set (serial 2) with his entry added as serial 3 from height 0 - signed by regtest's donation authority - and ContributionTerminations
 * for heights FROM..TO signed by regtest's recovery key (the cold admin key), since the run's heights are not known before it.
 *
 *   OUT=<dir> [FROM=0] [TO=3000] [TAIL=20] node tools/contribution-devnet-keys.mjs
 *
 * Writes OUT/set.hex (body || signature, for ARENA_REGTEST_EXTRA_DONATION_SET), OUT/contributor.json (his secret, the site key, the agreement
 * id - test keys only), OUT/terminations.json (height -> hex body || signature). Regtest keys only: nothing here names a real network.
 */
import { createPrivateKey, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { encodeDonationSetBody, donationSetBodyId } from '../../arena-protocol/src/authority.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { MILESTONES, contributionAgreementId, encodeContributionTermination } from '../../arena-protocol/src/contribution.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { taggedHash } from '../../arena-protocol/src/hash.js';

const env = process.env;
const OUT = env.OUT; if (!OUT) throw new Error('OUT=<dir>');
mkdirSync(OUT, { recursive: true });
const KEYDIR = env.ARENA_GENESIS_KEYS || '/mnt/bitcoin/blwp-genesis';
const ed = (name) => createPrivateKey({ key: readFileSync(join(KEYDIR, name)), format: 'der', type: 'pkcs8' });
const authority = ed('regtest-authority.pkcs8'), recovery = ed('regtest-recovery.pkcs8');

const secret = secp256k1.utils.randomSecretKey();
const recipientPk = secp256k1.getPublicKey(secret, true);
const siteSecret = secp256k1.utils.randomSecretKey();
const siteKey = secp256k1.getPublicKey(siteSecret, true);
const agreement = {
  recipientPk, siteKeys: [siteKey], startHeight: 0,
  // the base is held back by its cliff for the whole run: the share measured is the tranches'
  base: { targetBps: 250, cliffBlocks: 1000000, days: 730 },
  tranches: MILESTONES.map((milestone) => ({ bps: 250, milestone, windowBlocks: 12960, expiresHeight: 1000000 })),
  attributionFloorBps: 3000, tailBlocks: Number(env.TAIL || 20),
};
const id = contributionAgreementId(agreement);
const contribution = { agreement, signature: secp256k1.sign(id, secret) };
const recipients = [...TEST_DONATION_SET_KEYS_REGTEST.recipients.map((r) => ({ recipientPk: r.recipientPk, shareBps: r.shareBps, label: r.label })),
  { recipientPk, shareBps: 0, label: 'contributor (test)', contribution }];
const body = { networkId: NETWORK_ID_REGTEST, serial: 3n, validFrom: 0, recipients };
const setSig = edSign(null, Buffer.from(donationSetBodyId(body)), authority);
writeFileSync(join(OUT, 'set.hex'), toHex(encodeDonationSetBody(body)) + toHex(new Uint8Array(setSig)) + '\n');
writeFileSync(join(OUT, 'contributor.json'), JSON.stringify({ secret: toHex(secret), recipientPk: toHex(recipientPk), siteKey: toHex(siteKey), agreementId: toHex(id),
  tailBlocks: agreement.tailBlocks }) + '\n');
const terms = {};
for (let h = Number(env.FROM || 0); h <= Number(env.TO || 3000); h++) {
  const t = { agreementId: id, atHeight: h, cause: 'regtest measurement of #1346: termination by the cold admin key' };
  const b = encodeContributionTermination(t);
  terms[h] = toHex(b) + toHex(new Uint8Array(edSign(null, Buffer.from(taggedHash(TAG.contributionTermination, b)), recovery)));
}
writeFileSync(join(OUT, 'terminations.json'), JSON.stringify(terms) + '\n');
console.log(JSON.stringify({ out: OUT, agreementId: toHex(id), recipient: toHex(recipientPk).slice(0, 16), siteKey: toHex(siteKey).slice(0, 16), terminations: Object.keys(terms).length }));
