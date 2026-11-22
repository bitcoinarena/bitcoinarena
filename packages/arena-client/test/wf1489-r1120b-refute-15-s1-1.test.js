// kanban #1489 refute of #3029 (variant: a stranger's link). #3029 keeps a seated gateway only when the federation lists it, but
// the page's NAMED gateways - window.ARENA_LEDGER_GATEWAYS, read straight from the page URL's ?gateway= (src/arena-ui/index.html) -
// are passed to swapForRound / movePlayerWallet / walletDepositOffer / withdraw unchecked, and swapForRound orders them BEFORE the
// federation's list: gatewayOrder([...seated, ...gateways], listed). So a link https://<site>/?gateway=https://evil.example/ makes the
// swap's pay leg (and receive leg) go through a gateway neither federation lists - the same effect #3029 closed for one seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pl from '../src/page-lock.js';

const FID_TO = 'aa'.repeat(32), FID_FROM = 'bb'.repeat(32);
const EVIL = 'https://evil-gateway.example/', EVIL2 = 'https://evil-gateway-2.example/';
const HONEST = { [FID_TO]: 'https://gw-to.example/', [FID_FROM]: 'https://gw-from.example/' };

test('a gateway only the page URL names (?gateway=) is not the swap\'s first pay or receive gateway', async () => {
  pl.useSeatedGateways(null);
  const paid = [], recv = [];
  let bal = 1_000_000n;
  const from = { balanceMsat: async () => String(bal), gateways: async () => JSON.stringify([HONEST[FID_FROM]]),
    withdraw: async (inv, gw) => { paid.push(gw); bal -= 50_000n; return JSON.stringify({ state: 'Success', preimage: '00'.repeat(32) }); } };
  const to = { gateways: async () => JSON.stringify([HONEST[FID_TO]]),
    receive: async (m, gw) => { recv.push(gw); return JSON.stringify({ invoice: 'lntb500n1x', operation: 'op1' }); }, awaitReceive: async () => 'Claimed' };
  pl.noteClientFederation(from, FID_FROM); pl.noteClientFederation(to, FID_TO);
  // what index.html passes: window.ARENA_LEDGER_GATEWAYS = new URLSearchParams(location.search).get('gateway').split(',')
  const fromLink = new URLSearchParams('?gateway=' + encodeURIComponent(EVIL + ',' + EVIL2)).get('gateway').split(',').map((g) => g.trim()).filter(Boolean);
  const got = await pl.swapForRound({ from, to, amountMsat: 50_000n, gateways: fromLink });
  assert.equal(got.ok, true);
  console.log(`receive leg through ${recv[0]}, pay leg through ${paid[0]}`);
  assert.ok(![EVIL, EVIL2].includes(paid[0]), `the swap's pay leg went through ${paid[0]}, a gateway only the page URL named`);
  assert.ok(![EVIL, EVIL2].includes(recv[0]), `the swap's receive leg went through ${recv[0]}, a gateway only the page URL named`);
});
