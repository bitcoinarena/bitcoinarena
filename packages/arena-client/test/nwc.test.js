// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NOSTR WALLET CONNECT FOR DEPOSITS (kanban #277): a wallet service answering NIP-47 over the game's relay - one that speaks
// NIP-44 (its info event says so) and one that speaks only NIP-04 - pays the deposit invoice the page hands it; a wallet's
// error comes back as the error; a link that is not one is refused before anything is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRelay } from '../../arena-node/src/nostr-relay.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip04 from 'nostr-tools/nip04';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { parseNwc, nwcPay, nwcBalance, nwcInfo } from '../nostr/nwc.js';

const hex = (b) => Buffer.from(b).toString('hex');
// A WALLET SERVICE: answers pay_invoice with a preimage (or `error`), get_balance with its balance
async function wallet(url, { nip44only = false, error = null } = {}) {
  const pool = new SimplePool();
  const sk = generateSecretKey(), pk = getPublicKey(sk);
  const app = generateSecretKey();
  const paid = [];
  if (nip44only) await Promise.allSettled(pool.publish([url], finalizeEvent({ kind: 13194, created_at: Math.floor(Date.now() / 1000), content: 'pay_invoice get_balance get_info', tags: [['encryption', 'nip44_v2 nip04']] }, sk)));
  const sub = pool.subscribeMany([url], { kinds: [23194], '#p': [pk] }, { onevent: async (ev) => {
    const use44 = ev.tags.some((t) => t[0] === 'encryption' && t[1] === 'nip44_v2');
    const ck = nip44.getConversationKey(sk, ev.pubkey);
    const req = JSON.parse(use44 ? nip44.decrypt(ev.content, ck) : await nip04.decrypt(sk, ev.pubkey, ev.content));
    let body;
    if (error) body = { result_type: req.method, error: { code: error, message: 'not enough sats in your wallet' } };
    else if (req.method === 'pay_invoice') { paid.push({ invoice: req.params.invoice, enc: use44 ? 'nip44' : 'nip04' }); body = { result_type: 'pay_invoice', result: { preimage: 'ab'.repeat(32), fees_paid: 0 } }; }
    else if (req.method === 'get_balance') body = { result_type: 'get_balance', result: { balance: 123000 } };
    const text = JSON.stringify(body);
    const content = use44 ? nip44.encrypt(text, ck) : await nip04.encrypt(sk, ev.pubkey, text);
    await Promise.allSettled(pool.publish([url], finalizeEvent({ kind: 23195, created_at: Math.floor(Date.now() / 1000), content, tags: [['p', ev.pubkey], ['e', ev.id]] }, sk)));
  } });
  return { uri: `nostr+walletconnect://${pk}?relay=${encodeURIComponent(url)}&secret=${hex(app)}`, paid, close: () => { sub.close(); pool.close([url]); } };
}
const INVOICE = 'lnbcrt3000n1pjtest0pp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdqqcqzzsxqyz5vqsp5test';

test('a wallet that speaks NIP-44 and one that speaks only NIP-04 each pay the deposit invoice; the balance reads', async () => {
  const r = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${r.port}`;
  const pool = new SimplePool();
  const w44 = await wallet(url, { nip44only: true }), w04 = await wallet(url);
  try {
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual((await nwcInfo(w44.uri, { pool })).encryption, ['nip44_v2', 'nip04']);
    const p1 = await nwcPay(w44.uri, INVOICE, { pool, timeoutMs: 5000 });
    assert.equal(p1.preimage, 'ab'.repeat(32));
    assert.deepEqual(w44.paid, [{ invoice: INVOICE, enc: 'nip44' }]);
    const p2 = await nwcPay(w04.uri, INVOICE, { pool, timeoutMs: 5000 });
    assert.equal(p2.preimage, 'ab'.repeat(32));
    assert.deepEqual(w04.paid, [{ invoice: INVOICE, enc: 'nip04' }]);
    assert.equal(await nwcBalance(w44.uri, { pool, timeoutMs: 5000 }), 123000);
    assert.ok(!r.events().some((e) => e.kind === 23194 || e.kind === 23195), 'requests and answers are not kept by the relay');
  } finally { w44.close(); w04.close(); pool.close([url]); await r.close(); }
});

test('the wallet\'s error is the error; a link that is not one, or an invoice that is not one, is refused before anything is sent', async () => {
  const r = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${r.port}`;
  const pool = new SimplePool();
  const broke = await wallet(url, { error: 'INSUFFICIENT_BALANCE' });
  try {
    await assert.rejects(nwcPay(broke.uri, INVOICE, { pool, timeoutMs: 5000 }), (e) => e.code === 'INSUFFICIENT_BALANCE' && /not enough sats/.test(e.message));
    assert.throws(() => parseNwc('https://example.com'), /not a Nostr Wallet Connect link/);
    assert.throws(() => parseNwc(`nostr+walletconnect://${'ab'.repeat(32)}?secret=${'cd'.repeat(32)}`), /no relay/);
    await assert.rejects(nwcPay(broke.uri, 'hello', { pool }), /not a Lightning invoice/);
    assert.equal(parseNwc(broke.uri).relays[0], url);
  } finally { broke.close(); pool.close([url]); await r.close(); }
});
