// A ROUND WHOSE CONTRACT CANNOT BE FETCHED OR READ IS NOT ASKED FOR AGAIN FOR 30 s (kanban #266): measured on production after
// the Arena series went up - every poll asked every seat for every listed round's contract, 714 /round requests in 25 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLobby, UNREADABLE_MS } from '../src/lobby.js';

test('an unreadable round is asked for once, not on every poll, and again after UNREADABLE_MS', async () => {
  const id = 'ab'.repeat(32);
  let asks = 0;
  const fetcher = async (url) => {
    if (String(url).includes('/rounds')) return new Response(JSON.stringify({ node: 'cd'.repeat(32), nowMs: '1', rounds: [{ id }] }));
    if (String(url).includes('/round?')) { asks++; return new Response('not a round this client reads', { status: 500 }); }
    throw new Error('no such door');
  };
  const nodes = ['http://a', 'http://b'];
  const verify = () => true;
  const t0 = 1_800_000_000_000;
  const first = await fetchLobby({ nodes, fetcher, verify, nowMs: t0 });
  assert.ok(asks > 0, 'the contract was never asked for');
  assert.ok(first.refused.some((r) => r.startsWith(id.slice(0, 16))), first.refused.join('\n'));
  const afterFirst = asks;
  await fetchLobby({ nodes, fetcher, verify, nowMs: t0 + 2000 });
  await fetchLobby({ nodes, fetcher, verify, nowMs: t0 + UNREADABLE_MS - 1 });
  assert.equal(asks, afterFirst, 'the unreadable round was asked for again within UNREADABLE_MS');
  await fetchLobby({ nodes, fetcher, verify, nowMs: t0 + UNREADABLE_MS + 1 });
  assert.ok(asks > afterFirst, 'the round was not asked for again after UNREADABLE_MS');
});
