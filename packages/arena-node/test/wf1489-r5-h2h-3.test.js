// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 5 (h2h-3): A FREE OPTION IN EVERY PAID HEAD-TO-HEAD ROUND - THE LOCK WITHHELD UNTIL THE OPPONENT'S MOVE IS PUBLIC (P7/P1).
// A paying head-to-head round plays only entries whose stake a seat saw (#1437/#1544), and a seat takes a lock new to it up to the entry close
// + ENTRY_CLOSE_GRACE_MS (15 s, #1260). The reveal door opens AT the entry close, the page reveals 120 ms after it, and GET /reveals is public.
// So the attacker enters before the close with his commitment and his locks made but NOT handed to any seat, reads the opponent's move
// at close + 0.2 s, and only if his own hidden move wins hands his stake and fee locks over (inside the grace) and reveals: he is seated,
// played and wins the pot. If his move loses he hands nothing: the round seats one player, every entry is VOID, nobody's stake moves.
// SAFE: a lock handed over after the round's moves became public does not seat (play) its entry - the attacker cannot win this round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0xb0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));

test('#1489 r5-h2h-3: a lock handed over after the opponent revealed does not seat the entry that then wins', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the honest player: entry and both locks at every seat, rock hidden
    const sb = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sb }, noMarks: true });
    // the attacker: paper hidden, locks made in the federation, entry at every seat, no lock handed to any seat
    const sa = salt();
    const att = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sa }, noMarks: true, only: [] });
    const feeFields = { ...att.fields, paymentImage: { kind: 'hash', bytes: sha256(att.entry.feePreimage) }, amountMsat: att.entry.feeMsat };
    // the close: the honest page reveals at once (index.html: entry close + 120 ms)
    skipTo(Number(w.c.entryCloseMs) + 150);
    const bases = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    const rev = (p, move, s) => Promise.all(bases.map(async (b) => (await fetch(`${b}/reveal?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));
    const honestRev = await rev(honest, ROCK, sb);
    // the attacker reads the public move ...
    const seen = await (await fetch(`${bases[0]}/reveals?round=${toHex(w.rid)}`)).json();
    const opp = seen.reveals.find((r) => r.entry === toHex(honest.eid));
    // kanban #2727: on this tree no move is public at close + 150 ms (#1822 H2H_REVEAL_HOLD_MS) - the attacker does not need to see it for the
    // check below: a lock new to a seat after the close must not seat his entry, whatever he knew
    console.log('  public at close + 150 ms:', JSON.stringify(opp || null), JSON.stringify(seen).slice(0, 160));
    // ... his paper beats it: now he hands his locks over, inside the grace, and reveals
    skipTo(Number(w.c.entryCloseMs) + 3000);
    const lateLock = await Promise.all(bases.map(async (b) => { const r = await fetch(`${b}/lock?entry=${toHex(att.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(att.fields)) }); return `${r.status} ${(await r.text()).slice(0, 120)}`; }));
    let lateFee = null;
    if (feeFields) lateFee = await Promise.all(bases.map(async (b) => { const r = await fetch(`${b}/fee-lock?entry=${toHex(att.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) }); return `${r.status} ${(await r.text()).slice(0, 120)}`; }));
    const attRev = await rev(att, PAPER, sa);
    const seenAtt = w.nodes.map((d) => !!d.round.stakeSeen(att.eid));
    await closeRound(w);
    const got = { attacker: results(w, att.eid), honest: results(w, honest.eid) };
    console.log('  FACTS (r5-h2h-3):', JSON.stringify({ honestRev, lateLock, lateFee, attRev, stakeSeenAfterLateLock: seenAtt, results: got }));
    for (const [i, s] of seenAtt.entries()) assert.equal(s, false, `seat ${i} counted the attacker's stake, handed over ${3000} ms after the close, once the opponent's rock was public`);
    for (const per of got.attacker) assert.ok(!per.includes('DELIVERED 2'), `the attacker who locked only after seeing the opponent's move won: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
