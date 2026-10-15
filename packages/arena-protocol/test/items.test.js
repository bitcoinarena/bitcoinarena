// IN-GAME ITEMS (kanban #365): a manifest's catalogue (protocol 10) and the 25 / 25 / 50 split of a purchase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, verify } from 'node:crypto';
import { encodeManifestBody, encodeManifest, decodeManifest, manifestBodyId, gameIdOf, manifestStands, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../src/manifest.js';
import { itemsFit, itemSplit, itemOf, ITEMS_MAX } from '../src/items.js';
import { ITEMS_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const verifyEd25519 = (sig, msg, key) => verify(null, Buffer.from(msg),
  createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const DEV = { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
const signed = (body) => ({ ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV.key)) });
const BODY = {
  gameName: 'tally', gameDevPubkey: DEV.pub, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.REPLAY,
  cores: [{ hash: b32(1), configs: [b32(0x10)] }], runTicksMax: 600, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
  rankNumerator: 3, rankDenominator: 4, minScore: 5, clients: [b32(0xc1)], gameDonationSetId: b32(0xd0),
};
const ITEMS = [
  { id: 'double-jump', name: 'Double jump', priceSat: 2100n, unlock: b32(0xa1) },
  { id: 'trick-flip', name: 'Flip trick', priceSat: 500n, unlock: b32(0xa2) },
];

test('a catalogue rides in the manifest from version 10, reads back whole, and is part of the game id; none keeps the old bytes', () => {
  assert.equal(ITEMS_VERSION, 10);
  const withItems = signed({ ...BODY, items: ITEMS, requiredProtocolVersion: ITEMS_VERSION });
  const back = decodeManifest(encodeManifest(withItems));
  assert.deepEqual(back.items, ITEMS);
  assert.equal(toHex(encodeManifest(back)), toHex(encodeManifest(withItems)));
  assert.notEqual(toHex(gameIdOf(withItems)), toHex(gameIdOf(signed({ ...BODY, items: [{ ...ITEMS[0], priceSat: 2101n }, ITEMS[1]], requiredProtocolVersion: ITEMS_VERSION }))),
    'a price is in the id: it changes only with a new manifest');
  const plain = signed(BODY);
  assert.equal(decodeManifest(encodeManifest(plain)).items, undefined);
  assert.equal(encodeManifestBody(plain).length + 0, encodeManifestBody({ ...BODY }).length, 'a manifest without items keeps its bytes');
  assert.deepEqual(itemOf(back, 'trick-flip').priceSat, 500n);
  assert.equal(itemOf(back, 'nope'), null);
});

test('a catalogue that does not fit is refused by name', () => {
  const v = { requiredProtocolVersion: ITEMS_VERSION };
  assert.match(itemsFit(ITEMS, { requiredProtocolVersion: 9 }).why, /requires protocol version .*10 or later/);
  assert.match(itemsFit([], v).why, /1 to 64 items/);
  assert.match(itemsFit(Array.from({ length: ITEMS_MAX + 1 }, (_, i) => ({ ...ITEMS[0], id: `i${String(i).padStart(3, '0')}` })), v).why, /1 to 64 items/);
  assert.match(itemsFit([ITEMS[1], ITEMS[0]], v).why, /sorted by id, each id once/);
  assert.match(itemsFit([ITEMS[0], ITEMS[0]], v).why, /sorted by id, each id once/);
  assert.match(itemsFit([{ ...ITEMS[0], id: 'Double' }], v).why, /an item id is/);
  assert.match(itemsFit([{ ...ITEMS[0], name: ' ' }], v).why, /names itself/);
  assert.match(itemsFit([{ ...ITEMS[0], priceSat: 0n }], v).why, /costs 1 to/);
  assert.match(itemsFit([{ ...ITEMS[0], priceSat: 500 }], v).why, /costs 1 to/, 'a price is a BigInt, never a float');
  assert.match(itemsFit([{ ...ITEMS[0], unlock: new Uint8Array(31) }], v).why, /32-byte hash/);
  assert.throws(() => encodeManifestBody({ ...BODY, items: ITEMS, requiredProtocolVersion: 9 }), /requires protocol version/);
});

test('until version 10 is spoken, no node hosts a game with items', () => {
  assert.equal(SUPPORTED_PROTOCOL_VERSIONS.includes(ITEMS_VERSION), false, 'added only once the purchase and its money path are built');
  const st = manifestStands(signed({ ...BODY, items: ITEMS, requiredProtocolVersion: ITEMS_VERSION }), { verify: verifyEd25519 });
  assert.equal(st.ok, false);
  assert.match(st.why, /sells items under protocol version .*which this build does not speak/);
  assert.equal(manifestStands(signed(BODY), { verify: verifyEd25519 }).ok, true);
});

test('the split: 50 % equal per served node, the rest halved between protocol devs and game dev as a donation is, every msat accounted', () => {
  const k = (n) => n.toString(16).padStart(2, '0').repeat(32);
  const even = itemSplit({ priceMsat: 2100000n, nodes: [k(2), k(1), k(3), k(4)] });
  assert.deepEqual([even.protocolMsat, even.gameMsat, even.nodesMsat, even.perNodeMsat, even.sumMsat], [525000n, 525000n, 1050000n, 262500n, 2100000n]);
  assert.deepEqual(even.nodes.map((n) => n.key), [k(1), k(2), k(3), k(4)], 'sorted by key');
  // 1001 msat over 3 nodes: 500 for the nodes -> 166 each (498); the developers 503 -> protocol 251 (floored), game 252
  const odd = itemSplit({ priceMsat: 1001n, nodes: [k(7), k(8), k(9), k(9)] });
  assert.deepEqual([odd.perNodeMsat, odd.nodesMsat, odd.devsMsat, odd.protocolMsat, odd.gameMsat, odd.sumMsat, odd.nodes.length], [166n, 498n, 503n, 251n, 252n, 1001n, 3], 'a key listed twice is one node');
  const one = itemSplit({ priceMsat: 1n, nodes: [k(5)] });
  assert.deepEqual([one.protocolMsat, one.gameMsat, one.nodesMsat], [0n, 1n, 0n]);
  // 500 sat (the larger truck, #369) over the 12 nodes measured on 2026-10-15: 20,833 msat each (249,996), the devs 125,002 each
  const truck = itemSplit({ priceMsat: 500000n, nodes: Array.from({ length: 12 }, (_, i) => k(i + 1)) });
  assert.deepEqual([truck.perNodeMsat, truck.nodesMsat, truck.protocolMsat, truck.gameMsat], [20833n, 249996n, 125002n, 125002n]);
  assert.throws(() => itemSplit({ priceMsat: 1000n, nodes: [] }), /no node served a round/);
  assert.throws(() => itemSplit({ priceMsat: 0n, nodes: [k(1)] }), /at least 1 msat/);
  assert.throws(() => itemSplit({ priceMsat: 1000n, nodes: ['xyz'] }), /32-byte key/);
});
