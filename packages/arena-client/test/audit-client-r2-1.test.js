// Audit client r2 #1: the page's seated-gateway lookup (src/arena-ui/index.html, ARENACLIENT.useSeatedGateways(async (fid) => ...))
// asks the lobby's seats GET /gateway-seats?federation= one by one and takes the FIRST answer that names the federation id - no
// signature, no threshold, no check that the answering seat guards the federation. page-lock.js puts those URLs first in the gateway
// order of every deposit invoice (invoiceThroughGateways) and of both legs of a swap/move (swapForRound -> from.withdraw(invoice, pay)).
// So ONE seat (a non-guardian seat listed before the federation's guardian seats) makes the player's cross-federation swap pay through
// a Lightning gateway the attacker runs - one the federation neither lists nor seated. LNv2 lets such a gateway take the stock limit
// fee (100 sat + 1.5 %) and hold the outgoing contract unpaid until its expiry (up to 1440 blocks): the swap (and the join it feeds)
// waits on lock client withdraw() all that time and the sats are frozen in the contract.
// Safe behaviour asserted: with the federation's two guardian seats both naming the honest seated gateway, the swap's pay leg does
// not go through a gateway only one non-guardian seat named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as pageLock from '../src/page-lock.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const html = readFileSync(join(root, 'src/arena-ui/index.html'), 'utf8');

function block(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `found ${head}`);
  let i = src.indexOf('{', at + head.length - 1), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  throw new Error('unbalanced');
}

const FID_TO = 'aa'.repeat(32), FID_FROM = 'bb'.repeat(32);
const EVIL = 'https://evil-gateway.example/', EVIL_TO = 'https://evil-gateway-2.example/';
const HONEST = { [FID_TO]: 'https://gw-to.example/', [FID_FROM]: 'https://gw-from.example/' };
// seat0: any seat of the lobby (not a guardian of either federation) - it answers for whatever federation it is asked
// seat1..2: the guardian seats of the federations, answering their true seated view
const NODES = ['https://seat0.test', 'https://seat1.test', 'https://seat2.test'];

test('one seat\'s unsigned GET /gateway-seats answer does not pick the gateway a swap pays through', async () => {
  const src = block(html, 'if (ARENACLIENT.useSeatedGateways) {');
  const fetchStub = async (url) => {
    const fid = new URL(url).searchParams.get('federation');
    // the lying seat names a gateway of its own for each federation (two URLs, so the swap's 'never one gateway on both legs' rule
    // does not set them aside)
    if (url.startsWith(NODES[0])) return { ok: true, json: async () => ({ ok: true, federationId: fid, seated: ['ee'], gateways: { ee: { url: fid === FID_FROM ? EVIL : EVIL_TO } } }) };
    return { ok: true, json: async () => ({ ok: true, federationId: fid, seated: ['11'], gateways: { 11: { url: HONEST[fid] } } }) };
  };
  const ARENACLIENT = { useSeatedGateways: pageLock.useSeatedGateways, gatewayUrlsOfView: pageLock.gatewayUrlsOfView };
  new Function('ARENACLIENT', 'fetch', 'AbortSignal', 'testnet', 'named', src)(ARENACLIENT, fetchStub, { timeout: () => undefined }, null, { nodes: NODES });

  // two wallets of the seed (stand-ins for the lock client), each bound to its federation as openPlayerWallet binds them
  const paidThrough = [], receivedThrough = [];
  let bal = 1_000_000n;
  const from = { balanceMsat: async () => String(bal), gateways: async () => JSON.stringify([HONEST[FID_FROM]]),
    withdraw: async (invoice, gw) => { paidThrough.push(gw); bal -= 50_000n; return JSON.stringify({ state: 'Success', preimage: '00'.repeat(32) }); } };
  const to = { gateways: async () => JSON.stringify([HONEST[FID_TO]]),
    receive: async (msat, gw) => { receivedThrough.push(gw); return JSON.stringify({ invoice: 'lntb500n1' + gw, operation: 'op1' }); }, awaitReceive: async () => 'Claimed' };
  pageLock.noteClientFederation(from, FID_FROM);
  pageLock.noteClientFederation(to, FID_TO);

  const got = await pageLock.swapForRound({ from, to, amountMsat: 50_000n });
  assert.equal(got.ok, true);
  console.log(`receive leg through ${receivedThrough[0]}, pay leg through ${paidThrough[0]}`);
  assert.notEqual(paidThrough[0], EVIL, `the swap's pay leg went through ${paidThrough[0]}, a gateway only one non-guardian seat named`);
  assert.notEqual(receivedThrough[0], EVIL_TO, `the swap's receive leg went through ${receivedThrough[0]}, a gateway only one non-guardian seat named`);
});

