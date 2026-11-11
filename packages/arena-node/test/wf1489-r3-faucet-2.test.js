// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r3-faucet-2: THE FAUCET READS A STRANGER'S LIGHTNING ADDRESS ANSWER WHOLE. POST /feedback (any origin, no key needed: an unsigned
// report's "Bounty address:" line, or a signed report's lnAddress) and GET /feedback/lnaddress run lnAddressWorks on the address the caller names;
// the admin's "reward" runs lnAddressInvoice on it. Both read the answer with r.json() - no byte limit, only the 8-10 s timeout. The stranger's
// server answers hundreds of MB of JSON: the faucet process (players' welcomes, the node faucet, the mainnet bounty payer) runs out of memory.
// Safe: an LNURL answer is cut at a small limit and refused; the faucet reads no more than that of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lnAddressWorks, lnAddressInvoice } from '../src/feedback-store.js';

const MB = 1 << 20;
function hugeAnswer(totalBytes, counter) {
  const head = Buffer.from('{"tag":"payRequest","callback":"https://w.example/cb","minSendable":1000,"maxSendable":100000000000,"pad":"');
  const tail = Buffer.from('"}');
  const chunk = Buffer.alloc(16 * 1024, 0x61); // network-sized parts (a 1 MB part is already over the bound before any reader can stop)
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

test('#1489 r3-faucet-2: the bounty-address check reads at most a small answer', async () => {
  const counter = { bytes: 0 };
  const fetchFn = async () => new Response(hugeAnswer(96 * MB, counter), { headers: { 'content-type': 'application/json' } });
  const w = await lnAddressWorks('x@attacker.example', { fetchFn, timeoutMs: 60000 });
  console.log(`lnAddressWorks ok=${w.ok}; bytes read: ${counter.bytes}`);
  assert.ok(counter.bytes < 1 * MB, `lnAddressWorks read ${(counter.bytes / MB).toFixed(1)} MB of a stranger's answer`);
  assert.equal(w.ok, false);
});

test('#1489 r3-faucet-2: the reward payout to an address reads at most a small answer', async () => {
  const counter = { bytes: 0 };
  const fetchFn = async () => new Response(hugeAnswer(96 * MB, counter), { headers: { 'content-type': 'application/json' } });
  const i = await lnAddressInvoice('x@attacker.example', 1000, '', { fetchFn, timeoutMs: 60000 });
  console.log(`lnAddressInvoice ok=${i.ok}; bytes read: ${counter.bytes}`);
  assert.ok(counter.bytes < 1 * MB, `lnAddressInvoice read ${(counter.bytes / MB).toFixed(1)} MB of a stranger's answer`);
  assert.equal(i.ok, false);
});
