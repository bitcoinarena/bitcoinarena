// AN IN-GAME ITEM BOUGHT FROM THE PAGE (kanban #365): served list, split, payment, signed record, handed to a seat - with seats and a wallet
// standing in, the record a seat receives is one purchaseStands takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { buyItem, ownedItems } from '../src/item-buy.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { decodePurchase, purchaseStands } from '../../arena-protocol/src/purchase.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NOW = 1792090683000;
const NODES = [b32(0x31), b32(0x32), b32(0x33)];
const NODE_KEYS = NODES.map((s) => schnorr.getPublicKey(s));
const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }], requiredProtocolVersion: 10 };
const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const BUYER = b32(0x77);
const player = { pubkey: schnorr.getPublicKey(BUYER), sign: (d) => schnorr.sign(d, BUYER) };
const ROUND = b32(0x5a);
const finals = NODES.map((s) => signFinalSig({ roundId: ROUND, entryId: b32(1), runId: b32(2), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(NOW - 3600000) }, (d) => schnorr.sign(d, s)));

function seatsWith({ keep = 200 } = {}) {
  const posted = [];
  const fetch = async (url, o = {}) => {
    if (url.includes('/served?')) return { ok: true, json: async () => ({ held: [{ roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: finals.map(toHex) }] }) };
    if (url.endsWith('/item-purchase')) { posted.push(JSON.parse(o.body)); return { ok: keep === 200, status: keep, text: async () => 'not now' }; }
    if (url.includes('/items?')) return { ok: true, json: async () => ({ items: [{ itemId: 'large-truck', gameName: 'nextblock' }] }) };
    throw new Error(`no such door ${url}`);
  };
  return { fetch, posted };
}
const walletPaying = (fail = null) => ({
  paySubmit: async (json) => { if (fail) throw new Error(fail); const outs = JSON.parse(json); return JSON.stringify({ txid: '9a'.repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })), payouts: outs }); },
  lockAccepted: async (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, ids_match: true })) }); },
});

test('bought: the split paid in one transaction, the signed record handed to a seat, and it stands there', async () => {
  const { fetch, posted } = seatsWith();
  const r = await buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: walletPaying(), federationId: 'fe'.repeat(32),
    player, seats: ['https://s1', 'https://s2'], fetch, verify, nowMs: () => NOW });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.keptBy, r.priceSat, r.outputs, posted.length], ['https://s1', 500n, 5, 1]);
  const p = { ...decodePurchase(fromHex(posted[0].purchase)), signature: fromHex(posted[0].signature) };
  assert.equal(p.outputs.reduce((t, o) => t + o.msat, 0n), 500000n, 'the whole price, to the msat');
  const served = { fromMs: p.servedFromMs, toMs: p.servedToMs, nodes: NODE_KEYS.map((k) => ({ key: toHex(k), rounds: 1 })).sort((a, b) => (a.key < b.key ? -1 : 1)), root: toHex(p.servedRoot) };
  assert.equal(purchaseStands(p, { manifest: MANIFEST, networkSet: NET, gameSet: NET, served, verify }).ok, true);
  assert.deepEqual((await ownedItems({ seats: ['https://s1'], player: player.pubkey, fetch })).map((i) => i.itemId), ['large-truck']);
});

test('refused by step: an item not sold, a payment that fails, a record no seat keeps (paid, kept for a retry)', async () => {
  const { fetch } = seatsWith();
  const base = { manifest: MANIFEST, networkSet: NET, gameSet: NET, federationId: 'fe'.repeat(32), player, seats: ['https://s1'], fetch, verify, nowMs: () => NOW };
  assert.deepEqual(Object.entries(await buyItem({ ...base, itemId: 'gold-truck', wallet: walletPaying() })).filter(([k]) => k !== 'why'), [['ok', false], ['step', 'item']]);
  const failed = await buyItem({ ...base, itemId: 'large-truck', wallet: walletPaying('Balance is too low') });
  assert.deepEqual([failed.ok, failed.step], [false, 'payment']); assert.match(failed.why, /Balance is too low/);
  const notKept = seatsWith({ keep: 409 });
  const r = await buyItem({ ...base, fetch: notKept.fetch, itemId: 'large-truck', wallet: walletPaying() });
  assert.deepEqual([r.ok, r.step], [false, 'record']); assert.match(r.why, /paid \(transaction 9a9a.*no seat kept the record yet: https:\/\/s1: 409 not now/);
  assert.ok(r.retry && r.purchaseId, 'the record to hand again');
});
