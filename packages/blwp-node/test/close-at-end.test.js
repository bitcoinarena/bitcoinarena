// A SEAT CLOSES A ROUND THAT IS OVER, BY ITS OWN CLOCK (M3.3-34, the Daily's close).
//
// With `closeAtEnd` a seat closes every round it holds once protocol
// `roundEndMs` has passed - entry close, plus the start deadline, a whole run
// and the start deadline again - by the same path a `close <round>` message
// takes. A round not yet over stays open; a seat without the option closes
// nothing by itself.
//
// MEASURED BEFORE (TASKBOOK, M3.3-34): nothing on the Daily closed a round, so
// no run there was ever replayed, signed or made final.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { b32, contractFor, wait } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { roundEndMs } from '../../protocol/src/first-mark.js';

const WINDOW = 60000n;

test('a seat with closeAtEnd closes the round that is over and keeps the one that is not; without it, neither closes', async () => {
  const now = BigInt(Date.now());
  const withIt = await serve(openStore(':memory:'), { port: 0, funded: () => true, closeAtEnd: { everyMs: 50 } });
  const without = await serve(openStore(':memory:'), { port: 0, funded: () => true });
  try {
    const at = (d) => `http://127.0.0.1:${d.port}`;
    const round = (d, entryCloseMs) => ({ ...contractFor([d.round.pubkey, b32(0x33)], 3000n, [at(d)]),
      committeeTimeMs: entryCloseMs - 120000n - WINDOW, startTimeMs: entryCloseMs - 120000n, entryCloseMs, stakeMsat: 0n });
    const facts = {};
    for (const [name, d] of [['withIt', withIt], ['without', without]]) {
      const over = round(d, now - 200000n);            // its end, ~180 s after entry close, has passed
      const running = round(d, now + 60000n);
      assert.ok(roundEndMs(over) < now && roundEndMs(running) > now);
      for (const c of [over, running])
        assert.equal((await fetch(`${at(d)}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
      facts[name] = { over: roundId(over), running: roundId(running) };
    }
    await wait(400);
    const state = (d, id) => (d.round.get(id).state === 1 ? 'closed' : 'open');
    const seen = {
      withIt: { over: state(withIt, facts.withIt.over), running: state(withIt, facts.withIt.running) },
      without: { over: state(without, facts.without.over), running: state(without, facts.without.running) },
    };
    console.log('  FACTS (close at end):', JSON.stringify(seen));
    assert.deepEqual(seen, { withIt: { over: 'closed', running: 'open' }, without: { over: 'open', running: 'open' } });
  } finally { await withIt.close(); await without.close(); }
});
