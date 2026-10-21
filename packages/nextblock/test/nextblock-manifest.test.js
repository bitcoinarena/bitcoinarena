// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NEXTBLOCK'S NEWEST SIGNED MANIFEST IS ITS REGISTRATION (§0A.3; since the newest is version 3): the manifest
// plugin/nextblock-v3.js carries is, byte for byte, the body truck-cores.js builds from the cores it installs, the client scripts
// arena-client/known-good-clients.json lists for nextblock, the testnet4 series' donation set and the items it sells, as an update
// of version 2 requiring protocol 10 - signed by nextblock's developer key with the dev client. A new core, config, client or item
// turns this red until its developer signs a new manifest (node packages/nextblock/tools/sign-manifest-v3.mjs <dev dir>) - a node
// only verifies it. Versions 1 and 2 stay as they were signed, each hosted with the five cores it lists; version 3 adds f0cc7b7b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NEXTBLOCK, NEXTBLOCK_MANIFEST, NEXTBLOCK_GAME_ID, nextblockManifestBody, NEXTBLOCK_CORES, NEXTBLOCK_CORES_V3, NEXTBLOCK_ITEMS, TRUCK_F0CC_HASH } from '../plugin/nextblock.js';
import { GAME as V2, MANIFEST_V2, GAME_ID_V2 } from '../plugin/nextblock-v2.js';
import { GAME as V3, MANIFEST_V3, GAME_ID_V3 } from '../plugin/nextblock-v3.js';
import { ITEMS_VERSION } from 'arena-sdk/constants';
import { encodeManifestBody, manifestStands, gameIdOf } from 'arena-sdk/manifest';
import { donationSetId } from 'arena-sdk/donation';
import { TESTNET4_DONATION_SET_KEYS } from 'arena-sdk/testnet4-donation-set-keys';
import { toHex } from 'arena-sdk/hash';
import { verifyEd25519 } from 'arena-sdk/ed25519';
import { hostedPlugins } from '../../arena-node/src/plugins.js';
import { coreHashHex } from '../tools/hash-core.js';

const LIST = JSON.parse(readFileSync(new URL('../../arena-client/known-good-clients.json', import.meta.url), 'utf8'));

test('nextblock\'s newest signed manifest (version 3) is the body its registration builds, signed by its developer key', () => {
  const body = {
    ...nextblockManifestBody({ clients: Object.values(LIST.games.nextblock.pinned).flat(), gameDevPubkey: MANIFEST_V2.gameDevPubkey,
      gameDonationSetId: donationSetId(TESTNET4_DONATION_SET_KEYS.recipients), cores: NEXTBLOCK_CORES_V3 }),
    version: 3, parentManifestId: GAME_ID_V2, items: NEXTBLOCK_ITEMS.map((i) => ({ ...i })), requiredProtocolVersion: ITEMS_VERSION,
  };
  assert.equal(toHex(encodeManifestBody(MANIFEST_V3)), toHex(encodeManifestBody(body)),
    'the signed manifest is not the registration: its developer signs a new one with the dev client\'s signer (nextblock/tools/sign-manifest-v3.mjs)');
  const stands = manifestStands(MANIFEST_V3, { verify: verifyEd25519, parentOf: (id) => (toHex(id) === toHex(GAME_ID_V2) ? MANIFEST_V2 : null) });
  assert.equal(stands.ok, true, stands.why);
  assert.equal(toHex(stands.gameId), toHex(GAME_ID_V3));
  assert.equal(toHex(MANIFEST_V3.gameDevPubkey), toHex(NEXTBLOCK_MANIFEST.gameDevPubkey), 'the same developer key as versions 1 and 2');
});

test('versions 1 and 2 stand as they were signed, with the five cores they list', () => {
  assert.equal(manifestStands(NEXTBLOCK_MANIFEST, { verify: verifyEd25519 }).ok, true);
  assert.equal(toHex(gameIdOf(NEXTBLOCK_MANIFEST)), toHex(NEXTBLOCK.gameId));
  assert.deepEqual(NEXTBLOCK_MANIFEST.cores.map((c) => toHex(c.hash)).sort(), [...NEXTBLOCK_CORES.keys()].sort());
  assert.deepEqual(MANIFEST_V2.cores.map((c) => toHex(c.hash)).sort(), [...NEXTBLOCK_CORES.keys()].sort());
});

test('version 3 lists the core this tree builds, and a node hosts versions 1, 2 and 3 as registered', () => {
  assert.ok(MANIFEST_V3.cores.some((c) => toHex(c.hash) === coreHashHex()), 'the manifest does not list the core this tree builds');
  assert.ok(MANIFEST_V3.cores.some((c) => toHex(c.hash) === TRUCK_F0CC_HASH), 'version 3 names the core that knows the larger truck');
  assert.ok(NEXTBLOCK_MANIFEST.cores.some((c) => toHex(c.hash) === coreHashHex()), 'version 1 lists the truck this tree builds');
  assert.equal(NEXTBLOCK_MANIFEST.cores.some((c) => toHex(c.hash) === TRUCK_F0CC_HASH), false, 'version 1 names no core that knows the larger truck');
  assert.deepEqual(MANIFEST_V3.gameName, 'nextblock');
  const hosted = hostedPlugins([NEXTBLOCK, V2, V3]);
  assert.deepEqual([...hosted.keys()], [toHex(NEXTBLOCK_GAME_ID), toHex(GAME_ID_V2), toHex(GAME_ID_V3)]);
  assert.equal(hosted.get(toHex(NEXTBLOCK_GAME_ID)).cores, NEXTBLOCK_CORES);
  assert.equal(hosted.get(toHex(GAME_ID_V3)).cores, NEXTBLOCK_CORES_V3);
});
