// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ANSWER BELONGS TO ITS REQUEST (kanban #1471, feedback #004 by Hexbox Tools 2026-11-11): nwcCall decrypted any EVENT the relay sent and took it. The
// relay cannot forge a wallet's answer (the NIP-04 secret), but it could replay an earlier genuine one - an old "paid" for a new payment. Here the relay
// replays the wallet's first answer, then the wallet answers the second request: only the second is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { tabWallet, nwcCall, walletBudget, budgetLine, makeInvoice, spendLog, spentLine, parseConnection, nip04Decrypt, nip04Encrypt, signEvent, NWC_REQUEST, NWC_RESPONSE } from '../src/nwc.js';
import { pageCurve } from '../src/page-curve.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const rand = (n) => new Uint8Array(randomBytes(n));
test('#1471 a replayed earlier answer of the same wallet is passed over; the answer to this request is taken', async () => {
  const walletSecret = rand(32), walletPubkey = pageCurve.pointX(walletSecret);
  let n = 0, firstReply = null;
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (sock) => {
    const subs = new Set();
    sock.on('message', async (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame[0] === 'REQ') { subs.add(frame[1]); return; }
      if (frame[0] !== 'EVENT') return;
      const event = frame[1]; sock.send(JSON.stringify(['OK', event.id, true, '']));
      n += 1;
      const content = await nip04Encrypt(JSON.stringify({ result_type: 'get_balance', result: { balance: n * 1000 } }), { secret: walletSecret, theirPubkey: fromHex(event.pubkey), curve: pageCurve, random: rand });
      const reply = await signEvent({ kind: NWC_RESPONSE, tags: [['p', event.pubkey], ['e', event.id]], content, secret: walletSecret, curve: pageCurve });
      if (n === 1) firstReply = reply;
      // the second time: the relay first replays the first, genuine answer on the new subscription, the wallet's real answer comes 150 ms later
      if (n === 2) { for (const sub of subs) sock.send(JSON.stringify(['EVENT', sub, firstReply])); await new Promise((r) => setTimeout(r, 150)); }
      for (const sub of subs) sock.send(JSON.stringify(['EVENT', sub, reply]));
    });
  });
  await new Promise((r) => wss.on('listening', r));
  const where = parseConnection(`nostr+walletconnect://${toHex(walletPubkey)}?relay=ws://127.0.0.1:${wss.address().port}&secret=${toHex(rand(32))}`);
  try {
    const opts = { curve: pageCurve, random: rand, timeoutMs: 5000 };
    const one = await nwcCall(where, { method: 'get_balance', params: {} }, opts);
    const two = await nwcCall(where, { method: 'get_balance', params: {} }, opts);
    console.log('  FACTS (#1471):', JSON.stringify({ one: one.result, two: two.result }));
    assert.deepEqual(one.result, { balance: 1000 });
    assert.deepEqual(two.result, { balance: 2000 }, 'the replayed first answer was taken for the second request');
  } finally { await new Promise((r) => wss.close(r)); }
});
