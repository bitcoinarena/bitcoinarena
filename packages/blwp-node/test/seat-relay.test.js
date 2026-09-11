// A ROUND THAT TAKES A STAKE AND NAMES NO PUBLICATION RELAY.
//
// Since P2 (v4.6.2 §13A) no result is FINAL until the round's settlement seats
// have posted its transcript to the contract's `publication_relays[]` - and a
// contract that names none can never be posted to, so none of its results can
// ever be final and no stake in it can ever settle. It would only take players'
// money into holds that expire back to them.
//
// MEASURED FIRST, asserted as it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HELD } from '../src/custody.js';
import { assumeSeated } from './seating.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';
import {
  WINDOW_MS, wait, WINNER, LOSER, paidPort, contractFor, say, seatAndPlay, opts,
} from './window-fixture.js';

test('MEASURED: a paying round naming no relay opens, seats and holds both stakes, and after the window nothing is final', async () => {
  const portA = paidPort();
  const portB = paidPort();
  const a = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portA, finality: { everyMs: 100 } });
  const b = await serve(openStore(':memory:'), { port: 0, ...opts, lightning: portB, finality: { everyMs: 100 } });
  try {
    for (const [d, other] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${other.port}`];
      d.verifier.peers = there;
      d.payouts.peers = there;
      d.preimages.peers = there;
    }
    const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW_MS), []);
    const rid = roundId(c);
    const opened = [];
    for (const d of [a, b]) {
      opened.push((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status);
      assumeSeated(d.round, rid, c.nodes);
    }
    // seatAndPlay asserts each entry is seated (201), quoted and seen paid
    const winner = await seatAndPlay([a, b], c, rid, WINNER, 2);
    const loser = await seatAndPlay([a, b], c, rid, LOSER, 2);
    const closedAt = Date.now();
    assert.deepEqual(await Promise.all([say(a.port, `close ${toHex(rid)}`), say(b.port, `close ${toHex(rid)}`)]), ['closed', 'closed']);
    await a.verifier.settling;
    await b.verifier.settling;
    await wait(Math.max(0, closedAt + WINDOW_MS + 1500 - Date.now()));

    const settlement = async (d, eid) => JSON.parse(await (await fetch(`http://127.0.0.1:${d.port}/settlement?entry=${toHex(eid)}`)).text());
    const facts = {
      opened,
      stakesHeld: [a, b].map((d) => [winner, loser].map((r) => (d.round.hold(r.eid) || {}).state)),
      finality: [],
      lightningActs: [portA, portB].map((p) => p.settled.length + p.cancelled.length),
    };
    for (const d of [a, b]) facts.finality.push((await settlement(d, loser.eid)).finality);
    const why = (await settlement(a, loser.eid)).finalityWhy;
    console.log('  FACTS (paying round, no relay):', JSON.stringify(facts), '|', why);
    assert.deepEqual(facts, {
      opened: [201, 201],
      stakesHeld: [[HELD, HELD], [HELD, HELD]],
      finality: ['PROVISIONALLY_FINAL', 'PROVISIONALLY_FINAL'],
      lightningActs: [0, 0],
    });
    assert.match(why, /names no publication relay/);
  } finally { await a.close(); await b.close(); }
});
