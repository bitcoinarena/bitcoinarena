// POST /item-purchase and GET /items (kanban #365): the doors answer by name before any game sells an item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { encodePurchase, purchaseId } from '../../arena-protocol/src/purchase.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { opts } from './window-fixture.js';

const b32 = (n) => new Uint8Array(32).fill(n);
test('a purchase of a game this seat does not host is refused by name; a malformed one is a 400; nobody owns anything yet', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const at = `http://127.0.0.1:${d.port}`;
    const post = async (body) => { const r = await fetch(`${at}/item-purchase`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }); return [r.status, (await r.text()).trim()]; };
    assert.equal((await post('not json'))[0], 400);
    assert.equal((await post({ purchase: 'zz', signature: '' }))[0], 400);
    const secret = b32(0x77);
    const p = { gameDevPubkey: b32(0xde), gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, playerPubkey: schnorr.getPublicKey(secret), federationId: b32(0xfe),
      txid: b32(0x7a), servedFromMs: 1n, servedToMs: 86400001n, servedRoot: b32(0xab), outputs: [{ outIdx: 0, pk: Uint8Array.from([2, ...b32(1)]), msat: 500000n }], boughtAtMs: 86400002n };
    const [st, why] = await post({ purchase: toHex(encodePurchase(p)), signature: toHex(schnorr.sign(purchaseId(p), secret)) });
    assert.equal(st, 404); assert.match(why, /hosts no game "nextblock" by dededede.* selling "large-truck"/);
    const items = await (await fetch(`${at}/items?player=${toHex(p.playerPubkey)}`)).json();
    assert.deepEqual(items.items, []);
    assert.equal((await fetch(`${at}/items?player=xyz`)).status, 400);
  } finally { await d.close(); }
});
