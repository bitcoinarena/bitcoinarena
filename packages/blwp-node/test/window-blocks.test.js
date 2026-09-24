// THE WINDOW IS BLOCKS, BOTH ENDS (§13A; RULED the owner 2026-09-24) - a measurement of the ruling, locked as a test before
// any code follows it. No src is changed by this file.
//
// THE RULING, as `ruledWindow` below states it:
//   - A window opens at the timestamp of the block where its opening event sits (the objection's filing; for the
//     re-run's own window, the block where the agreed re-run first sits at threshold).
//   - It ends at the first LATER block whose timestamp is >= open + objection_window_ms. Both ends are chain facts;
//     no wall-clock receive time is an input on either end.
//   - An event is INSIDE only if its own block timestamp is strictly before the end block's; a filing in the end block
//     or any later block is OUTSIDE.
//   - A node that has not yet got the end block decides nothing - no FINAL, VOID, slash or claim. Tip lag is a wait.
//   - Once two holders have the same blocks through the end block, they name the same outcome.
//
// THE MEASURED SPLIT it is aimed at, on two holder daemons: node A is the fixture's holder, node B a second daemon on a
// byte copy of A's store (VACUUM INTO) - the same holder, its own clock and arrivals. The objection reaches A at t and B
// at t + 1500; W = 3000; the holder's re-run and three others arrive inside both local windows, the fifth agreeing re-run
// at t + 3500. On the committed local-clock finality (resultFinality at daa0bc28) A answers VOID and B
// PROVISIONALLY_FINAL at t + 5000 - measured here, and asserted as TODAY'S ANSWER, which the code that follows the ruling
// turns over.
//
// THE CHAIN is the fixtures' block clock (block-clock.js): one block per second, a block's timestamp its median time
// past. EACH FILING IS ASSIGNED ONE BLOCK - the first block at or after the filing's first sighting at either holder -
// because a filing is one artifact on one chain, whichever holder saw it first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { blockClock } from './block-clock.js';
import { sevenSignerNodes, object, WINDOW_MS, wait, opts } from './window-fixture.js';
import { rerunIsAgreed } from '../../protocol/src/rerun.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';

const at = (d, now) => Object.assign(Object.create(d.round), { now: () => now });
async function until(cond, ms = 8000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(25)) if (cond()) return true;
  return cond();
}

/**
 * THE RULED RE-RUN WINDOW, as a pure function of the blocks a node holds (`blocks`: [{ ts }] through its tip, ascending)
 * and the block each filing sits in (`blockOf(artifact) -> ts`). Answers { state, why }; state null is "decides nothing".
 */
function ruledWindow({ blocks, objectionTs, W, reruns, agreed }) {
  const open = blocks.find((b) => b.ts === objectionTs);
  if (!open) return { state: null, why: 'this node does not hold the block the objection sits in: it decides nothing' };
  const end = blocks.find((b) => b.ts > open.ts && b.ts >= open.ts + W);
  if (!end) return { state: null, why: `this node does not yet hold the end block (the first at or after ${open.ts + W}): it decides nothing` };
  const inside = reruns.filter((r) => r.ts < end.ts);
  const outside = reruns.filter((r) => r.ts >= end.ts);
  const count = agreed(inside);
  if (count.ok)
    return { state: 'PROVISIONALLY_FINAL', why: `${count.agreed} of ${count.needed} re-runs inside [${open.ts}, ${end.ts}): the re-run is at threshold`, end: end.ts,
      inside: inside.length, outside: outside.length };
  return { state: 'VOID', why: `${count.agreed} of ${count.needed} re-runs inside [${open.ts}, ${end.ts}), none proves the player: §13C VOID`, end: end.ts,
    inside: inside.length, outside: outside.length };
}

test('two holder daemons with the same blocks through the end block name the same outcome; a node without the end block decides nothing; a filing at or after the end block is outside on both', async () => {
  const clock = blockClock({ spacingS: 1 });
  const w = await sevenSignerNodes(WINDOW_MS);
  const dir = mkdtempSync(join(tmpdir(), 'windowblocks-'));
  let b = null;
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    w.holder.round.db.exec(`VACUUM INTO '${join(dir, 'b.sqlite')}'`);
    b = await serve(openStore(join(dir, 'b.sqlite')), { port: 0, ...opts, advertsFor: () => w.adverts });
    assert.equal(toHex(b.round.pubkey), toHex(w.holder.round.pubkey), 'node B is not the same holder');
    const B = { holder: b, rid: w.rid };

    const t = Date.now();
    assert.equal((await object(w, eid)).status, 201);
    const own = (d) => d.round.reruns(w.rid, eid).some((r) => toHex(r.signerNodePubkey) === toHex(d.round.pubkey));
    assert.ok(await until(() => own(w.holder)), 'node A never re-ran');
    w.rerunBy('dissents', 3);
    const others = () => w.holder.round.reruns(w.rid, eid).filter((r) => toHex(r.signerNodePubkey) !== toHex(w.holder.round.pubkey));
    await until(() => Date.now() >= t + 1500, 3000);
    assert.equal((await object(B, eid)).status, 201);
    assert.ok(await until(() => own(b)), 'node B never re-ran');
    for (const r of others()) b.round.putRerun(w.rid, eid, r.signerNodePubkey, r.bytes);
    await until(() => Date.now() >= t + 3500, 4000);
    const earlier = new Set(others().map((r) => toHex(r.signerNodePubkey)));
    w.rerunBy('dissents', 4);                                                 // the fifth agreeing re-run, at t + 3500
    const fifth = others().find((r) => !earlier.has(toHex(r.signerNodePubkey)));
    b.round.putRerun(w.rid, eid, fifth.signerNodePubkey, fifth.bytes);
    const tA = w.holder.round.objectedAt(w.rid, eid);
    const tB = b.round.objectedAt(w.rid, eid);

    // TODAY'S ANSWER (the committed local-clock finality): the split the ruling is aimed at.
    const today = [w.holder, b].map((d) => resultFinality(at(d, t + 5000), w.rid, eid).state);

    // THE CHAIN AND EACH FILING'S ONE BLOCK: the first block at or after its first sighting at either holder.
    const chain = clock.view().blocks.map((x) => ({ ts: x.second * 1000 }));
    const blockOfMs = (ms) => chain.find((x) => x.ts >= ms).ts;
    const objectionTs = blockOfMs(Math.min(tA, tB));
    const firstSeen = new Map();
    for (const d of [w.holder, b])
      for (const r of d.round.reruns(w.rid, eid)) {
        const k = toHex(r.signerNodePubkey);
        firstSeen.set(k, Math.min(firstSeen.get(k) ?? Infinity, r.seenMs));
      }
    const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(w.rid).contract));
    const player = w.holder.round.entriesOf(w.rid).find((x) => toHex(x.entryId) === toHex(eid)).entry.playerPubkey;
    const agreed = (records) => rerunIsAgreed({ roundId: w.rid, playerPubkey: player, contradictedRunId: w.runs.dissents.contradicted,
      records, signerNodes: w.holder.round.signerNodes(w.rid), slots: contract.gameVerifySlots, verify: (s, m, k) => schnorr.verify(s, m, k) });
    const rerunsOf = (d, over = {}) => d.round.reruns(w.rid, eid).map((r) => ({ ...r,
      ts: over[toHex(r.signerNodePubkey)] ?? blockOfMs(firstSeen.get(toHex(r.signerNodePubkey))) }));
    const judge = (d, tipTs, over) => ruledWindow({ blocks: chain.filter((x) => x.ts <= tipTs), objectionTs, W: WINDOW_MS,
      reruns: rerunsOf(d, over), agreed });

    const endTs = chain.find((x) => x.ts > objectionTs && x.ts >= objectionTs + WINDOW_MS).ts;
    const fifthKey = toHex(fifth.signerNodePubkey);
    const fifthTs = blockOfMs(firstSeen.get(fifthKey));
    const full = [w.holder, b].map((d) => judge(d, endTs + 5000));
    const lagging = [judge(w.holder, endTs + 5000), judge(b, endTs - 1)];
    // THE SAME FILINGS WITH THE FIFTH RE-RUN IN AN EARLIER BLOCK, inside the window: both name the other outcome together.
    const insideFifth = [w.holder, b].map((d) => judge(d, endTs + 5000, { [fifthKey]: endTs - 1000 }));
    // AND A FILING IN THE END BLOCK ITSELF is outside on both.
    const atEnd = [w.holder, b].map((d) => judge(d, endTs + 5000, { [fifthKey]: endTs }));
    console.log('  FACTS (window blocks):', JSON.stringify({
      arrivals: { objectionA: tA - t, objectionB: tB - t, fifth: firstSeen.get(fifthKey) - t },
      today, objectionTs, endTs, fifthTs,
      full: full.map((x) => x.state), sameWhy: full[0].why === full[1].why,
      lagging: lagging.map((x) => x.state), laggingWhy: lagging[1].why,
      insideFifth: insideFifth.map((x) => x.state), atEnd: atEnd.map((x) => `${x.state}:${x.inside}in/${x.outside}out`),
    }), '|', full[0].why);

    // TODAY'S ANSWER, measured: the committed local-clock finality splits.
    assert.deepEqual(today, ['VOID', 'PROVISIONALLY_FINAL'], `the committed finality did not split as measured: ${today}`);
    // THE RULING: the same blocks through the end block, the same outcome for the same reason.
    assert.ok(fifthTs >= endTs, 'the fifth re-run did not land at or after the end block');
    assert.deepEqual(full.map((x) => x.state), ['VOID', 'VOID']);
    assert.equal(full[0].why, full[1].why);
    assert.deepEqual(insideFifth.map((x) => x.state), ['PROVISIONALLY_FINAL', 'PROVISIONALLY_FINAL']);
    assert.equal(insideFifth[0].why, insideFifth[1].why);
    // A NODE WITHOUT THE END BLOCK DECIDES NOTHING: a wait, not a second answer.
    assert.equal(lagging[1].state, null);
    assert.match(lagging[1].why, /does not yet hold the end block/);
    assert.equal(lagging[0].state, 'VOID');
    // A FILING AT OR AFTER THE END BLOCK IS OUTSIDE, on both.
    assert.deepEqual(atEnd.map((x) => x.state), ['VOID', 'VOID']);
    assert.ok(atEnd.every((x) => x.outside === 1 && x.inside === 4), 'the filing in the end block was counted inside');
  } finally {
    if (b) await b.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
