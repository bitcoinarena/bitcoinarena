// NEXTBLOCK'S SIGNED MANIFEST IS ITS REGISTRATION (kanban #202, §0A.3): the manifest core/plugin/nextblock-manifest.js
// carries is, byte for byte, the body truck-cores.js builds from the cores it installs, the client scripts
// blwp-client/known-good-clients.json lists for nextblock and the testnet4 series' donation set - signed by nextblock's
// developer key with the dev client. A new core, config or client turns this red until its developer signs a new manifest
// (node packages/blwp-donor/bin/sign-game-manifest.mjs nextblock <dev dir>) - a node only verifies it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NEXTBLOCK, NEXTBLOCK_MANIFEST, NEXTBLOCK_GAME_ID, nextblockManifestBody } from '../plugin/nextblock.js';
import { encodeManifestBody, manifestStands, gameIdOf } from '../../protocol/src/manifest.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { TESTNET4_DONATION_SET_KEYS } from '../../protocol/src/testnet4-donation-set-keys.js';
import { toHex } from '../../protocol/src/hash.js';
import { verifyEd25519 } from '../../blwp-node/src/ed25519.js';
import { hostedPlugins } from '../../blwp-node/src/plugins.js';
import { coreHashHex } from '../tools/hash-core.js';

const LIST = JSON.parse(readFileSync(new URL('../../blwp-client/known-good-clients.json', import.meta.url), 'utf8'));

test('nextblock\'s signed manifest is the body its registration builds, signed by its developer key', () => {
  const body = nextblockManifestBody({ clients: LIST.games.nextblock.pinned['blwp-core.js'], gameDevPubkey: NEXTBLOCK_MANIFEST.gameDevPubkey,
    gameDonationSetId: donationSetId(TESTNET4_DONATION_SET_KEYS.recipients) });
  assert.equal(toHex(encodeManifestBody(NEXTBLOCK_MANIFEST)), toHex(encodeManifestBody(body)),
    'the signed manifest is not the registration: its developer signs a new one with the dev client (blwp-donor/bin/sign-game-manifest.mjs)');
  const stands = manifestStands(NEXTBLOCK_MANIFEST, { verify: verifyEd25519 });
  assert.equal(stands.ok, true, stands.why);
  assert.equal(toHex(stands.gameId), toHex(NEXTBLOCK_GAME_ID));
  assert.equal(toHex(gameIdOf(NEXTBLOCK_MANIFEST)), toHex(NEXTBLOCK.gameId));
});

test('nextblock lists the core this tree builds, and a node hosts it as registered', () => {
  assert.ok(NEXTBLOCK_MANIFEST.cores.some((c) => toHex(c.hash) === coreHashHex()), 'the manifest does not list the core this tree builds');
  assert.deepEqual(NEXTBLOCK_MANIFEST.gameName, 'nextblock');
  const hosted = hostedPlugins([NEXTBLOCK]);
  assert.deepEqual([...hosted.keys()], [toHex(NEXTBLOCK_GAME_ID)]);
  assert.equal(hosted.get(toHex(NEXTBLOCK_GAME_ID)).cores, NEXTBLOCK.cores);
});
