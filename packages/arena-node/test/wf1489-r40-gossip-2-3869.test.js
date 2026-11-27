// wf1489 r40 gossip 2: A PEER THAT HANGS ON EVERY LINE IS STILL ASKED FIRST FOR EVERY SHARED ID (gap in #2424).
// series-pull.js strikes a peer whose /series-template read fails, but the strikes are read only for ids that peer lists ALONE
// (roots.length === 1). One seat that lists the day's REAL series too - and answers GET /series first, so it is roots[0] of every id -
// then holds each /series-template read to the timeout: every real id costs the whole timeoutMs at that seat before the honest peer is
// asked, and the pass deadline (passMs) ends the pass after passMs / timeoutMs ids (live: 90 s / 15 s = 6 of 40).
// Safe behaviour: after peerStrikes failed lines in a pass the hanging seat is passed over, and every real series an honest peer serves
// is taken in the same pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeriesPull } from '../src/series-pull.js';

const ids = Array.from({ length: 12 }, (_, i) => (i + 1).toString(16).padStart(2, '0') + 'a'.repeat(62));
const parse = (line) => ({ id: line });
const idOf = (t) => t.id;

test('a seat that hangs on every series line does not hold the pass past a few real series', async () => {
  const hang = (signal) => new Promise((_, no) => { signal.addEventListener('abort', () => no(signal.reason || new Error('aborted')), { once: true }); });
  const fetchFn = async (u, { signal } = {}) => {
    const evil = u.startsWith('https://evil.example');
    if (u.endsWith('/series')) {
      if (!evil) await new Promise((r) => setTimeout(r, 20));   // the honest seat answers a moment later
      return { ok: true, json: async () => ({ series: ids.map((id) => ({ series: id, ahead: 9 })) }) };
    }
    if (evil) return hang(signal);                                // never serves a line: each read runs to its timeout
    const id = /id=([0-9a-f]{64})/.exec(u)[1];
    return { ok: true, text: async () => id };
  };
  const taken = [];
  const p = createSeriesPull({ peers: () => ['https://evil.example', 'https://h1.example'], held: () => taken, parse, idOf, fetchFn,
    take: async (t) => { taken.push(t.id); return { ok: true }; }, timeoutMs: 200, passMs: 1500, peerStrikes: 3 });
  const r = await p.pass();
  assert.equal(taken.length, ids.length, `every real series the honest seat serves is taken in the pass (took ${r.took} of ${ids.length})`);
});
