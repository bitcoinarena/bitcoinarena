// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3742, the /play half (ruled 2026-11-25). M3.3-34's reach rule - a Void this seat was handed signs no lock refund unless
// its proof pull reached every other signer node - spares a Void learned on the player's own catch-up ('player'). The /play socket
// took any client's copy of the player-signed bytes, and those are public (GET /entry-void), so a stranger sending the first mark
// and a mark past the line to seats 5 and 6 on path 2 had them kept as 'player': the refund formed with 6 of 7 while the proof sat
// on seat 4, down. Now 'player' needs a socket the entry's session key bound to itself (`nonce`, then `player <entry> <signature>`
// over playOwnerDigest); the same bytes on any other socket are 'play-unbound', and wait for the full reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { sevenSignerNodes, joinWithTwoFirstMarks, pathTwoSignerNodeFourDown, voidAtZeroToThree, refundNow, answer, say, wait, toHex, ed25519 } from './five-of-seven-fixture.js';
import { playOwnerDigest } from '../../arena-protocol/src/play-owner.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

/** One /play socket, each message answered in order. */
const socketTo = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  const waiting = [];
  ws.on('message', (d, bin) => { const w = waiting.shift(); if (w) w(bin ? new Uint8Array(d) : d.toString()); });
  ws.on('error', reject);
  ws.on('open', () => resolve({ ask: (m) => new Promise((r) => { waiting.push(r); ws.send(m); }), close: () => ws.close() }));
});

/** The player's socket: bound to the entry by its session key over the seat's nonce. */
async function playerSocket(port, run) {
  const s = await socketTo(port);
  const [word, nonceHex, seatHex] = String(await s.ask('nonce')).split(' ');
  assert.equal(word, 'nonce');
  const sig = ed25519.sign(playOwnerDigest({ seatPubkey: fromHex(seatHex), nonce: fromHex(nonceHex), entryId: run.eid }), run.session);
  assert.equal(await s.ask(`player ${toHex(run.eid)} ${toHex(sig)}`), `player ${toHex(run.eid)}`);
  return s;
}

// ONLY THE PLAYER BRINGS THE VOID to the seats that were down (4-6): the Void seats' forwards to them are lost (0-3 cut, and
// their forwards in flight run out, before 4-6 return), and 4-6 come back reaching 0-3 alone - not each other - so each learns
// the Void from the catch-up it is sent, not from a seat's hand-over. Healed before the refund is asked.
async function backWithOnlyThePlayer(w) {
  w.cut(0, 1, 2, 3);
  await wait(4000);                                    // a forward already walking 0-3's old peer lists ends before 4-6 listen again
  const reach = [0, 1, 2, 3].map((j) => `http://127.0.0.1:${w.signerNodes[j].port}`).concat(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
  await w.backReaching(reach, 4, 5, 6);
}

test('#3742 /play: a stranger replaying the public first mark to seats 5 and 6 gets no "player" Void - no refund forms while the proof seat is down', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const setup = await pathTwoSignerNodeFourDown(w, run);
    // the stranger: the public bytes, on sockets nobody bound - and a binding it cannot make (a key of its own, a nonce reused)
    const handed = [];
    for (const i of [5, 6]) {
      const s = await socketTo(w.signerNodes[i].port);
      const [, nonceHex, seatHex] = String(await s.ask('nonce')).split(' ');
      const forged = ed25519.sign(playOwnerDigest({ seatPubkey: fromHex(seatHex), nonce: fromHex(nonceHex), entryId: run.eid }), ed25519.utils.randomSecretKey());
      const bad = String(await s.ask(`player ${toHex(run.eid)} ${toHex(forged)}`));
      const again = String(await s.ask(`player ${toHex(run.eid)} ${toHex(forged)}`));
      const said = [];
      for (const m of [...run.first, ...run.past]) said.push(answer(await s.ask(m)));
      s.close();
      handed.push({ i, bad: bad.slice(0, 90), again: again.slice(0, 90), said, learned: (w.signerNodes[i].round.entryVoid(run.eid) || {}).learned || null });
    }
    const now = await refundNow(w, run);
    console.log('  FACTS #3742 /play stranger:', JSON.stringify({ voidedFirst: setup.voidedFirst, lateAt4: setup.lateAt4, handed, doors: now.doors, commits: now.commits, kept: now.kept, lockHeld: now.lockHeld }));
    assert.equal(setup.voidedFirst, 4, 'setup: signer nodes 0-3 did not all record ENTRY_VOID');
    assert.equal(setup.lateAt4, true, 'setup: signer node 4 kept no late first mark (the proof)');
    for (const h of handed) {
      assert.match(h.bad, /^error .*session key/, `seat ${h.i} took a binding signed by another key: ${h.bad}`);
      assert.match(h.again, /^error .*nonce/, `seat ${h.i} took a second try on one nonce: ${h.again}`);
      assert.notEqual(h.learned, 'player', `seat ${h.i} kept a stranger's replay as the player's catch-up`);
    }
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund door answered 2xx while the proof seat was down: ${JSON.stringify(now.doors)}`);
    assert.equal(now.kept, 0, `${now.kept} signer nodes keep a committee refund of the lock`);
    assert.equal(now.lockHeld, true);
  } finally { await w.close(); }
});

test('#3742 /play: the player\'s own catch-up on a bound socket after a real outage still refunds at once, with one seat unreachable at the refund', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);                     // 4-6 down: a real outage, 0-3 record ENTRY_VOID
    await backWithOnlyThePlayer(w);
    const caughtUp = {};
    for (const i of [4, 5, 6]) {
      const s = await playerSocket(w.signerNodes[i].port, run);
      caughtUp[i] = [];
      for (const m of [...run.first, ...run.past]) caughtUp[i].push(answer(await s.ask(m)));
      s.close();
    }
    await wait(2000);
    const learned = w.signerNodes.map((d) => (d.round.entryVoid(run.eid) || {}).learned || null);
    w.heal();
    await w.down(4);                                                          // one seat unreachable when the refund is asked
    const now = await refundNow(w, run);
    console.log('  FACTS #3742 /play bound catch-up:', JSON.stringify({ voidedFirst, caughtUp, learned, doors: now.doors, commits: now.commits, kept: now.kept, lockHeld: now.lockHeld }));
    assert.equal(voidedFirst, 4, 'setup: signer nodes 0-3 did not all record ENTRY_VOID');
    assert.deepEqual(learned.slice(4), ['player', 'player', 'player'], `the bound catch-up was not kept as the player's: ${JSON.stringify(learned)}`);
    assert.ok(now.doors.some((s) => s === 200), `the genuine outage-VOID's refund did not form at once: ${JSON.stringify(now.doors)}`);
    assert.ok(now.kept > 0, 'no signer node keeps the refund of a genuine outage-VOID');
  } finally { await w.close(); }
});

// the control for the second test: the same catch-up on unbound sockets (one-shot, as a stranger would send it) is held to the
// full reach - with seat 4 down, 5 and 6 refuse, and 0-3 alone are four of the five signatures a refund needs
test('#3742 /play: the same catch-up on unbound sockets is held to the full reach - with one seat unreachable no refund forms at once', async () => {
  const w = await sevenSignerNodes('lock', { endIn: 25000 });
  try {
    const run = await joinWithTwoFirstMarks(w, 'lock');
    const voidedFirst = await voidAtZeroToThree(w, run);
    await backWithOnlyThePlayer(w);
    for (const i of [4, 5, 6]) for (const m of [...run.first, ...run.past]) await say(w.signerNodes[i].port, m);
    await wait(2000);
    const learned = w.signerNodes.map((d) => (d.round.entryVoid(run.eid) || {}).learned || null);
    w.heal();
    await w.down(4);
    const now = await refundNow(w, run);
    console.log('  FACTS #3742 /play unbound catch-up:', JSON.stringify({ voidedFirst, learned, doors: now.doors, commits: now.commits, kept: now.kept, lockHeld: now.lockHeld }));
    assert.equal(voidedFirst, 4, 'setup: signer nodes 0-3 did not all record ENTRY_VOID');
    assert.deepEqual(learned.slice(4), ['play-unbound', 'play-unbound', 'play-unbound'], `an unbound socket's catch-up was kept as the player's: ${JSON.stringify(learned)}`);
    assert.ok(!now.doors.some((s) => s >= 200 && s < 300), `a refund formed on unbound catch-ups with a seat unreachable: ${JSON.stringify(now.doors)}`);
    assert.equal(now.lockHeld, true);
  } finally { await w.close(); }
});
