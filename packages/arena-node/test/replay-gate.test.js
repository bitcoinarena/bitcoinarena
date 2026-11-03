// kanban #1087: a seat retried the same refused orders of old rounds from every peer each settle pass (108 refusals a minute on one seat).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayGate, REPLAY_RETRY_MS } from '../src/order-batch.js';

const STALE = "its stake lock: that stake lock's lock height 157414 (its expiration 159249 less the round's 1835 blocks) is more than 12 blocks below the height 158732 it is verified at: a loser could refund before settlement";

test('a refusal no later block can lift is not asked again; any other waits its retry time, across every peer', () => {
  let t = 1_000_000;
  const g = new ReplayGate({ now: () => t });
  assert.equal(g.allow('a'), true);
  assert.equal(g.refused('a', STALE), true, 'a stake lock older than the freshness window is refused for good');
  t += 10 * REPLAY_RETRY_MS;
  assert.equal(g.allow('a'), false, 'still not asked after many retry times');

  assert.equal(g.refused('b', 'fetch failed'), false);
  assert.equal(g.allow('b'), false, 'not asked again at once, of this or any other peer');
  t += REPLAY_RETRY_MS - 1;
  assert.equal(g.allow('b'), false);
  t += 1;
  assert.equal(g.allow('b'), true, 'asked again once its retry time has passed');

  g.refused('c', 'fetch failed'); g.taken('c');
  assert.equal(g.allow('c'), true, 'an order taken is free again');
});

test('the gate holds at most its size, the oldest refusal going first', () => {
  const g = new ReplayGate({ now: () => 0, max: 3 });
  for (const o of ['1', '2', '3', '4']) g.refused(o, STALE);
  assert.equal(g.allow('1'), true);
  assert.equal(g.allow('4'), false);
  assert.equal(g.held.size, 3);
});
