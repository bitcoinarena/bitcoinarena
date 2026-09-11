// A FEDERATION ROUND'S STAKE FROM THE PAGE: THE INVOICE FIRST (the owner 2026-09-11).
//
// The page asks a node for the round's federation invoice and builds its
// entry on that invoice's hash - no preimage chosen, no shares dealt - and it
// checks the amount is the round's net stake before committing to anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { federationStakeFor } from '../src/client.js';
import { entryFor } from '../src/join.js';
import { NO_SHARES } from '../../protocol/src/handout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { toHex } from '../../protocol/src/hash.js';
import { feldmanGroup } from '../../blwp-node/src/curve.js';

const round = { id: new Uint8Array(32).fill(7), stakeMsat: 1000000n };
const NET = round.stakeMsat - entryFeeMsat(round.stakeMsat);
const HASH = 'aa'.repeat(32);

/** Nodes that answer `/federation-invoice` as each test says. */
function nodesAnswering(answers) {
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    const node = Object.keys(answers).find((n) => url.startsWith(n));
    const a = answers[node];
    return { ok: a.status === 200, status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  return { fetcher, asked };
}

test('the stake commits to the node\'s federation invoice hash, deals no shares, and the entry carries both', async () => {
  const { fetcher, asked } = nodesAnswering({
    'http://a': { status: 200, body: { paymentHash: HASH, amountMsat: String(NET), request: 'lnbcrt-fed' } },
  });
  const stake = await federationStakeFor(round, { nodes: ['http://a'], fetcher });
  assert.equal(asked[0], `http://a/federation-invoice?round=${toHex(round.id)}`);
  assert.equal(stake.federation, true);
  assert.equal(toHex(stake.stakeCommitment), HASH);
  assert.equal(toHex(stake.vssSharesRef), toHex(NO_SHARES), 'a federation stake dealt shares');
  assert.equal(stake.request, 'lnbcrt-fed');
  const entry = entryFor(round, { seed: new Uint8Array(32).fill(5), curve: feldmanGroup, random: (n) => new Uint8Array(n).fill(9), stake });
  assert.equal(toHex(entry.stakeCommitment), HASH);
  assert.equal(toHex(entry.vssSharesRef), toHex(NO_SHARES));
});

test('an invoice for another amount is refused, and the next node is asked', async () => {
  const { fetcher } = nodesAnswering({
    'http://a': { status: 200, body: { paymentHash: HASH, amountMsat: String(NET + 1n), request: 'lnbcrt-wrong' } },
    'http://b': { status: 200, body: { paymentHash: 'bb'.repeat(32), amountMsat: String(NET), request: 'lnbcrt-right' } },
  });
  const stake = await federationStakeFor(round, { nodes: ['http://a', 'http://b'], fetcher });
  assert.equal(stake.request, 'lnbcrt-right');
  await assert.rejects(
    federationStakeFor(round, { nodes: ['http://a'], fetcher }),
    /net stake is/);
});

test('a free round, and nodes that make no federation invoice, give no stake', async () => {
  await assert.rejects(federationStakeFor({ ...round, stakeMsat: 0n }, { nodes: ['http://a'] }), /asks no stake/);
  const { fetcher } = nodesAnswering({ 'http://a': { status: 409, body: 'this node makes no federation invoices' } });
  await assert.rejects(federationStakeFor(round, { nodes: ['http://a'], fetcher }), /makes no federation invoices/);
});
