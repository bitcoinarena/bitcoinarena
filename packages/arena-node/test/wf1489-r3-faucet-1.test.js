// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r3-faucet-1: A WINNER'S LIGHTNING ADDRESS IS READ WHOLE ON EVERY SEAT. The winner names the address (POST /payout-address, signed by
// its own session key - any player); at settlement the coordinator (propose) and every other signer seat (check) ask that address's LNURL
// endpoint and its callback through WinningsSend.payRequest / invoiceFor, and read the answer with Response.json() - no byte limit, only the
// 15 s bound. The player's own server answers a pay request of hundreds of MB (a JSON array of 200M numbers is GBs of heap): every seat of the
// committee reads it at once and runs out of memory. Safe: an LNURL answer (a few KB by LUD-06) is cut at a small limit and refused - the
// seat reads no more than that of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WinningsSend } from '../src/winnings-send.js';

const MB = 1 << 20;
function hugeAnswer(totalBytes, counter) {
  const head = Buffer.from('{"tag":"payRequest","callback":"https://w.example/cb","minSendable":1000,"maxSendable":100000000000,"metadata":"[]","pad":"');
  const tail = Buffer.from('"}');
  // network-sized chunks (kanban #1562): a stream reads one chunk ahead, so with 1 MB chunks any read past the head counted > 1 MB
  const chunk = Buffer.alloc(16 * 1024, 0x61);
  let sent = 0, headSent = false, done = false;
  return new ReadableStream({
    pull(c) {
      if (done) return;
      let part;
      if (!headSent) { part = head; headSent = true; }
      else if (sent < totalBytes) { part = chunk; sent += chunk.length; }
      else { part = tail; done = true; }
      counter.bytes += part.length;
      c.enqueue(new Uint8Array(part));
      if (done) c.close();
    },
  });
}

test('#1489 r3-faucet-1: a winner\'s LNURL endpoint cannot make a seat read an answer of any size', async () => {
  const counter = { bytes: 0 };
  const lnurlFetch = async () => new Response(hugeAnswer(96 * MB, counter), { headers: { 'content-type': 'application/json' } });
  const ws = new WinningsSend({ round: null, port: null, curve: null, random: null, peersFor: () => [], fetcher: null, lnurlFetch, network: 'testnet4', lnurlMs: 60000 });
  const r = await ws.payRequest('winner@w.example', 50000n);
  console.log(`payRequest ok=${r.ok}; bytes the seat read of the address's answer: ${counter.bytes}`);
  assert.ok(counter.bytes < 1 * MB, `the seat read ${(counter.bytes / MB).toFixed(1)} MB of one player's LNURL answer (an LNURL pay request is a few KB)`);
  assert.equal(r.ok, false, 'an oversized pay request is refused');
});
