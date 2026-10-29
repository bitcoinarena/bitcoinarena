// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ROUND'S AUDITOR, END TO END (spec §13A.1, kanban #725, protocol 22). A protocol-22 paid round on one seat of seven (sevenSignerNodes:
// the holder, and six keys the test signs with), its end a few seconds ahead, and a second daemon that holds the round, is no seat of it
// and is the one node that may audit it (weight 1 of 1, so its own VRF always draws it). Inside the window the auditor reads the round
// from the seat (GET /audit-run), replays every entry from what the seat hands out through the seat's own objection check, and then:
//   1. five seats signed the run the replay gives: it posts its AUDIT (POST /audit); the seat keeps it once, refuses a stranger's
//      forward, and names the auditor in its settlement's lines; FINAL does not wait for it;
//   2. five seats signed a false run: it files the §13A objection for that entry, which holds at the seat and suspends the run - and
//      posts no AUDIT; a valid objection later contradicting a held AUDIT marks it, paid nothing.
// (The money of the line is lock-settlement's: arena-protocol auditor-settlement.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sevenSignerNodes, opts, wait, WINDOW_MS } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { CLOCK } from './block-clock.js';
import { assumeAssigned } from './assignment.js';
import { HOSTED } from './plugins/hosted.js';
import { AUDITOR_VERSION } from '../../arena-protocol/src/constants.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { SUSPENDED } from '../../arena-protocol/src/objection.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { resultFinality } from '../src/finality.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { createServer } from 'node:http';

const audits = async (d, rid) => (await (await fetch(`http://127.0.0.1:${d.port}/audits?round=${toHex(rid)}`)).json()).audits;

/** The seat's round at protocol 22, and the auditor daemon beside it. */
async function seatAndAuditor(relays = undefined) {
  const box = { key: null };
  const audit = { everyMs: 0, setFor: () => (box.key ? { eligible: new Map([[box.key, 1n]]), total: 1n } : null) };
  const w = await sevenSignerNodes(WINDOW_MS, relays, { endMs: testNow() + 4000, storedBeforeTheRule: true, round: { protocolVersion: AUDITOR_VERSION },
    serveOpts: { audit } });
  const auditor = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts, stakeLocks: w.slot.port, chainFor: w.slot.chainFor,
    randomnessFor: w.slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2), audit });
  auditor.round.chainView = CLOCK.chainView();
  box.key = toHex(auditor.round.pubkey);
  // IT HOLDS THE ROUND, AS ANY NODE IT WAS POSTED TO, and sits in none of its committees: they are the seven the census assigned
  auditor.round.open(w.contract);
  assumeAssigned(auditor.round, w.rid, w.contract.nodes);
  auditor.verifier.peers = [`http://127.0.0.1:${w.holder.port}`];
  return { w, auditor, key: box.key, close: async () => { await auditor.close(); await w.close(); } };
}

test('1. five seats signed the run the replay gives: the AUDIT is posted inside the window, kept once, named in the settlement', { timeout: 170000 }, async () => {
  const { w, auditor, key, close } = await seatAndAuditor();
  try {
    w.sign('agrees', () => ({}));
    w.sign('dissents', () => ({}));
    const win = windowsOf(w.contract);
    // INSIDE THE WINDOW: the round's end passed, its runs agreed
    skipTo(Number(win.openMs) + 1000);
    assert.deepEqual(await w.holder.auditor.pass(), [], 'a seat audits nothing of a round it sits in');
    const did = await auditor.auditor.pass();
    console.log('  AUDIT PASS (1):', JSON.stringify(did));
    assert.deepEqual(did, [{ round: toHex(w.rid), audited: 2, seats: 1 }], 'both entries replayed as signed; the AUDIT taken by the seat');
    assert.deepEqual(await auditor.auditor.pass(), [], 'once a round');
    const held = await audits(w.holder, w.rid);
    assert.deepEqual(held.map((a) => [a.node, a.forwarded, a.contradicted]), [[key, false, null]]);
    // THE SAME AUDIT AGAIN: already held; "forwarded" by a key that is no seat of the round: refused, and nothing changes
    const kept = w.holder.round.db.prepare('SELECT bytes, signature FROM audits').get();
    const body = new Uint8Array([...new Uint8Array(kept.bytes), ...new Uint8Array(kept.signature)]);
    const base = `http://127.0.0.1:${w.holder.port}`;
    const again = await fetch(`${base}/audit`, { method: 'POST', body });
    assert.deepEqual([again.status, (await again.text()).trim()], [200, 'already held']);
    const stranger = await fetch(`${base}/audit`, { method: 'POST', body, headers: { 'x-audit-seat': key, 'x-audit-forward': '00'.repeat(64) } });
    assert.deepEqual([stranger.status, (await stranger.text()).trim()], [403, 'a forwarded AUDIT counts only from a seat of its round']);
    // AFTER THE CLOSE nothing more is taken
    skipTo(Number(win.closeMs) + 10);
    const late = await fetch(`${base}/audit`, { method: 'POST', body: body.slice() });
    assert.equal(late.status, 409);
    // THE SETTLEMENT'S LINES NAME IT: the seat's held set, read at settlement
    const lines = w.holder.settlements.signerNodesFor(w.rid, w.contract);
    assert.deepEqual(lines.auditors, [key], 'the auditors\' line names the auditor whose AUDIT the seat holds');
    // AND FINAL NEVER WAITED FOR IT: the run is signed FINAL by five of seven past final_after, as without an auditor
    const f = await w.finalNow('agrees');
    assert.equal(f.state, 'FINAL', f.why);
  } finally { await close(); }
});

test('2. five seats signed a false run: the auditor files the objection, it holds and suspends the run, and no AUDIT is posted', { timeout: 170000 }, async () => {
  const { w, auditor, close } = await seatAndAuditor();
  try {
    w.sign('agrees', () => ({}));
    w.sign('dissents', (r) => ({ score: r.score + 7 }));                 // five keys sign a run nobody played
    skipTo(Number(windowsOf(w.contract).openMs) + 1000);
    const did = await auditor.auditor.pass();
    console.log('  AUDIT PASS (2):', JSON.stringify(did));
    const eid = w.runs.dissents.eid;
    assert.deepEqual(did, [{ round: toHex(w.rid), objected: toHex(eid), taken: true }], 'the objection for the false run, taken');
    assert.equal(w.holder.round.objected(w.rid, eid), true);
    assert.equal(resultFinality(w.holder.round, w.rid, eid).state, SUSPENDED, 'the objection suspends the run, as any objector\'s');
    assert.deepEqual(await audits(w.holder, w.rid), [], 'an auditor that objects posts no AUDIT');
  } finally { await close(); }
});

test('3. a valid objection contradicting a held AUDIT: the seat marks it, keeps its bytes, and pays it nothing', { timeout: 170000 }, async () => {
  const { w, auditor, key, close } = await seatAndAuditor();
  try {
    w.sign('agrees', () => ({}));
    w.sign('dissents', () => ({}));
    skipTo(Number(windowsOf(w.contract).openMs) + 1000);
    assert.equal((await auditor.auditor.pass())[0].audited, 2);
    // THE SEAT'S OWN WORD THAT A VALID OBJECTION CONTRADICTED ONE OF THE ROUND'S RESULTS (what rerunAndFile, a late objection and a
    // second objection record): driven here through the desk the server calls, as the contradiction itself is §13A's, measured elsewhere
    assert.deepEqual(w.holder.auditDesk.contradict(w.rid, `entry ${toHex(w.runs.dissents.eid)}: VOID after a valid objection`), [key]);
    const [row] = await audits(w.holder, w.rid);
    assert.match(row.contradicted, /VOID after a valid objection/);
    assert.ok(row.audit && row.audit.length > 128, 'its bytes and signature: the evidence against its signer');
    assert.deepEqual(w.holder.settlements.signerNodesFor(w.rid, w.contract).auditors, [], 'a contradicted AUDIT is paid nothing');
  } finally { await close(); }
});

// §13A.1: the AUDIT goes "to the round's seats (POST /audit) and its publication_relays[]" - the seat that keeps one hands it on to the
// round's relays, as it does an objection (kanban #725)
test('4. a kept AUDIT goes on to the round\'s publication relays, once', { timeout: 170000 }, async () => {
  const got = [];
  const relay = createServer((req, res) => { const parts = []; req.on('data', (d) => parts.push(d));
    req.on('end', () => { got.push({ method: req.method, url: req.url, bytes: Buffer.concat(parts) }); res.writeHead(201); res.end('AUDIT kept'); }); });
  await new Promise((r) => relay.listen(0, '127.0.0.1', r));
  const { w, auditor, close } = await seatAndAuditor([`http://127.0.0.1:${relay.address().port}`]);
  try {
    w.sign('agrees', () => ({}));
    w.sign('dissents', () => ({}));
    skipTo(Number(windowsOf(w.contract).openMs) + 1000);
    assert.deepEqual(await auditor.auditor.pass(), [{ round: toHex(w.rid), audited: 2, seats: 1 }]);
    // the relay also gets the round's transcripts (PUT/GET /transcript); only its AUDITs are asked about here
    const audited = () => got.filter((g) => g.url === '/audit');
    for (let i = 0; i < 100 && !audited().length; i++) await wait(50);
    const kept = w.holder.round.db.prepare('SELECT bytes, signature FROM audits').get();
    const body = Buffer.from([...new Uint8Array(kept.bytes), ...new Uint8Array(kept.signature)]);
    assert.deepEqual(audited().map((g) => [g.method, g.url, g.bytes.equals(body)]), [['POST', '/audit', true]], 'the AUDIT\'s own bytes, to the relay');
    // THE SAME AUDIT AGAIN is already held: not relayed a second time
    const again = await fetch(`http://127.0.0.1:${w.holder.port}/audit`, { method: 'POST', body: new Uint8Array(body) });
    assert.equal(again.status, 200);
    await wait(300);
    assert.equal(audited().length, 1, 'relayed once');
  } finally { await close(); await new Promise((r) => relay.close(r)); }
});
