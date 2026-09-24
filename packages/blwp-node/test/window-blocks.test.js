// THE WINDOW IS BLOCKS, BOTH ENDS (§13A; RULED the owner 2026-09-24) - the ruling, locked as `ruledWindow` below at
// e460687a before any code followed it, and now the finality every holder answers.
//
// THE RULING:
//   - Every §13A window is [open block, end block): the first objection window, the re-run window, the re-run's own
//     window. It opens at the block its opening filing names (the posting that completes the threshold; the objection;
//     the agreed re-run first at threshold) and ends at the first later block whose median time past is at or after
//     open + objection_window_ms. Median time past, not a header's own time: it only rises.
//   - A filing is assigned to the block hash it carries - not to a receipt time, not to anyone's sighting. It is inside
//     only if that block is in the chain, at or after the open, and strictly before the end block; the end block or
//     later, or a hash not in the chain once the end block is present: outside.
//   - A node without the end block decides nothing - no FINAL, VOID, slash or claim. Tip lag is a wait.
//   - Two holders with the same blocks through the end block name the same outcome.
//
// THE MEASURED SPLIT it closes, on two holder daemons: node A is the fixture's holder, node B a second daemon on a byte
// copy of A's store (VACUUM INTO) - the same holder, its own clock and arrivals. The one objection (naming one block)
// reaches A at t and B at t + 1500; W = 3000; the holder's re-run and three others inside, the fifth agreeing re-run made
// at t + 3500. On the local-clock finality this was measured at e460687a as A VOID, B PROVISIONALLY_FINAL at t + 5000.
// Now both answer from the blocks: the same outcome for the same reason.
//
// THE CHAIN is the fixtures' block clock (block-clock.js): one block per second, a block's time its median time past;
// a stubbed read sees the chain as of its moment. Every filing names the tip as of when it was made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { CLOCK } from './block-clock.js';
import { sevenSignerNodes, object, WINDOW_MS, wait, opts, say } from './window-fixture.js';
import { rerunIsAgreed, decodeRerunResult, splitSignedRerun } from '../../protocol/src/rerun.js';
import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';

const at = (d, now) => Object.assign(Object.create(d.round), { now: () => now });
async function until(cond, ms = 8000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(25)) if (cond()) return true;
  return cond();
}

/**
 * THE RULED RE-RUN WINDOW, as a pure function of the blocks a node holds (`blocks`: [{ ts }] through its tip, ascending)
 * and the block each filing names (`ts`). Answers { state, why }; state null is "decides nothing". The spec lock of
 * e460687a, kept as the reference the node's finality is compared with.
 */
function ruledWindow({ blocks, objectionTs, W, reruns, agreed }) {
  const open = blocks.find((b) => b.ts === objectionTs);
  if (!open) return { state: null, why: 'this node does not hold the block the objection sits in: it decides nothing' };
  const end = blocks.find((b) => b.ts > open.ts && b.ts >= open.ts + W);
  if (!end) return { state: null, why: `this node does not yet hold the end block (the first at or after ${open.ts + W}): it decides nothing` };
  const inside = reruns.filter((r) => r.ts >= open.ts && r.ts < end.ts);
  const count = agreed(inside);
  return { state: count.ok ? 'PROVISIONALLY_FINAL' : 'VOID', end: end.ts, inside: inside.length, agreed: count.agreed || 0 };
}

test('two holder daemons with the same blocks through the end block name the same outcome; a node without the end block decides nothing; a filing in the end block is outside on both; a receipt-time gap no longer splits', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  const dir = mkdtempSync(join(tmpdir(), 'windowblocks-'));
  let b = null;
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    w.holder.round.db.exec(`VACUUM INTO '${join(dir, 'b.sqlite')}'`);
    b = await serve(openStore(join(dir, 'b.sqlite')), { port: 0, ...opts, advertsFor: () => w.adverts });
    b.round.chainView = CLOCK.chainView();
    assert.equal(toHex(b.round.pubkey), toHex(w.holder.round.pubkey), 'node B is not the same holder');
    const B = { holder: b, rid: w.rid };
    const nodes = [w.holder, b];

    // ONE OBJECTION, NAMING ONE BLOCK: A has it at t, B at t + 1500. JUST AFTER A SECOND BOUNDARY, as objection-window
    // does: the clock is one block a second, so t + 3500 (the fifth re-run) must land in the block the reads below are
    // written for - measured under load with t late in its second: the fifth re-run named the block after the end block
    // and the inside re-run's own window had not closed at the read (PROVISIONALLY_FINAL at both, the same outcome).
    while (Date.now() % 1000 > 300) await wait(20);
    const t = Date.now();
    const objectionBlock = CLOCK.tipAt(t);
    assert.equal((await object(w, eid, objectionBlock)).status, 201);
    const ownOf = (d) => d.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(d.round.pubkey));
    assert.ok(await until(() => ownOf(w.holder)), 'node A never re-ran');
    // THE HOLDER'S RE-RUN IS ONE RECORD: B holds A's, so the one holder does not sign a second of its own.
    const holderRerun = ownOf(w.holder);
    b.round.putRerun(w.rid, eid, holderRerun.signerNodePubkey, holderRerun.bytes);
    w.rerunBy('dissents', 3);
    const others = () => w.holder.round.reruns(w.rid, eid).filter((r) => toHex(r.signerNodePubkey) !== toHex(w.holder.round.pubkey));
    await until(() => Date.now() >= t + 1500, 3000);
    assert.equal((await object(B, eid, objectionBlock)).status, 201);
    for (const r of others()) b.round.putRerun(w.rid, eid, r.signerNodePubkey, r.bytes);
    await until(() => Date.now() >= t + 3500, 4000);
    const copyNew = (seen) => { for (const r of others()) if (!seen.has(toHex(r.signerNodePubkey))) b.round.putRerun(w.rid, eid, r.signerNodePubkey, r.bytes); };
    let known = new Set(others().map((r) => toHex(r.signerNodePubkey)));
    w.rerunBy('dissents', 4);                                                 // the fifth agreeing re-run, made at t + 3500
    copyNew(known);
    const receipts = { objectionA: w.holder.round.objectedAt(w.rid, eid) - t, objectionB: b.round.objectedAt(w.rid, eid) - t };

    const openTs = CLOCK.mtpOf(objectionBlock);
    const endTs = CLOCK.endAt(openTs, WINDOW_MS);
    const read = (now) => nodes.map((d) => resultFinality(at(d, now), w.rid, eid));

    // THE REFERENCE: the ruled window over each node's own records, by the block each names.
    const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(w.rid).contract));
    const player = w.holder.round.entriesOf(w.rid).find((x) => toHex(x.entryId) === toHex(eid)).entry.playerPubkey;
    const agreed = (records) => rerunIsAgreed({ roundId: w.rid, playerPubkey: player, contradictedRunId: w.runs.dissents.contradicted,
      records, signerNodes: w.holder.round.signerNodes(w.rid), slots: contract.gameVerifySlots, verify: (s, m, k) => schnorr.verify(s, m, k) });
    const chainTo = (ms) => CLOCK.viewAt(ms).blocks.map((x) => ({ ts: x.second * 1000 }));
    const model = (d, tipMs) => ruledWindow({ blocks: chainTo(tipMs), objectionTs: openTs, W: WINDOW_MS, agreed,
      reruns: d.round.reruns(w.rid, eid).map((r) => ({ ...r, ts: CLOCK.mtpOf(decodeRerunResult(splitSignedRerun(r.bytes).body).blockHash) })) });

    // 1. THE SAME BLOCKS THROUGH THE END BLOCK, THE SAME OUTCOME: the fifth re-run's block is at or after the end.
    const at5000 = read(t + 5000);
    const past = read(endTs + 1000);
    const fifthTs = CLOCK.mtpOf(decodeRerunResult(splitSignedRerun(others().find((r) => !known.has(toHex(r.signerNodePubkey))).bytes).body).blockHash);
    const models = { past: nodes.map((d) => model(d, endTs + 1000).state), lagging: model(b, endTs - 1).state };
    // 2. A NODE WITHOUT THE END BLOCK DECIDES NOTHING.
    const lagging = resultFinality(at(b, endTs - 1), w.rid, eid);
    // 3. A FILING IN THE END BLOCK IS OUTSIDE, ON BOTH: a sixth agreeing re-run naming the end block itself.
    known = new Set(others().map((r) => toHex(r.signerNodePubkey)));
    w.rerunBy('dissents', 5, { keys: w.others, block: CLOCK.tipAt(endTs) });
    copyNew(known);
    const withEndFiling = read(endTs + 1000);
    // 4. AND ONE NAMING A BLOCK INSIDE: both turn together - the re-run at threshold, and, its own window's end block being
    //    there too at this read, FINAL.
    known = new Set(others().map((r) => toHex(r.signerNodePubkey)));
    w.rerunBy('dissents', 6, { keys: w.others, block: CLOCK.tipAt(openTs + 1000) });
    copyNew(known);
    // Read one block later, where the agreed re-run's own window - opened at the inside filing's block - has closed too.
    const withInside = read(endTs + 1000);

    console.log('  FACTS (window blocks):', JSON.stringify({ receipts, openTs, endTs, fifthTs,
      at5000: at5000.map((x) => x.state), past: past.map((x) => `${x.state}:${x.rerun && x.rerun.agreed}`), sameWhy: past[0].why === past[1].why,
      lagging: `${lagging.state}:${lagging.blockPending}`, withEndFiling: withEndFiling.map((x) => `${x.state}:${x.rerun && x.rerun.agreed}`),
      withInside: withInside.map((x) => `${x.state}:${x.rerun && x.rerun.agreed}`), models }), '|', past[0].why);

    // A RECEIPT-TIME GAP NO LONGER SPLITS.
    assert.ok(receipts.objectionB - receipts.objectionA >= 1400, 'the two receipts were not 1500 ms apart');
    assert.deepEqual(at5000.map((x) => x.state), ['VOID', 'VOID'], `the receipt gap still splits: ${at5000.map((x) => x.state)}`);
    assert.equal(at5000[0].why, at5000[1].why);
    assert.ok(fifthTs >= endTs, 'the fifth re-run did not name a block at or after the end block');
    assert.deepEqual(past.map((x) => x.state), ['VOID', 'VOID']);
    assert.equal(past[0].why, past[1].why);
    assert.deepEqual(models.past, ['VOID', 'VOID'], 'the node and the ruled window disagree');
    assert.notEqual(lagging.state, 'VOID');
    assert.notEqual(lagging.state, 'FINAL');
    assert.equal(lagging.blockPending, true, 'a node without the end block decided');
    assert.equal(models.lagging, null);
    assert.deepEqual(withEndFiling.map((x) => `${x.state}:${x.rerun.agreed}`), ['VOID:4', 'VOID:4'], 'the end-block filing was counted inside');
    assert.deepEqual(withInside.map((x) => `${x.state}:${x.rerun.agreed}`), ['FINAL:5', 'FINAL:5']);
    assert.equal(withInside[0].why, withInside[1].why);
  } finally {
    if (b) await b.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// §13C'S EVIDENCE ON THE RE-RUN WINDOW (RULED the owner 2026-09-24): a pair counts only if both its marks sit strictly before
// the re-run window's end block, the same at every holder. THE LATE PAIR: the objection, the holder's re-run and three
// others - short of five, so §13C decides at the re-run window's end. Past that end block the player's second first mark
// reaches node A only. Both holders must name the same outcome and file the same first-result slash set.
test('a pair made after the re-run window\'s end block is outside at both holders: the same §13C outcome and the same first-result slash set', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  const dir = mkdtempSync(join(tmpdir(), 'evidenceblocks-'));
  let b = null;
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    w.holder.round.db.exec(`VACUUM INTO '${join(dir, 'b.sqlite')}'`);
    b = await serve(openStore(join(dir, 'b.sqlite')), { port: 0, ...opts, advertsFor: () => w.adverts });
    b.round.chainView = CLOCK.chainView();
    const B = { holder: b, rid: w.rid };
    const t = Date.now();
    const objectionBlock = CLOCK.tipAt(t);
    assert.equal((await object(w, eid, objectionBlock)).status, 201);
    assert.equal((await object(B, eid, objectionBlock)).status, 201);
    const ownOf = (d) => d.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(d.round.pubkey));
    assert.ok(await until(() => ownOf(w.holder)), 'node A never re-ran');
    const holderRerun = ownOf(w.holder);
    b.round.putRerun(w.rid, eid, holderRerun.signerNodePubkey, holderRerun.bytes);
    w.rerunBy('dissents', 3);
    for (const r of w.holder.round.reruns(w.rid, eid)) b.round.putRerun(w.rid, eid, r.signerNodePubkey, r.bytes);
    const endTs = CLOCK.endAt(CLOCK.mtpOf(objectionBlock), WINDOW_MS);
    await until(() => Date.now() >= endTs + 1000, 15000);
    const pairAfterEnd = Date.now() >= endTs;
    const said = await say(w.holder.port, w.runs.dissents.otherFirstMark());          // to A only, past the end block
    await wait(300);
    const read = (d) => resultFinality(d.round, w.rid, eid);
    const states = [w.holder, b].map((d) => { const f = read(d); return { state: f.state, noQuorum: !!f.noQuorum, proof: d.round.provenTwoFirstMarks(w.rid, eid) }; });
    // THE FIRST-RESULT SLASH FOLLOWS THE §13C RECORD: whatever each holder's watch filed, and a filing asked for now.
    for (const d of [w.holder, b]) await d.verifier.fileFirstResultSlashProofs(w.rid, eid);
    const slashes = [w.holder, b].map((d) => d.round.slashProofs(w.rid, eid).map((p) => toHex(p.nodePubkey)).sort().join(','));
    console.log('  FACTS (late pair, re-run window):', JSON.stringify({ pairAfterEnd, said: String(said).slice(0, 80), states, slashes: slashes.map((s) => s.split(',').filter(Boolean).length), sameSlash: slashes[0] === slashes[1] }));
    assert.equal(pairAfterEnd, true, 'the second first mark was not sent after the end block: not the case the test names');
    assert.equal(states[0].proof, true, 'A holds no pair: not the case the test names');
    assert.equal(states[1].state, 'VOID', `B: ${JSON.stringify(states[1])}`);
    assert.equal(states[0].state, states[1].state, `the holders split on a pair after the end block: A ${states[0].state}, B ${states[1].state}`);
    assert.equal(slashes[0], slashes[1], 'the holders file different first-result slash sets');
  } finally {
    if (b) await b.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// AND THE SAME PAIR INSIDE: the player's second first mark reaches both holders before the re-run window's end block - it
// counts at both, and both name FORFEIT and hold the same first-result slash set.
test('a pair made before the re-run window\'s end block counts at both holders: FORFEIT at both, the same first-result slash set', async () => {
  const w = await sevenSignerNodes(WINDOW_MS);
  const dir = mkdtempSync(join(tmpdir(), 'evidenceblocks-'));
  let b = null;
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    w.holder.round.db.exec(`VACUUM INTO '${join(dir, 'b.sqlite')}'`);
    b = await serve(openStore(join(dir, 'b.sqlite')), { port: 0, ...opts, advertsFor: () => w.adverts });
    b.round.chainView = CLOCK.chainView();
    const B = { holder: b, rid: w.rid };
    const objectionBlock = CLOCK.tipAt(Date.now());
    assert.equal((await object(w, eid, objectionBlock)).status, 201);
    assert.equal((await object(B, eid, objectionBlock)).status, 201);
    const second = w.runs.dissents.otherFirstMark();
    for (const d of [w.holder, b]) await say(d.port, second);                        // to both, inside the window
    const endTs = CLOCK.endAt(CLOCK.mtpOf(objectionBlock), WINDOW_MS);
    const pairBeforeEnd = Date.now() < endTs;
    const ownOf = (d) => d.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(d.round.pubkey));
    assert.ok(await until(() => ownOf(w.holder)), 'node A never re-ran');
    const holderRerun = ownOf(w.holder);
    b.round.putRerun(w.rid, eid, holderRerun.signerNodePubkey, holderRerun.bytes);
    w.rerunBy('dissents', 3);
    for (const r of w.holder.round.reruns(w.rid, eid)) b.round.putRerun(w.rid, eid, r.signerNodePubkey, r.bytes);
    await until(() => Date.now() >= endTs + 1000, 15000);
    const states = [w.holder, b].map((d) => { const f = resultFinality(d.round, w.rid, eid); return { state: f.state, noQuorum: !!f.noQuorum }; });
    for (const d of [w.holder, b]) await d.verifier.fileFirstResultSlashProofs(w.rid, eid);
    const slashes = [w.holder, b].map((d) => d.round.slashProofs(w.rid, eid).map((p) => toHex(p.nodePubkey)).sort().join(','));
    console.log('  FACTS (pair inside, re-run window):', JSON.stringify({ pairBeforeEnd, states, slashes: slashes.map((s) => s.split(',').filter(Boolean).length), sameSlash: slashes[0] === slashes[1] }));
    assert.equal(pairBeforeEnd, true, 'the second first mark was not sent before the end block: not the case the test names');
    assert.deepEqual(states.map((x) => x.state), ['FORFEIT', 'FORFEIT']);
    assert.equal(slashes[0], slashes[1], 'the holders file different first-result slash sets');
    assert.ok(slashes[0].split(',').filter(Boolean).length > 0, 'no first-result signer was slashed');
  } finally {
    if (b) await b.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
