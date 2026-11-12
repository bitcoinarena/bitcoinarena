// kanban #1489 a45 refute-2-s1 failure 1 (kanban #2236) (a second copy of #1809's logic): a WINNER'S payout address (POST /payout-address -> WinningsSend.payRequest /
// invoiceFor, server.js lnurlFetch = plain fetch) has no internal-host check at all - neither #1511's spelling test nor #1809's resolution test. A
// player who names x@127.0.0.1:18866 (or x@localtest.me, x@beelink.tail1723e2.ts.net, an lnurl1 for any internal URL, an http:// callback)
// makes every signer node of the committee GET that internal URL at settlement, and fetch follows redirects.
// Safe: the seat refuses such an address at POST /payout-address and never fetches an internal URL for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightningAddressEndpoint } from '../../arena-protocol/src/lnurl-pay.js';
import { WinningsSend } from '../src/winnings-send.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';

test('#1489 a45-refute-2: a winner\'s payout address leading to an internal host is never fetched by a seat', async () => {
  const asked = ['x@127.0.0.1:18866', 'x@localtest.me', 'x@beelink.tail1723e2.ts.net', 'x@10.0.0.5:8080', lnurlFor('https://127.0.0.1.nip.io:18866/feedback/admin/list')];
  const accepted = asked.filter((a) => /^lnurl1/.test(a) || lightningAddressEndpoint(a).ok);
  const fetched = [];
  const lnurlFetch = async (u) => { fetched.push(String(u)); return new Response(JSON.stringify({ tag: 'payRequest', callback: 'http://127.0.0.1:9735/admin', metadata: '[]', minSendable: 1, maxSendable: 1e12 })); };
  const ws = new WinningsSend({ round: {}, port: null, lnurlFetch });
  for (const a of asked) await ws.invoiceFor(a, 1000n);
  console.log('  MEASURED:', JSON.stringify({ accepted, fetched }));
  assert.deepEqual(fetched, [], 'no internal URL is fetched for a player\'s payout address');
});
