// AN ITEM, BOUGHT (kanban #365 step 2): the buyer's signed record, its outputs rebuilt from the split, refused by name when anything differs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { encodePurchase, decodePurchase, purchaseId, purchaseOutputs, purchaseStands } from '../src/purchase.js';
import { ITEMS_VERSION } from '../src/constants.js';
import { SERVED_WINDOW_MS } from '../src/served-nodes.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...new Uint8Array(32).fill(n)]);
const BUYER = b32(0x77);
const BUYER_PUB = schnorr.getPublicKey(BUYER);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const DEV = b32(0xde);
const MANIFEST = { gameDevPubkey: DEV, gameName: 'nextblock', items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }], requiredProtocolVersion: ITEMS_VERSION };
const NETWORK = [{ recipientPk: pk33(0x11), label: 'protocol a', shareBps: 6000 }, { recipientPk: pk33(0x12), label: 'protocol b', shareBps: 4000 }];
const GAME = [{ recipientPk: pk33(0x21), label: 'game dev', shareBps: 10000 }];
const NODES = Array.from({ length: 12 }, (_, i) => ({ key: (i + 1).toString(16).padStart(2, '0').repeat(32), rounds: 1 }));
const TO = 1792090683000n, FROM = TO - BigInt(SERVED_WINDOW_MS);
const SERVED = { fromMs: FROM, toMs: TO, nodes: NODES, root: 'ab'.repeat(32) };

function bought(over = {}) {
  const { outputs } = purchaseOutputs({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME });
  const p = { gameDevPubkey: DEV, gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, playerPubkey: BUYER_PUB, federationId: b32(0xfe),
    txid: b32(0x7a), servedFromMs: FROM, servedToMs: TO, servedRoot: b32(0xab), outputs: outputs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })),
    boughtAtMs: TO + 60000n, ...over };
  return { ...p, signature: schnorr.sign(purchaseId(p), BUYER) };
}

test('the outputs of a 500 sat item: 12 nodes 20,833 msat each, the developers\' half over both sets, every msat paid', () => {
  const { outputs, split, devs } = purchaseOutputs({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NETWORK, gameSet: GAME });
  assert.equal(outputs.length, 15);
  assert.equal(outputs.reduce((t, o) => t + o.msat, 0n), 500000n);
  assert.deepEqual([split.perNodeMsat, split.devsMsat], [20833n, 250004n]);
  assert.deepEqual(devs.shares.map((s) => [s.label, s.amountMsat]), [['protocol a', 75002n], ['protocol b', 50000n], ['game dev', 125002n]]);
  assert.throws(() => purchaseOutputs({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: [{ lnurl: 'lnurl1x', shareBps: 10000 }], gameSet: [{ lnurl: 'lnurl1y', shareBps: 10000 }] }),
    /must pay keys, not LNURLs/);
});

test('a purchase encodes, decodes to itself, and stands when its outputs are the split and the buyer signed it', () => {
  const p = bought();
  const back = decodePurchase(encodePurchase(p));
  assert.equal(toHex(encodePurchase(back)), toHex(encodePurchase(p)));
  const st = purchaseStands(p, { manifest: MANIFEST, networkSet: NETWORK, gameSet: GAME, served: SERVED, verify });
  assert.deepEqual([st.ok, toHex(st.id)], [true, toHex(purchaseId(p))]);
});

test('a purchase that pays anything else, of anything else, against another list, or unsigned does not stand', () => {
  const s = (p) => purchaseStands(p, { manifest: MANIFEST, networkSet: NETWORK, gameSet: GAME, served: SERVED, verify }).why;
  const p = bought();
  const stolen = bought({ outputs: p.outputs.map((o, i) => (i === 0 ? { ...o, pk: pk33(0x99) } : o)) });
  assert.match(s(stolen), /its outputs are not the split/);
  const short = bought({ outputs: p.outputs.slice(1) });
  assert.match(s(short), /its outputs are not the split/);
  assert.match(s(bought({ itemId: 'gold-truck' })), /sells no item "gold-truck"/);
  assert.match(s(bought({ priceSat: 400n })), /costs 500 sat, and the purchase paid 400/);
  assert.match(s(bought({ gameName: 'other' })), /not of the manifest given/);
  assert.match(purchaseStands(p, { manifest: MANIFEST, networkSet: NETWORK, gameSet: GAME, served: { ...SERVED, root: 'cd'.repeat(32) }, verify }).why, /paid the served list abababab/);
  assert.match(s(bought({ boughtAtMs: TO + 2n * 3600000n })), /ends at most an hour before the purchase/);
  assert.match(s(bought({ servedFromMs: FROM + 1n })), /the served window is 24 hours/);
  assert.match(s({ ...p, signature: new Uint8Array(64) }), /signature does not verify/);
  assert.match(s({ ...p, txid: b32(0x7b) }), /signature does not verify/, 'the transaction is part of what the buyer signed');
});
