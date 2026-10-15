// AN IN-GAME ITEM BOUGHT FROM THE PAGE (kanban #365): served list, split, payment, signed record, handed to a seat - with seats and a wallet
// standing in, the record a seat receives is one purchaseStands takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { buyItem, ownedItems, itemsKeyFor, entryItemsFor, entryUnlocks, shopOf, itemUnlocksOf } from '../src/item-buy.js';
import { entryItemDigest, encodeEntryContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
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

// THE ITEMS IN A RUN (kanban #369): one items key in every round, its proof per entry, the shop of a game, the unlocks a run starts with
const CURVE = { pointX: (sk) => schnorr.getPublicKey(sk), signSchnorr: (m, sk) => schnorr.sign(m, sk) };

test('the items key is the same in every round and not a round key; it proves an owned item for exactly one entry', () => {
  const seed = b32(0x42);
  const k = itemsKeyFor(seed, CURVE), again = itemsKeyFor(seed, CURVE);
  assert.equal(toHex(k.pubkey), toHex(again.pubkey));
  assert.notEqual(toHex(k.pubkey), toHex(itemsKeyFor(b32(0x43), CURVE).pubkey));
  const owned = [{ id: toHex(b32(0xd1)), itemId: 'large-truck' }, { id: toHex(b32(0xd2)), itemId: 'not-sold' }];
  const round = { protocolVersion: 10 };
  const items = entryItemsFor({ round, roundId: b32(1), playerPubkey: b32(2), owned, manifest: MANIFEST, key: k });
  assert.deepEqual(items.map((i) => i.itemId), ['large-truck'], 'only what the game sells');
  assert.ok(schnorr.verify(items[0].ownerSig, entryItemDigest({ roundId: b32(1), playerPubkey: b32(2), purchaseId: b32(0xd1) }), k.pubkey), 'signed for this entry by the items key');
  assert.equal(schnorr.verify(items[0].ownerSig, entryItemDigest({ roundId: b32(1), playerPubkey: b32(3), purchaseId: b32(0xd1) }), k.pubkey), false, 'not for another entry');
  assert.deepEqual(entryItemsFor({ round: { protocolVersion: 9 }, roundId: b32(1), playerPubkey: b32(2), owned, manifest: MANIFEST, key: k }), [], 'none before version 10');
  assert.deepEqual(entryItemsFor({ round, roundId: b32(1), playerPubkey: b32(2), owned, use: [], manifest: MANIFEST, key: k }), [], 'none when the player plays without it');
  // the entry carries them, and the run starts with their unlocks
  const entry = { roundId: b32(1), playerPubkey: b32(2), sessionPubkey: b32(3), stakeCommitment: b32(4), stakeMsat: 1000n, feeMsat: 50n, donationMsat: 0n, joinTick: 0,
    worldSecret: b32(5), vssSharesRef: b32(6), stakePoint: new Uint8Array(33).fill(7), feePreimage: b32(8), stakeLockOutpoint: { txid: b32(9), outIdx: 0n },
    feeLockOutpoint: { txid: b32(9), outIdx: 1n }, claimKeyAttestationRef: b32(10), items };
  const back = decodeEntryContract(encodeEntryContract(entry));
  assert.deepEqual(entryUnlocks(back, MANIFEST), [toHex(b32(0xa1))]);
  assert.deepEqual(entryUnlocks({}, MANIFEST), []);
});

test('the shop of a game is its newest version that sells anything', () => {
  const v1 = { id: 'a', manifest: { gameName: 'nextblock', version: 1 } };
  const v3 = { id: 'c', manifest: { ...MANIFEST, version: 3 } };
  const other = { id: 'x', manifest: { gameName: 'rps', version: 4, items: MANIFEST.items } };
  assert.equal(shopOf([v1], 'nextblock'), null);
  const shop = shopOf([v1, v3, other], 'nextblock');
  assert.equal(shop.game.id, 'c');
  assert.deepEqual(shop.items, [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n }]);
  assert.deepEqual(itemUnlocksOf(MANIFEST), { 'large-truck': toHex(b32(0xa1)) });
});
