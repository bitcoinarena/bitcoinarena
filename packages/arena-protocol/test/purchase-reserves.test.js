// AN ITEM ON THE RESERVES' TERMS (§27A.9.1, kanban #397 slice 5): a game version requiring protocol 11 sells its items for nodes
// 40 %, the protocol reserves exactly 20 % to the federation's 5-of-7 reserve key, and the developers the buyer's 40/30/20/10/0 % -
// and a record that leaves the reserves' share out, pays it short or long, or to another key, does not stand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { encodePurchase, decodePurchase, purchaseId, purchaseOutputs, purchaseOutputsReserves, purchaseStands, PURCHASE_RESERVES_LAYOUT } from '../src/purchase.js';
import { gameIdOf } from '../src/manifest.js';
import { ITEMS_VERSION, RESERVES_VERSION } from '../src/constants.js';
import { SERVED_WINDOW_MS } from '../src/served-nodes.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...new Uint8Array(32).fill(n)]);
const BUYER = b32(0x77);
const BUYER_PUB = schnorr.getPublicKey(BUYER);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
import { MANIFEST_V3 } from '../../nextblock/plugin/nextblock-v3.js';
// Tick Tock's version 3 as signed, and a version 4 that requires protocol 11 (signature zeroed: gameIdOf hashes, it does not verify)
const DEV = MANIFEST_V3.gameDevPubkey;
const V3 = MANIFEST_V3;
const V4 = { ...MANIFEST_V3, version: 4, requiredProtocolVersion: RESERVES_VERSION, signature: new Uint8Array(64) };
assert.equal(V3.requiredProtocolVersion, ITEMS_VERSION);
const NETWORK = [{ recipientPk: pk33(0x11), label: 'protocol a', shareBps: 6000 }, { recipientPk: pk33(0x12), label: 'protocol b', shareBps: 4000 }];
const GAME = [{ recipientPk: pk33(0x21), label: 'game dev', shareBps: 10000 }];
const NODES = Array.from({ length: 3 }, (_, i) => ({ key: (i + 1).toString(16).padStart(2, '0').repeat(32), rounds: 1 }));
const RESERVE = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0xc3)]);
const TO = 1792090683000n, FROM = TO - BigInt(SERVED_WINDOW_MS);
const SERVED = { fromMs: FROM, toMs: TO, nodes: NODES, root: 'ab'.repeat(32) };
const V4_ID = gameIdOf(V4);
const manifestV4 = V4;

function bought({ devsPct = 40, outputs = null, over = {}, reserveKey = RESERVE } = {}) {
  const built = purchaseOutputsReserves({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME, devsPct, reserveKey });
  const outs = outputs ? outputs(built.outputs) : built.outputs;
  const p = { gameDevPubkey: DEV, gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, devsPct, gameId: V4_ID, reserveKey, playerPubkey: BUYER_PUB,
    federationId: b32(0xfe), txid: b32(0x7a), servedFromMs: FROM, servedToMs: TO, servedRoot: b32(0xab),
    outputs: outs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), boughtAtMs: TO + 60000n, ...over };
  return { ...p, signature: schnorr.sign(purchaseId(p), BUYER) };
}
const stands = (p, more = {}) => purchaseStands(p, { manifest: manifestV4, networkSet: NETWORK, gameSet: GAME, served: SERVED, verify, reserveKey: RESERVE, ...more });
const reserveOut = (outs) => outs.filter((o) => toHex(o.pk) === toHex(RESERVE));

test('a 500 sat item at 40 %: nodes 200,000 msat over 3 nodes, reserves exactly 100,000 to the reserve key, developers 200,000', () => {
  const b = purchaseOutputsReserves({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME, devsPct: 40, reserveKey: RESERVE });
  assert.deepEqual(reserveOut(b.outputs).map((o) => o.msat), [100000n], 'one reserve output of exactly 20 %');
  assert.equal(b.split.perNodeMsat, 66666n);
  assert.equal(b.devs.shares.reduce((t, s) => t + s.amountMsat, 0n), 200000n);
  assert.equal(b.outputs.reduce((t, o) => t + o.msat, 0n), 500000n - 2n, 'the per-node floors (2 msat) are not paid');
  const zero = purchaseOutputsReserves({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME, devsPct: 0, reserveKey: RESERVE });
  assert.deepEqual(reserveOut(zero.outputs).map((o) => o.msat), [100000n], 'at 0 % the reserves still take 100,000');
  assert.equal(zero.outputs.reduce((t, o) => t + o.msat, 0n), 300000n - 2n, 'and the buyer pays 300 sat');
  assert.throws(() => purchaseOutputsReserves({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME, devsPct: 50, reserveKey: RESERVE }), /one of 40, 30, 20, 10, 0/);
  assert.throws(() => purchaseOutputsReserves({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME, reserveKey: null }), /no reserve key/);
  assert.throws(() => purchaseOutputsReserves({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME, reserveKey: pk33(0x21) }), /must stand alone/);
});

test('the record on the reserves\' terms: layout 12, its share, game version and reserve key round-trip, and it stands', () => {
  const p = bought();
  const bytes = encodePurchase(p);
  assert.equal((bytes[1] << 8) | bytes[2], PURCHASE_RESERVES_LAYOUT);
  const back = decodePurchase(bytes);
  assert.deepEqual([back.devsPct, toHex(back.gameId), toHex(back.reserveKey)], [40, toHex(V4_ID), toHex(RESERVE)]);
  assert.equal(toHex(encodePurchase(back)), toHex(bytes));
  const st = stands(p);
  assert.equal(st.ok, true, st.why);
  for (const pct of [30, 20, 10, 0]) assert.equal(stands(bought({ devsPct: pct })).ok, true, `${pct} %`);
});

test('refused: the reserve share missing, 1 msat short or long, to another key, another federation key, another version, old terms', () => {
  const why = (p, more) => stands(p, more).why;
  const missing = bought({ outputs: (o) => o.filter((x) => toHex(x.pk) !== toHex(RESERVE)) });
  assert.match(why(missing), /its outputs are not the split/);
  const short = bought({ outputs: (o) => o.map((x) => (toHex(x.pk) === toHex(RESERVE) ? { ...x, msat: 99999n } : x)) });
  assert.match(why(short), /its outputs are not the split/);
  const long = bought({ outputs: (o) => o.map((x) => (toHex(x.pk) === toHex(RESERVE) ? { ...x, msat: 100001n } : x)) });
  assert.match(why(long), /its outputs are not the split/);
  const elsewhere = bought({ outputs: (o) => o.map((x) => (toHex(x.pk) === toHex(RESERVE) ? { ...x, pk: pk33(0x99) } : x)) });
  assert.match(why(elsewhere), /its outputs are not the split/);
  assert.match(why(bought({ reserveKey: pk33(0x55) })), /paid reserve key 0255555555555555, and federation fefefefefefefefe's is 02c3c3c3c3c3c3c3/);
  assert.match(why(bought(), { reserveKey: null }), /no reserve key is known here/);
  assert.match(why(bought({ over: { gameId: b32(0x45) } })), /names another version of the game/);
  // an old-terms record against the version that sells on the reserves' terms, and a reserves record against an old version
  const { outputs } = purchaseOutputs({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME });
  const old0 = { gameDevPubkey: DEV, gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, playerPubkey: BUYER_PUB, federationId: b32(0xfe), txid: b32(0x7a),
    servedFromMs: FROM, servedToMs: TO, servedRoot: b32(0xab), outputs: outputs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), boughtAtMs: TO + 60000n };
  const old = { ...old0, signature: schnorr.sign(purchaseId(old0), BUYER) };
  assert.match(why(old), /requires protocol 11: its items pay the protocol reserves, and this record does not/);
  assert.equal(purchaseStands(old, { manifest: V3, networkSet: NETWORK, gameSet: GAME, served: SERVED, verify }).ok, true, 'version 3 keeps its terms');
  assert.match(purchaseStands(bought(), { manifest: V3, networkSet: NETWORK, gameSet: GAME, served: SERVED, verify, reserveKey: RESERVE }).why, /does not sell on those terms/);
  assert.throws(() => encodePurchase({ ...bought(), devsPct: 50 }), /one of 40, 30, 20, 10, 0/);
});
