// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 6: THE #1511 "NEVER AN INTERNAL HOST" CHECK LOOKS AT THE NAME, NOT WHERE IT LEADS. lnAddressWorks refuses an IP literal,
// localhost and a few local suffixes by spelling, then fetches. A public DNS name that points at 127.0.0.1 (127.0.0.1.nip.io, localtest.me) or a
// tailnet-only MagicDNS name (beelink.tail1723e2.ts.net, which the faucet host resolves and whose `tailscale serve` paths are tailnet-only HTTPS)
// passes, and an LNURL may name any path and port on it. Every stranger's bounty address (POST /feedback, GET /feedback/lnaddress) makes the
// faucet GET that internal URL, and the wallet's answer's status and `reason` are echoed back ("its wallet answered 404", "its wallet said: ...").
// Safe: an address whose host is internal - by the name it resolves to, or a tailnet name - is refused before any fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lnAddressWorks } from '../src/feedback-store.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';

test('#1489-r6 a bounty address whose name leads to an internal host is never fetched', async () => {
  const fetched = [];
  const fetchFn = async (url) => { fetched.push(url); return new Response(JSON.stringify({ status: 'ERROR', reason: 'internal service answered: admin=on' }), { status: 200 }); };
  const asked = ['x@127.0.0.1.nip.io', 'x@localtest.me', 'x@beelink.tail1723e2.ts.net',
    lnurlFor('https://127.0.0.1.nip.io:18866/feedback/admin/list'), lnurlFor('https://beelink.tail1723e2.ts.net/arenachat/api/channels')];
  const answers = [];
  for (const a of asked) answers.push((await lnAddressWorks(a, { fetchFn })).why);
  console.log('  MEASURED:', JSON.stringify({ fetched, answers }));
  assert.deepEqual(fetched, [], 'no internal URL is fetched for a stranger\'s bounty address');
});

test('#1809 addressIsGlobal: loopback, private, CGNAT (Tailscale), link-local, ULA and IPv4-in-IPv6 are not global; public addresses are', async () => {
  const { addressIsGlobal } = await import('../src/feedback-store.js');
  for (const a of ['127.0.0.1', '10.1.2.3', '100.101.102.103', '172.16.0.1', '192.168.1.68', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'nonsense'])
    assert.equal(addressIsGlobal(a), false, a);
  for (const a of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:1.1.1.1']) assert.equal(addressIsGlobal(a), true, a);
});

test('#1809 the default fetcher connects only to a checked global address (a name resolving to 127.0.0.1 is refused at connect)', async () => {
  const { walletFetch, lnAddressInvoice } = await import('../src/feedback-store.js');
  await assert.rejects(walletFetch('https://127.0.0.1.nip.io/.well-known/lnurlp/x', { signal: AbortSignal.timeout(5000) }), (e) => e.code === 'EINTERNALHOST' || /ENOTFOUND|EAI_AGAIN/.test(String(e.code)));
  const fetched = []; const fetchFn = async (u) => { fetched.push(u); return new Response(JSON.stringify({ tag: 'payRequest', callback: 'https://beelink.tail1723e2.ts.net/cb', minSendable: 1000, maxSendable: 1e9 })); };
  assert.equal((await lnAddressInvoice('x@localtest.me', 10, '', { fetchFn })).ok, false);
  assert.deepEqual(fetched, [], 'an internal address is never asked for an invoice');
});
