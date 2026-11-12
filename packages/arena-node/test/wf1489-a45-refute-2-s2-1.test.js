// kanban #1489 a45 refute-2-s2 failure 1 (#1809, #2236): the reserve payout of a passed funding proposal (reserve-payout.js lnurlClient, wired in
// server.js as lnurlClient({ network }) with the default plain fetch) asks the proposal's LNURL with no #1809 guard at all. Since 2026-10-17 anyone
// may author a proposal (funding.js), and lnurlStands takes any lnurl1 and any name@host - so x@127.0.0.1.nip.io, x@beelink.tail1723e2.ts.net or an
// lnurl1 for http://127.0.0.1:9735/admin is fetched by every guardian seat (planStands, and the coordinator's invoiceFor), redirects followed,
// and the refusal text lands in the payout record's why (GET /reserve-payouts).
// Safe: no internal URL is fetched for a proposal's LNURL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lnurlClient } from '../src/reserve-payout.js';
import { lnurlStands } from '../../arena-protocol/src/funding.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';

test('#1489 a45-refute-2-s2: a funding proposal\'s LNURL leading to an internal host is never fetched by a guardian seat', async () => {
  const asked = [lnurlFor('http://127.0.0.1:9735/admin'), 'x@127.0.0.1.nip.io', 'x@beelink.tail1723e2.ts.net', lnurlFor('https://10.0.0.5:8080/lnurlp/x'), 'x@localtest.me'];
  const proposable = asked.filter((a) => lnurlStands(a));
  const fetched = [];
  const was = globalThis.fetch;
  globalThis.fetch = async (u) => { fetched.push(String(u)); return new Response(JSON.stringify({ tag: 'payRequest', callback: 'http://127.0.0.1:9735/admin', metadata: '[]', minSendable: 1, maxSendable: 1e12 })); };
  try {
    const ask = lnurlClient({ network: 'testnet4' });   // exactly as server.js wires it
    for (const a of asked) await ask.invoiceFor(a, 1000n);
  } finally { globalThis.fetch = was; }
  console.log('  MEASURED:', JSON.stringify({ proposable: proposable.length, fetched }));
  assert.equal(proposable.length, asked.length, 'each one is a proposal LNURL funding.js takes');
  assert.deepEqual(fetched, [], 'no internal URL is fetched for a funding proposal\'s LNURL');
});
