// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r20 h2h-1: A THIRD LOCK WITH A LOW ENTRY ID, HANDED TO ONLY SOME SEATS JUST BEFORE THE CLOSE, VOIDS AN HONEST PAIR'S PROTOCOL-28 ROUND.
// Role (a), a modified client. Each seat's lock-set view (server.js lockSetView) is round.js seatedEntriesOf - already cut to the game's
// `players` lowest entry ids. The attacker C (an entry id below one of the honest pair's, which a client can grind offline) locks at 4 of 7
// seats a moment before the close (the entry relay hands it on only after the close). Those 4 seats view {C, low}, the other 3 {A, B}; the
// signed set keeps only entries in >= 5 views (lockSetToSign): the honest pair's higher entry falls out with C. One entry certified: VOID.
// Safe behaviour: two honest players locked at every seat well before the close are both in the certified set (the round is played).
// Fixed from protocol 33 (kanban #3257, owner 2026-11-22 option A: the view holds every entry seen before the close; the seats are cut from the
// certified set), so the round here is written at DISJOINT_RULES_VERSION; a round below 33 keeps the old cut view byte for byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { DISJOINT_RULES_VERSION } from '../../arena-protocol/src/constants.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: DISJOINT_RULES_VERSION };
let k = 0x50;
const player = () => ({ name: `p${k}`, key: b32(k++), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const lockSetAt = async (d, w) => (await fetch(`http://127.0.0.1:${d.port}/lock-set?round=${toHex(w.rid)}`)).json();

test('#1489 r20 h2h-1: a low-id third lock at 4 of 7 seats just before the close does not void the honest pair', { timeout: 115000 }, async () => {
  let facts = null;
  for (let attempt = 0; attempt < 4 && !facts; attempt++) {
    const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS], closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 40000 });
    try {
      skipTo(Number(w.c.committeeTimeMs) + 20);
      const a = await lockAndPlay(w, player(), { hidden: { move: 0, salt: salt() }, noMarks: true });
      // the attacker enters while the table has a free seat (handout + entry, no lock: a lockless entry takes no seat), then B locks
      const cw = player();
      const c = await lockAndPlay(w, cw, { hidden: { move: 2, salt: salt() }, noMarks: true, only: [] });
      const b = await lockAndPlay(w, player(), { hidden: { move: 1, salt: salt() }, noMarks: true });
      const close = Number(w.c.entryCloseMs);
      // 1.5 s before the close the attacker hands his stake and fee lock to seats 0-3 only; the clock reaches the close before the relay's
      // lock hand-on (min(1.5 s, close - 300 ms) after the lock), as a client posting a moment before the close gets
      skipTo(close - 1500);
      await w.port.put(c.feeOutpoint, { paymentImage: { kind: 'hash', bytes: sha256(c.entry.feePreimage) }, amountMsat: c.entry.feeMsat, claimPk: w.claimPk,
        refundPk: refundKeyOf(cw.key), expiration: c.fields.expiration });
      const st = [];
      for (const d of w.nodes.slice(0, 4)) {
        const base = `http://127.0.0.1:${d.port}`;
        st.push((await fetch(`${base}/lock?entry=${toHex(c.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(c.fields)) })).status);
        st.push((await fetch(`${base}/fee-lock?entry=${toHex(c.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: sha256(c.entry.feePreimage) },
          amountMsat: c.entry.feeMsat, claimPk: w.claimPk, refundPk: refundKeyOf(cw.key), expiration: c.fields.expiration })) })).status);
      }
      skipTo(close + 1);
      console.log('  attacker lock statuses at seats 0-3:', st.join(','));
      const hi = toHex(a.eid) > toHex(b.eid) ? toHex(a.eid) : toHex(b.eid);
      if (toHex(c.eid) > hi) { console.log('  (attacker id above both honest ids - a client grinds it offline; next round)'); continue; }
      const until = Date.now() + 9000;
      let sets = [];
      for (;;) { sets = await Promise.all(w.nodes.map((d) => lockSetAt(d, w))); if (sets.every((s) => s.certificate || s.void) || Date.now() > until) break; await wait(100); }
      const views = sets.map((s, i) => { const v = (s.views || []).find((x) => x.key === toHex(w.nodes[i].round.pubkey)); return v ? v.entries.map((e) => e.slice(0, 8)) : null; });
      facts = { ids: { a: toHex(a.eid).slice(0, 8), b: toHex(b.eid).slice(0, 8), c: toHex(c.eid).slice(0, 8) }, views,
        certified: sets.map((s) => (s.entries ? s.entries.map((e) => e.slice(0, 8)) : s.void ? 'VOID' : null)) };
      console.log('  FACTS:', JSON.stringify(facts));
      const honest = [toHex(a.eid), toHex(b.eid)];
      const played = sets.filter((s) => s.entries && honest.every((e) => s.entries.includes(e)));
      assert.ok(played.length >= 5, `the honest pair, locked at every seat well before the close, is not certified - the round goes VOID: ${JSON.stringify(facts)}`);
    } finally { await w.close(); }
  }
  assert.ok(facts, 'no attempt gave the attacker an id below an honest one');
});
