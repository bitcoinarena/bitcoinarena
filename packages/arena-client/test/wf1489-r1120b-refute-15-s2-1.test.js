// kanban #1489 refute of #3029 / #3150, skeptic 2 (attacker: ONE GUARDIAN SEAT, not a stranger's link). The fix keeps a seated gateway
// when the lock client's gateways() names it - but that list is "the union of every guardian's registered list, most-listed first"
// (lock-client/src/lib.rs gateways()). A seat that is one guardian of seven registers a gateway of its own at its own guardian only:
// it is in the union, LAST (one guardian lists it). The page then asks the seats for GET /gateway-seats and takes the FIRST answer
// (src/arena-ui/index.html useSeatedGateways: the first seat that answers, unsigned, kept 2 min) - so that one seat names its own
// gateway "seated" and it passes the #3029 filter: it leads every deposit and both legs of a swap (the pay leg's LNv2 contract funded
// to it, held up to its expiry) ahead of the six gateways every guardian lists. The same effect #3029 closed, from one guardian seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pl from '../src/page-lock.js';

const FID_TO = 'a1'.repeat(32), FID_FROM = 'b1'.repeat(32);
const OWN = 'https://seat-3-own-gateway.example/';
// most-listed first: the honest gateways every guardian lists, then the one only seat 3's guardian lists
const LISTED = ['https://gw-a.example/', 'https://gw-b.example/', 'https://gw-c.example/', OWN];

test('a gateway only one guardian lists, named seated by that one seat, does not lead the swap or a deposit', async () => {
  pl.useSeatedGateways(async () => [OWN]);   // seat 3's GET /gateway-seats answer, the first the page reads
  try {
    const paid = [], recv = [];
    let bal = 1_000_000n;
    const from = { balanceMsat: async () => String(bal), gateways: async () => JSON.stringify(LISTED),
      withdraw: async (inv, gw) => { paid.push(gw); bal -= 50_000n; return JSON.stringify({ state: 'Success', preimage: '00'.repeat(32) }); } };
    const to = { gateways: async () => JSON.stringify(LISTED),
      receive: async (m, gw) => { recv.push(gw); return JSON.stringify({ invoice: 'lntb500n1x', operation: 'op1' }); }, awaitReceive: async () => 'Claimed' };
    pl.noteClientFederation(from, FID_FROM); pl.noteClientFederation(to, FID_TO);
    const got = await pl.swapForRound({ from, to, amountMsat: 50_000n, gateways: [] });
    assert.equal(got.ok, true);
    console.log(`receive leg through ${recv[0]}, pay leg through ${paid[0]}`);
    const dep = { gateways: async () => JSON.stringify(LISTED), asked: [],
      receive: async function (m, gw) { this.asked.push(gw); return JSON.stringify({ invoice: 'lntb1x', operation: 'op-d' }); },
      awaitReceive: () => new Promise(() => {}) };
    pl.noteClientFederation(dep, FID_TO);
    const d = await pl.depositOffer({ client: dep, stakeMsat: 100000n }).invoice(100000n);
    console.log(`deposit through ${d.gateway}`);
    assert.notEqual(paid[0], OWN, `the swap's pay leg went first through ${paid[0]}, a gateway only one guardian lists, on one seat's word`);
    assert.notEqual(d.gateway, OWN, `the deposit went first through ${d.gateway}, a gateway only one guardian lists, on one seat's word`);
  } finally { pl.useSeatedGateways(null); }
});
