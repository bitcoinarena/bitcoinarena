// A GAME IS A SIGNED MANIFEST, AND A ROUND IS PLAYED ONLY ON WHAT ITS MANIFEST LISTS (kanban #202, §0A.3, §0A.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import {
  encodeManifestBody, encodeManifest, decodeManifest, manifestBodyId, gameIdOf, manifestStands, roundFitsManifest,
  RESULT_TYPE, PAYOUT_RULE, NO_PARENT,
} from '../src/manifest.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const verifyEd25519 = (sig, msg, key) => verify(null, Buffer.from(msg),
  createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const dev = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
};
const signed = (body, key) => ({ ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), key)) });

const A = dev();
const BODY = {
  gameName: 'tally', gameDevPubkey: A.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.REPLAY,
  cores: [{ hash: b32(1), configs: [b32(0x10), b32(0x11)] }, { hash: b32(2), configs: [b32(0x20)] }],
  runTicksMax: 600, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE, rankNumerator: 3, rankDenominator: 4, minScore: 5,
  clients: [b32(0xc1)], gameDonationSetId: b32(0xd0),
};
const V1 = signed(BODY, A.key);

test('a manifest encodes, decodes to itself, and its id is the hash of body and signature', () => {
  const bytes = encodeManifest(V1);
  const back = decodeManifest(bytes);
  assert.deepEqual(encodeManifest(back), bytes);
  assert.deepEqual(gameIdOf(back), gameIdOf(V1));
  // the developer signs the body's id, which is not the game's id
  assert.notDeepEqual(manifestBodyId(V1), gameIdOf(V1));
  // a second signature over the same body is another manifest, with another id
  assert.notDeepEqual(gameIdOf({ ...V1, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(BODY)), dev().key)) }), gameIdOf(V1));
  assert.throws(() => decodeManifest(bytes.subarray(0, bytes.length - 1)));
});

test('the encoder holds a manifest to one encoding and to the engine\'s result types and payout rules', () => {
  assert.throws(() => encodeManifestBody({ ...BODY, resultType: 2 }), /result type 2 is not one this engine has/);
  assert.throws(() => encodeManifestBody({ ...BODY, payoutRule: 9 }), /payout rule 9 is not one of the engine's/);
  assert.throws(() => encodeManifestBody({ ...BODY, cores: [...BODY.cores].reverse() }), /not sorted/);
  assert.throws(() => encodeManifestBody({ ...BODY, cores: [] }), /at least one core/);
  assert.throws(() => encodeManifestBody({ ...BODY, rankNumerator: 4 }), /rank curve/);
  assert.throws(() => encodeManifestBody({ ...BODY, runTicksMax: 70000 }), /run_ticks_max/);
});

test('a manifest is a game only when its developer signed it, and an update only when the same key signs the next version over a parent it holds', () => {
  const v = (m, parents = []) => manifestStands(m, { verify: verifyEd25519, parentOf: (id) => parents.find((p) => toHex(gameIdOf(p)) === toHex(id)) || null });
  const first = v(V1);
  assert.equal(first.ok, true, first.why);
  assert.deepEqual(first.gameId, gameIdOf(V1));
  assert.match(manifestStands(V1, {}).why, /no verifier/);
  assert.match(v({ ...V1, signature: new Uint8Array(64) }).why, /its signature is not its developer key/);
  assert.match(v(signed({ ...BODY, gameName: 'other' }, dev().key)).why, /its signature is not its developer key/);
  assert.match(v(signed({ ...BODY, parentManifestId: b32(9) }, A.key)).why, /version 1 names a parent/);
  const v2 = signed({ ...BODY, version: 2, parentManifestId: gameIdOf(V1), minScore: 7 }, A.key);
  assert.match(v(v2).why, /its parent .* is not a manifest this node holds/);
  const ok2 = v(v2, [V1]);
  assert.equal(ok2.ok, true, ok2.why);
  assert.match(v(signed({ ...BODY, version: 2, parentManifestId: NO_PARENT }, A.key)).why, /names no parent/);
  assert.match(v(signed({ ...BODY, version: 3, parentManifestId: gameIdOf(V1) }, A.key), [V1]).why, /version 3 after a parent of version 1/);
  // ANOTHER DEVELOPER'S "UPDATE" OF A GAME IS NOT A GAME (§0A.3)
  const B = dev();
  assert.match(v(signed({ ...BODY, gameDevPubkey: B.pub, version: 2, parentManifestId: gameIdOf(V1) }, B.key), [V1]).why, /a manifest of another developer key - not a game/);
});

test('a round fits its manifest only on a listed core, a config listed for that core, a run within the maximum, the manifest\'s curve and at least its min_score', () => {
  const id = gameIdOf(V1);
  const round = { gameId: id, simCoreHash: b32(1), configHash: b32(0x11), blockTicks: 600, rankNumerator: 3, rankDenominator: 4, minScore: 5 };
  assert.deepEqual(roundFitsManifest(round, V1), { ok: true });
  assert.deepEqual(roundFitsManifest({ ...round, minScore: 9 }, V1), { ok: true }, 'a round may ask more than the floor');
  const why = (over) => roundFitsManifest({ ...round, ...over }, V1).why;
  assert.match(why({ gameId: b32(7) }), /that round names game 0707070707070707, not game "tally"/);
  assert.match(why({ gameId: undefined }), /names no 32-byte game/);
  assert.match(why({ simCoreHash: b32(3) }), /game "tally" lists no core 0303030303030303/);
  assert.match(why({ configHash: b32(0x20) }), /lists no config 2020202020202020 for core 0101010101010101/);
  assert.match(why({ blockTicks: 601 }), /that round's run is 601 ticks; game "tally" runs at most 600/);
  assert.match(why({ rankNumerator: 2 }), /rank curve is 2\/4; game "tally" pays 3\/4/);
  assert.match(why({ minScore: 4 }), /min_score 4 is below game "tally"'s 5/);
});
