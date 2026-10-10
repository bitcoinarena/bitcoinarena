// SIGN NEW GAMES AND MARKETS IN THE OWNER AREA (kanban #276 step 4): the page's signer gives the same bytes as the developer's
// command-line client (arena-donor signManifest) for the same body and key; the key is the owner's, from the 24 words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { devSeedFromSeed, devPubkeyOf, bodyFromJson, signManifestWithSeed } from '../src/owner-dev.js';
import { ownerSecretFromSeed } from '../src/owner.js';
import { signManifest, gameDevKey } from '../../arena-donor/src/manifest-sign.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { BODY as RPS_BODY } from '../../rock-paper-scissors/plugin/manifest-body.mjs';

const seed = new Uint8Array(32).fill(7);
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
// the body as the page takes it: JSON, 32-byte fields in hex, BigInts as decimal strings
const asJson = (b) => JSON.parse(JSON.stringify(b, (k, v) => (v instanceof Uint8Array ? toHex(v) : typeof v === 'bigint' ? String(v) : v)));

test('the developer key is the owner\'s own, from the same 24 words, and not the owner key', () => {
  const dev = devSeedFromSeed(seed);
  assert.equal(dev.length, 32);
  assert.notEqual(toHex(dev), toHex(ownerSecretFromSeed(seed)));
  assert.equal(toHex(devSeedFromSeed(seed)), toHex(dev), 'the same words, the same key');
  assert.notEqual(toHex(devSeedFromSeed(new Uint8Array(32).fill(8))), toHex(dev));
});

test('a game signed in the page is byte for byte the command-line client\'s: same body, same key', () => {
  const devSeed = devSeedFromSeed(seed);
  const pub = devPubkeyOf(devSeed);
  // Rock Paper Scissors' body, with this owner's key as its developer
  const json = { ...asJson(RPS_BODY), gameDevPubkey: undefined };
  const body = bodyFromJson(json, { devPubkey: pub });
  const page = signManifestWithSeed(body, devSeed);
  const cli = signManifest(body, gameDevKey(Buffer.concat([PKCS8_ED25519, Buffer.from(devSeed)])));
  assert.equal(page.hex, toHex(encodeManifest(cli)), 'the same bytes');
  assert.equal(page.gameId, toHex(gameIdOf(cli)));
  void createPrivateKey;
});

test('a body naming another developer, or one that does not stand, is refused by name', () => {
  const devSeed = devSeedFromSeed(seed);
  const other = bodyFromJson({ ...asJson(RPS_BODY) });   // the real market's developer key, not this owner's
  assert.throws(() => signManifestWithSeed(other, devSeed), /another developer key/);
  assert.throws(() => bodyFromJson({ ...asJson(RPS_BODY), roundPeriodMs: '15 minutes' }), /roundPeriodMs is a whole number/);
  assert.throws(() => bodyFromJson({ ...asJson(RPS_BODY), clients: ['abc'] }), /clients\[0\] is 32 bytes in hex/);
  const bad = bodyFromJson({ ...asJson(RPS_BODY), gameDevPubkey: undefined, players: 99 }, { devPubkey: devPubkeyOf(devSeed) });
  assert.throws(() => signManifestWithSeed(bad, devSeed), /seats 2 to/);
});
