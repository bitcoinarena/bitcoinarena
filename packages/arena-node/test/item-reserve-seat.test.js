// AN ITEM ON THE RESERVES' TERMS, AS A SEAT KEEPS IT (kanban #397 slice 5): every output checked with the federation as before, and the
// reserves' 20 % kept as a reserve row under the federation's reserve key - what GET /reserves counts, labelled with the item. A
// purchase whose reserve output the federation does not hold, or holds 1 msat short, is refused and leaves no row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { keepItemPurchase, itemsOwned } from '../src/item-purchase-seat.js';
import { reserveFigures } from '../src/reserve-book.js';
import { purchaseOutputsReserves, purchaseId } from '../../arena-protocol/src/purchase.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';
import { RESERVES_VERSION } from '../../arena-protocol/src/constants.js';
import { SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { MANIFEST_V3 } from '../../nextblock/plugin/nextblock-v3.js';
import { joinedWithLock, CLAIM } from './lock-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const SECRET = b32(0x77), BUYER = schnorr.getPublicKey(SECRET);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const V4 = { ...MANIFEST_V3, version: 4, requiredProtocolVersion: RESERVES_VERSION, signature: new Uint8Array(64) };
const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const NODES = Array.from({ length: 7 }, (_, i) => ({ key: (i + 1).toString(16).padStart(2, '0').repeat(32), rounds: 1 }));
const RESERVE = pk33(0xc3);
const FED = b32(0xfe);
const TO = 1792090683000n, FROM = TO - BigInt(SERVED_WINDOW_MS);
const SERVED = { fromMs: FROM, toMs: TO, nodes: NODES, root: 'ab'.repeat(32) };
const cid = (f) => createHash('sha256').update(JSON.stringify(f, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))).digest('hex');
const fedWith = (held) => ({ status: async (o) => { const c = held.get(`${toHex(o.txid)}:${o.outIdx}`); return c ? { stored: { contractId: c } } : null; }, contractId: async (f) => cid(f) });
const contractOf = (p, o, msat = o.msat) => cid({ paymentImage: { kind: 'hash', bytes: p.playerPubkey }, amountMsat: msat, claimPk: o.pk, refundPk: o.pk, expiration: 0 });

function bought(devsPct = 40) {
  const { outputs } = purchaseOutputsReserves({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NET, gameSet: NET, devsPct, reserveKey: RESERVE });
  const p = { gameDevPubkey: V4.gameDevPubkey, gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, devsPct, gameId: gameIdOf(V4), reserveKey: RESERVE,
    playerPubkey: BUYER, federationId: FED, txid: b32(0x7a), servedFromMs: FROM, servedToMs: TO, servedRoot: b32(0xab),
    outputs: outputs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), boughtAtMs: TO + 60000n };
  return { ...p, signature: schnorr.sign(purchaseId(p), SECRET) };
}
const heldFor = (p, reserveMsat = null) => new Map(p.outputs.map((o) => [`${toHex(p.txid)}:${o.outIdx}`,
  contractOf(p, o, toHex(o.pk) === toHex(RESERVE) && reserveMsat !== null ? reserveMsat : o.msat)]));

test('kept: the reserves\' 100,000 msat is a reserve row under the reserve key, counted by /reserves\' figures and named by its item', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  try {
    const p = bought();
    const a = await keepItemPurchase({ p, manifest: V4, networkSet: NET, gameSet: NET, served: SERVED, port: fedWith(heldFor(p)), db: s.d.round.db, verify,
      reserveKey: RESERVE, keepReserve: (row) => s.d.round.putDonationOutputs([row]) });
    assert.deepEqual([a.ok, a.kept], [true, 'new'], a.why);
    const rows = s.d.round.donationsFor(toHex(RESERVE));
    assert.deepEqual(rows.map((r) => [r.amountMsat, r.entryId, r.item, r.federationId]), [['100000', toHex(purchaseId(p)), 'nextblock · large-truck', toHex(FED)]]);
    const f = reserveFigures(rows, { federationId: toHex(FED) });
    assert.deepEqual([f.heldMsat, f.entries, f.paidIn[0].item, f.paidIn[0].amountMsat], ['100000', 1, 'nextblock · large-truck', '100000']);
    assert.equal(itemsOwned(s.d.round.db, { player: toHex(BUYER) }).length, 1, 'and the buyer owns the truck');
  } finally { await s.close(); }
});

test('refused, and no reserve row: the reserve output not held, held 1 msat short, the seat knowing another reserve key', async () => {
  const s = await joinedWithLock({ claimKeyFor: () => CLAIM });
  try {
    const p = bought();
    const at = (o) => `${toHex(p.txid)}:${o.outIdx}`;
    const resOut = p.outputs.find((o) => toHex(o.pk) === toHex(RESERVE));
    const notHeld = heldFor(p); notHeld.delete(at(resOut));
    const keep = (row) => s.d.round.putDonationOutputs([row]);
    const base = { p, manifest: V4, networkSet: NET, gameSet: NET, served: SERVED, db: s.d.round.db, verify, reserveKey: RESERVE, keepReserve: keep };
    const a = await keepItemPurchase({ ...base, port: fedWith(notHeld) });
    assert.deepEqual([a.ok, a.status], [false, 409]); assert.match(a.why, /holds nothing at/);
    const b = await keepItemPurchase({ ...base, port: fedWith(heldFor(p, 99999n)) });
    assert.deepEqual([b.ok, b.status], [false, 422]); assert.match(b.why, /is not 100000 msat to key 02c3c3c3/);
    const c = await keepItemPurchase({ ...base, port: fedWith(heldFor(p)), reserveKey: pk33(0x55) });
    assert.deepEqual([c.ok, c.status], [false, 422]); assert.match(c.why, /paid reserve key 02c3c3c3/);
    assert.deepEqual(s.d.round.donationsFor(toHex(RESERVE)), [], 'no reserve row');
    assert.deepEqual(itemsOwned(s.d.round.db, { player: toHex(BUYER) }), [], 'and no ownership');
  } finally { await s.close(); }
});
