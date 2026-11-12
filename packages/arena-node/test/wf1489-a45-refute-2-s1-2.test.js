// kanban #2236 (#1489 a45 refute-2-s1): the winner's payout address door - what POST /payout-address keeps, and the honest path the guard leaves open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payoutAddressRefusal, internalByName, hostReach } from '../src/public-fetch.js';
import { hostReach as faucetHostReach } from '../src/feedback-store.js';
import { WinningsSend } from '../src/winnings-send.js';
import { TEST_DONATION_ENDPOINTS } from '../../arena-protocol/src/test-donation-sets.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';

test('#2236: POST /payout-address refuses a port, an IP literal, a local suffix, a tailnet name, a wildcard loopback name; a public name stands', () => {
  const refused = ['x@127.0.0.1:18866', 'x@localtest.me', 'x@beelink.tail1723e2.ts.net', 'x@10.0.0.5:8080', 'x@127.0.0.1', 'x@127.0.0.1.nip.io', 'x@127-0-0-1.sslip.io',
    'x@getalby.com:8443', 'x@router.lan', 'x@printer.local', 'x@abcdefghijklmnop.onion', 'x@100.100.100.100', 'x@localhost'];
  const why = Object.fromEntries(refused.map((a) => [a, payoutAddressRefusal(a)]));
  console.log('  MEASURED refused:', JSON.stringify(why));
  for (const a of refused) assert.ok(why[a], a);
  for (const a of ['satoshi@getalby.com', 'me@walletofsatoshi.com', 'x@getalby.com:443', 'winner@pay.example', 'v1.5@strike.me', 'bob@ln.tips'])
    assert.equal(payoutAddressRefusal(a), null, a);
  // the operator's own local LNURL server (a regtest harness's) is its choice, never a player's
  assert.equal(payoutAddressRefusal('winner@127.0.0.1:4433', { localHosts: ['127.0.0.1:4433'] }), null);
  assert.ok(payoutAddressRefusal('winner@127.0.0.1:4434', { localHosts: ['127.0.0.1:4433'] }));
  assert.equal(internalByName('getalby.com'), false);
  assert.equal(faucetHostReach, hostReach, 'the faucet and the winnings send share one guard');
});

const payRequest = (callback) => new Response(JSON.stringify({ tag: 'payRequest', callback, metadata: '[]', minSendable: 1, maxSendable: 1e12 }));

test('#2236: an http:// or internal callback of a public address is never asked; the test donation recipients and an operator host still are', async () => {
  const fetched = [];
  const ws = new WinningsSend({ round: {}, port: null, lnurlFetch: async (u) => { fetched.push(String(u)); return payRequest('http://127.0.0.1:9735/admin'); } });
  const a = await ws.invoiceFor('winner@pay.example', 1000n);
  console.log('  MEASURED public address, http internal callback:', JSON.stringify({ fetched, why: a.why }));
  assert.deepEqual(fetched, ['https://pay.example/.well-known/lnurlp/winner']);
  assert.match(a.why, /callback/);
  // an https callback on a tailnet name, a port, a wildcard loopback name: refused the same way
  for (const cb of ['https://beelink.tail1723e2.ts.net/x', 'https://pay.example:8443/cb', 'https://127.0.0.1.nip.io/cb', 'https://10.1.2.3/cb']) {
    const seen = [];
    const w = new WinningsSend({ round: {}, port: null, lnurlFetch: async (u) => { seen.push(String(u)); return payRequest(cb); } });
    const r = await w.invoiceFor('winner@pay.example', 1000n);
    assert.equal(seen.length, 1, cb); assert.equal(r.ok, false, cb);
  }
  // an lnurl1 naming an internal URL: refused before any fetch, as the address
  const lf = []; const w2 = new WinningsSend({ round: {}, port: null, lnurlFetch: async (u) => { lf.push(String(u)); return payRequest('https://pay.example/cb'); } });
  for (const u of ['http://127.0.0.1:18866/feedback', 'https://beelink.tail1723e2.ts.net/arenachat', 'https://192.168.1.68/x', 'https://[::1]/x']) await w2.invoiceFor(lnurlFor(u), 1000n);
  assert.deepEqual(lf, []);
  // HONEST: the test donation set's local recipients (off mainnet) and their own callback are asked; on mainnet they are not
  const d = []; const wd = new WinningsSend({ round: {}, port: null, lnurlFetch: async (u) => { d.push(String(u)); return u.startsWith(TEST_DONATION_ENDPOINTS[0]) ? payRequest('http://127.0.0.1:18777/lnurlp/blwp-test-a/cb') : new Response('{}'); } });
  await wd.invoiceFor(lnurlFor(TEST_DONATION_ENDPOINTS[0]), 1000n);
  assert.equal(d.length, 2, JSON.stringify(d)); assert.match(d[1], /^http:\/\/127\.0\.0\.1:18777\/lnurlp\/blwp-test-a\/cb\?amount=1000/);
  const m = []; const wm = new WinningsSend({ round: {}, port: null, network: 'bitcoin', lnurlFetch: async (u) => { m.push(String(u)); return payRequest('http://127.0.0.1:18777/cb'); } });
  await wm.invoiceFor(lnurlFor(TEST_DONATION_ENDPOINTS[0]), 1000n);
  assert.deepEqual(m, []);
  // HONEST: an operator-listed local host (a harness's https payee) and its callback on the same host
  const o = []; const wo = new WinningsSend({ round: {}, port: null, localHosts: ['127.0.0.1:4433'], lnurlFetch: async (u) => { o.push(String(u)); return u.includes('/cb') ? new Response('{}') : payRequest('https://127.0.0.1:4433/cb'); } });
  await wo.invoiceFor('winner@127.0.0.1:4433', 1000n);
  assert.equal(o.length, 2, JSON.stringify(o));
  console.log('  MEASURED honest:', JSON.stringify({ donation: d, operator: o }));
});
