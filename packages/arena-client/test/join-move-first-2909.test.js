// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PAID TAP WITH THE SATS IN THE OTHER FEDERATION IS NOT LOST (kanban #2909, 2026-11-16): a Rock Paper Scissors tap with every sat in 4dc88be7
// and the round in 337ae01a was refused at the tap - "Move them over with Move" - and the first press was lost, while the page moved the sats by
// itself seconds later. The page's join now moves first (or waits for the move going) and then joins: the tapped round if its lead still holds,
// else the next round of the same game, stake and federation, with the same move. The page's own code is run here on a stand-in window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const FED_A = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e', FED_B = '4dc88be70830d3619fd8742eaf639ab297774850cc68a203aad5b10a21e1fe98';
const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// the helper as the page has it, compiled against a stand-in window
const helperSrc = (() => {
  const a = PAGE.indexOf('      const JOIN_MOVE_WAIT_MS = '), b = PAGE.indexOf('      window.ARENA_LOBBY_ACT = {', a);
  assert.ok(a > 0 && b > a, 'the page has the #2909 helper before ARENA_LOBBY_ACT');
  return PAGE.slice(a, b);
})();
const build = (win) => new Function('window', 'ARENACLIENT', 'ORDER_CUTOFF_MS', 'crypto', 'fetch', 'console', `${helperSrc}\nreturn { joinAfterMove, JOIN_MOVE_WAIT_MS };`)(
  win, { toHex, ECASH_EXCHANGE_PREFIX: 'arena.ecash.exchange.', joinFundingPlan: ({ parts, roundFederation }) => { const here = parts.find((p) => p.federation === roundFederation); return { coveredBy: here && here.sats >= 100 ? 'here' : 'swap' }; }, tabSeed: () => new Uint8Array(32), rememberedInvite: () => 'fed1invite', presenceProofFor: () => null }, 3000, { getRandomValues: (x) => x }, async () => ({}), { log() {}, warn() {} });

const row = (id, fed, closeInMs) => ({ id, joinable: true, free: false, entryCloseMs: Date.now() + closeInMs,
  contract: { federationId: hexToBytes(fed), stakeMsat: 100000n, gameId: hexToBytes('ab'.repeat(32)) } });

function standIn({ exchangeArrivesMs = 300, tapped = 'r1', tappedCloseInMs = 20000 } = {}) {
  const calls = [];
  const win = {
    ARENA_WALLET_BALANCE: { parts: [{ federation: FED_A, sats: 0 }, { federation: FED_B, sats: 3000 }] },
    ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: class {} }),
    ARENA_BROWSER_STORE: () => ({}), ARENA_ROW_NODES: () => [], ARENA_H2H_LEAD_MS: () => 4000, ARENA_SEAT_AHEAD_MS: 0,
    ARENA_HIDDEN_CHOSEN: { round: tapped, move: 1 },
    ARENA_LOBBY_ROWS: [row('r1', FED_A, tappedCloseInMs), row('r2', FED_A, tappedCloseInMs + 12000), row('rB', FED_B, 30000)],
    ARENA_EXCHANGE_INTO: async (o) => {
      calls.push({ resumeOnly: !!o.resumeOnly, needMsat: o.needMsat, to: o.to });
      if (!o.resumeOnly) setTimeout(() => { win.ARENA_WALLET_BALANCE = { parts: [{ federation: FED_A, sats: 105 }, { federation: FED_B, sats: 2895 }] }; }, exchangeArrivesMs);
      return o.resumeOnly ? { ok: false, why: 'resumed only' } : { ok: false, why: 'the seat has not answered yet (503)' };
    },
    ARENA_SUM_BALANCES: () => {},
    joins: [],
  };
  win.ARENA_LOBBY_ACT = { join: (id, o) => { win.joins.push({ id, ...o }); return true; } };
  return { win, calls };
}
const waitFor = async (f, ms = 8000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 50)); } return true; };
const answers = [];
const answer = (ok, why, more) => { answers.push({ ok, why, more }); return ok; };

test('#2909: the tap starts the exchange, answers "moving-funds" (not refused), and joins the TAPPED round once the sats are there', async () => {
  const { win, calls } = standIn();
  const { joinAfterMove } = build(win);
  const r = win.ARENA_LOBBY_ROWS[0];
  const ok = joinAfterMove({ id: 'r1', r: { raw: { contract: r.contract }, stakeSats: 100 }, fedHex: FED_A, needMsat: 100000n, plan: { coveredBy: 'swap', ownHere: 0 }, holdUntilMs: 0, link: false, answer });
  assert.equal(ok, true);
  assert.equal(win.ARENA_JOIN.state, 'joining');
  assert.match(win.ARENA_JOIN.stage, /moving your sats into this game's federation/);
  assert.ok(await waitFor(() => win.joins.length === 1), 'the round is joined once the sats arrived');
  assert.deepEqual({ id: win.joins[0].id, moved: win.joins[0].moved }, { id: 'r1', moved: true });
  assert.equal(calls[0].to, FED_A);
  assert.equal(calls[0].needMsat, 105000n, 'the stake and 5 % for the fees');
  assert.equal(calls.filter((c) => !c.resumeOnly).length, 1, 'one exchange sent, never a second one while the first is on its way');
});

test('#2909: a tapped round whose lead ran out while the sats moved: the next round of the same game, stake and federation, with the same move', async () => {
  const { win } = standIn({ tappedCloseInMs: 4000, exchangeArrivesMs: 600 });
  const { joinAfterMove } = build(win);
  const r = win.ARENA_LOBBY_ROWS[0];
  joinAfterMove({ id: 'r1', r: { raw: { contract: r.contract }, stakeSats: 100 }, fedHex: FED_A, needMsat: 100000n, plan: { coveredBy: 'swap', ownHere: 0 }, holdUntilMs: 0, link: false, answer });
  assert.ok(await waitFor(() => win.joins.length === 1));
  assert.equal(win.joins[0].id, 'r2', 'not rB (the other federation), not r1 (its lead is gone)');
  assert.deepEqual(win.ARENA_HIDDEN_CHOSEN, { round: 'r2', move: 1 });
});

test('#2909: the page wires it in: the swap/merge case of the tap goes to joinAfterMove before the old refusal, and a moved join does not move again', () => {
  const i = PAGE.indexOf("return joinAfterMove({ id, r, fedHex, needMsat, plan, holdUntilMs, link, answer });");
  const j = PAGE.indexOf("return answer(false, 'not-funded-here', { coveredBy: plan.coveredBy, ownHere: plan.ownHere });");
  assert.ok(i > 0 && j > i);
  assert.match(PAGE, /plan\.coveredBy === 'merge'\) && !moved && !next && window\.ARENA_EXCHANGE_INTO/);
  assert.match(PAGE, /join\(id, \{ holdUntilMs = 0, next = false, link = false, moved = false \} = \{\}\)/);
  assert.match(PAGE, /if \(resumeOnly\) \{/);
  // the lobby's move ahead does not send a second exchange beside the tap's (measured on the preview: both ran, 105 sat moved twice)
  assert.match(PAGE, /if \(window\.ARENA_JOIN_MOVING \|\| \(window\.ARENA_JOIN && window\.ARENA_JOIN\.moving && window\.ARENA_JOIN\.state === 'joining'\)\) return;/);
});

test('#2909: a move ahead the lobby just made is not sent a second time - the tap asks the kept exchange again and joins when it lands', async () => {
  const { win, calls } = standIn();
  win.ARENA_PREPARE_FUNDS = Object.assign(() => {}, { busy: false, lastMs: Date.now() - 2000 });
  setTimeout(() => { win.ARENA_WALLET_BALANCE = { parts: [{ federation: FED_A, sats: 105 }, { federation: FED_B, sats: 2895 }] }; }, 500);
  const { joinAfterMove } = build(win);
  const r = win.ARENA_LOBBY_ROWS[0];
  joinAfterMove({ id: 'r1', r: { raw: { contract: r.contract }, stakeSats: 100 }, fedHex: FED_A, needMsat: 100000n, plan: { coveredBy: 'swap', ownHere: 0 }, holdUntilMs: 0, link: false, answer });
  assert.ok(await waitFor(() => win.joins.length === 1));
  assert.equal(win.joins[0].id, 'r1');
  assert.equal(calls.filter((c) => !c.resumeOnly).length, 0, 'no second exchange');
});

test('#2909: an exchange of this browser still on its way (a seat took the notes, answered 503): asked again, never sent a second time', async () => {
  const { win, calls } = standIn();
  win.ARENA_BROWSER_STORE = () => ({ 'arena.ecash.exchange.x': '{}' });
  setTimeout(() => { win.ARENA_WALLET_BALANCE = { parts: [{ federation: FED_A, sats: 105 }, { federation: FED_B, sats: 2895 }] }; }, 3500);
  const { joinAfterMove } = build(win);
  const r = win.ARENA_LOBBY_ROWS[0];
  joinAfterMove({ id: 'r1', r: { raw: { contract: r.contract }, stakeSats: 100 }, fedHex: FED_A, needMsat: 100000n, plan: { coveredBy: 'swap', ownHere: 0 }, holdUntilMs: 0, link: false, answer });
  assert.ok(await waitFor(() => win.joins.length === 1));
  assert.equal(calls.filter((c) => !c.resumeOnly).length, 0, 'no second exchange');
  assert.ok(calls.filter((c) => c.resumeOnly).length >= 1, 'the kept one asked again');
});

test('#2909: a tap that found a merge going: when the merge lands in the OTHER federation, the swap is made and the round joined', async () => {
  const { win, calls } = standIn();
  const { joinAfterMove } = build(win);
  const r = win.ARENA_LOBBY_ROWS[0];
  joinAfterMove({ id: 'r1', r: { raw: { contract: r.contract }, stakeSats: 100 }, fedHex: FED_A, needMsat: 100000n, plan: { coveredBy: 'merge', ownHere: 0 }, holdUntilMs: 0, link: false, answer });
  assert.ok(await waitFor(() => win.joins.length === 1));
  assert.equal(calls.filter((c) => !c.resumeOnly).length, 1, 'the swap made once the merge was no longer the way');
});
