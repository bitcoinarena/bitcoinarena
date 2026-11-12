// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute 3 of #1537 (after 596b5fa19, 72e0a16cc): "NEVER AN INTERNAL HOST" - publicHost (feedback-store.js), the one guard both
// lnAddressWorks and lnAddressInvoice now share, judges only the spelling of the name. A name that is spelled public but answers only inside the
// faucet's own network passes it: the faucet runs on the Beelink, a tailnet node, where beelink.tail1723e2.ts.net:8443 and :8444 are
// "tailnet only" HTTPS proxies (tailscale serve; :8444 is 127.0.0.1:18789) with a valid certificate, and MagicDNS answers 100.x for every
// *.ts.net name. One LNURL naming https://beelink.tail1723e2.ts.net:8444/<any path> makes the faucet GET a tailnet-only service, and the answer
// ("its wallet answered 404", or the JSON's reason) comes back to the caller.
// Safe: an address on a tailnet-only name, or on a public name that resolves to a loopback/private/CGNAT address, is never fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lnAddressWorks, lnAddressInvoice } from '../src/feedback-store.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';

test('#1489 refute 3 #1537: an address on a tailnet-only or loopback-resolving name is fetched by the address check', async () => {
  const asked = [];
  const fetchFn = async (url) => { asked.push(String(url)); return new Response('{"status":"ERROR","reason":"inside"}', { status: 200, headers: { 'content-type': 'application/json' } }); };
  const addresses = [
    lnurlFor('https://beelink.tail1723e2.ts.net:8444/v1/anything'),   // tailnet only (tailscale serve), 127.0.0.1:18789 behind it
    'x@macbook-pro-von-daniel.tail1723e2.ts.net',                     // a tailnet peer by its MagicDNS name (100.85.86.106)
    'x@127.0.0.1.nip.io',                                             // a public spelling of 127.0.0.1
  ];
  const answers = [];
  for (const a of addresses) {
    answers.push((await lnAddressWorks(a, { fetchFn })).why);
    answers.push((await lnAddressInvoice(a, 1000, '', { fetchFn })).why);
  }
  console.log('  MEASURED:', JSON.stringify({ fetched: asked, answers }));
  assert.deepEqual(asked, [], `the faucet fetched ${asked.length} URLs inside its own network: ${asked.join(', ')}`);
});
