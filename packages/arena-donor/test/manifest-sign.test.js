// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DEV CLIENT SIGNS A GAME, A NODE ONLY VERIFIES IT (2026-10-07 15:40: "the dev client is
// responsible for game signatures, not the node").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { gameDevKey, signManifest } from '../src/manifest-sign.js';
import { manifestStands, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { hostedPlugins } from '../../arena-node/src/plugins.js';
import { verifyEd25519 } from '../../arena-node/src/ed25519.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

// THE GAME DEV'S DONATION SET: a registration carries the set its manifest names by id
const DEV_SET = [{ recipientPk: Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x5d)]), label: 'the dev', shareBps: 10000 }];
const devKey = () => gameDevKey(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }));
const bodyFor = (pubkey) => ({
  gameName: 'signed by its dev', gameDevPubkey: pubkey, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.REPLAY,
  cores: [{ hash: new Uint8Array(32).fill(1), configs: [new Uint8Array(32).fill(2)] }], runTicksMax: 600, roundPeriodMs: 0n,
  payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4, minScore: 1, clients: [], gameDonationSetId: donationSetId(DEV_SET),
});

test('the dev client signs a manifest with its key, a node\'s check accepts it, and one with a signature changed is refused at the node', () => {
  const dev = devKey();
  const manifest = signManifest(bodyFor(dev.pubkey), dev);
  assert.equal(manifest.signature.length, 64);
  const stands = manifestStands(manifest, { verify: verifyEd25519 });
  assert.equal(stands.ok, true, stands.why);
  const forged = { ...manifest, signature: Uint8Array.from(manifest.signature, (b, i) => (i === 0 ? b ^ 1 : b)) };
  assert.throws(() => hostedPlugins([{ name: 'forged', manifest: forged, cores: new Map(), donationSet: DEV_SET }]), /its signature is not its developer key/);
  // only the manifest's own cores may be installed; none given here, so the real one hosts
  assert.equal(hostedPlugins([{ name: 'signed', manifest, cores: new Map(), donationSet: DEV_SET }]).size, 1);
});

test('the dev client refuses to sign a manifest that names another developer key', () => {
  const dev = devKey();
  assert.throws(() => signManifest(bodyFor(devKey().pubkey), dev), /names another developer key than the one this client holds/);
  assert.throws(() => gameDevKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'der' })), /Ed25519/);
});

test('no file a node runs signs a game: nothing in arena-node/src or core/plugin imports the dev client\'s signer, holds a private key, or signs', () => {
  const at = (p) => new URL(p, import.meta.url).pathname;
  const signing = [];
  for (const dir of ['../../arena-node/src/', '../../nextblock/plugin/']) for (const f of readdirSync(at(dir))) {
    if (!/\.(m?js)$/.test(f)) continue;
    const src = readFileSync(at(dir + f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    if (/manifest-sign|createPrivateKey|\bsign\s*\(\s*null|pkcs8|game-dev/.test(src)) signing.push(dir.replace('../../', '') + f);
  }
  assert.deepEqual(signing, [], 'a node-side file signs or holds a key');
});
