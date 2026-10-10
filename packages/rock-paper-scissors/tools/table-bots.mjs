#!/usr/bin/env node
// TABLES WITHOUT A BROWSER (kanban #293, the owner 2026-10-10: "Test that feature and protocol change without chrome and OpenGL
// as much as possible"): N players in one node process against the seats - each seats itself with the client's own seatAt
// (read out of client/index.html, as the page runs it), enters a hidden move as the page does (entryFor, moveCommitment,
// submitPick), reveals after the close, and keeps a pair at its table. Free rounds (the demo seats); a full table sends the
// tap on to the next open one, as the client does.
//
//   node packages/rock-paper-scissors/tools/table-bots.mjs <seat,seat> <out.json> [slots=30] [schedule]
// schedule (JSON): { "P6": { "from": 25 }, "P2": { "until": 30 } } - when a player comes and leaves, in slots
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { playerFor, entryFor } from '../../arena-client/src/join.js';
import { hiddenMove, moveCommitment, revealMove } from '../../arena-client/src/head-to-head.js';
import { submitPick } from '../../arena-client/src/market.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { RPS_GAME_ID } from '../plugin/rock-paper-scissors.js';

const [seatList, OUT, SLOTS = '30', SCHEDULE = '{}'] = process.argv.slice(2);
const nodes = seatList.split(',');
const schedule = JSON.parse(SCHEDULE);
const PLAYERS = Number(process.env.PLAYERS || 5);
const html = readFileSync(new URL('../client/index.html', import.meta.url), 'utf8');
const seatAt = new Function(html.slice(html.indexOf('// SEATING BEGIN'), html.indexOf('// SEATING END')) + '\nreturn seatAt;')();
const WINDOW = 8000, CLOSING = 1500;
const GAME = toHex(RPS_GAME_ID);
const random = (n) => new Uint8Array(randomBytes(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString().slice(11, 23), ...o }));

let listing = [];
const slotsSeen = new Map();   // close -> Map(id -> { id, joined })
async function look() {
  try {
    const d = await (await fetch(`${nodes[0]}/rounds`)).json();
    listing = (d.rounds || []).filter((r) => r.game && r.game.id === GAME).map((r) => ({ id: r.id, close: Number(r.entryCloseMs), joined: Number(r.joined) || 0, open: !!r.entryOpen && !!r.assignedHere }));
    for (const r of listing) { const m = slotsSeen.get(r.close) || new Map(); m.set(r.id, { id: r.id, joined: r.joined }); slotsSeen.set(r.close, m); }
  } catch { /* the next look */ }
}
// LIVE: a table's players as the seat holds them now (/api/round-result) - the signed listing's `joined` waits for its row to be
// signed again (measured: 0 for a table a player had entered 1.2 s before), and pairs were split on it
async function liveCounts(ids) {
  const got = await Promise.all(ids.map(async (id) => { try { const j = await (await fetch(`${nodes[0]}/api/round-result?round=${id}`)).json(); return [id, (j.players || []).length]; } catch { return [id, null]; } }));
  return new Map(got);
}
const contracts = new Map();
async function contractOf(id) {
  if (!contracts.has(id)) contracts.set(id, (async () => decodeRoundContract(new Uint8Array(await (await fetch(`${nodes[0]}/round?id=${id}`)).arrayBuffer())))());
  return contracts.get(id);
}
const players = Array.from({ length: PLAYERS + Object.keys(schedule).filter((p) => !/^P[1-9]$/.test(p) || Number(p.slice(1)) > PLAYERS).length },
  (_, i) => ({ name: 'P' + (i + 1), seed: random(32), last: null, rounds: [] }));
const taps = [];
async function enter(P, row, move, slot) {
  const rec = { slot, player: P.name, round: row.id, joinedSeen: row.joined, at: Date.now(), leftMs: row.close - Date.now(), status: null, reseated: null, heldMs: null };
  taps.push(rec);
  const tryRound = async (id) => {
    const c = await contractOf(id);
    const round = Object.assign({}, c, { id: fromHex(id) });
    const player = playerFor(round, { seed: P.seed, curve: pageCurve });
    const sessionPubkey = random(32);
    const hidden = hiddenMove(move, random);
    const entry = Object.assign(entryFor(round, { seed: P.seed, curve: pageCurve, playerPubkey: player.pubkey, random, donationMsat: 0n, joinTick: 0 }), { roundId: fromHex(id), sessionPubkey });
    entry.commit = moveCommitment({ roundId: entry.roundId, sessionPubkey, move: hidden.move, salt: hidden.salt });
    const sent = await submitPick({ entry, stakeLock: null, nodes });
    return { sent, hidden };
  };
  let got = await tryRound(row.id);
  if (!got.sent.entries.some((x) => x.status === 201) && /already seats/.test(got.sent.why || '')) {
    const other = listing.filter((x) => x.close === row.close && x.id !== row.id && x.open && x.joined < 2).sort((x, y) => (x.id < y.id ? -1 : 1));
    const to = other.find((x) => x.joined === 1) || other[0];
    if (to) { rec.reseated = { from: row.id, to: to.id }; rec.round = to.id; got = await tryRound(to.id); }
  }
  rec.status = got.sent.entries.map((x) => x.status);
  rec.why = got.sent.entries.some((x) => x.status === 201) ? null : String(got.sent.why || '').slice(0, 160);
  if (!rec.why) {
    rec.heldMs = Date.now() - rec.at;
    P.last = rec.round;
    P.rounds.push({ slot, round: rec.round, entryIdHex: got.sent.entryId, move: got.hidden.move, salt: got.hidden.salt, close: row.close });
  }
  return rec;
}
// THE RUN: every slot, each player present taps once at its own moment in the slot's 8 s (a pair's two at different times)
await look();
const lookTimer = setInterval(look, 250);
const t0 = Date.now();
for (let slot = 0; slot < Number(SLOTS); slot++) {
  // the slot offered now: the soonest close with more than CLOSING left (and inside its window + CLOSING)
  let close = null;
  for (let i = 0; i < 400 && close === null; i++) {
    const now = Date.now();
    const can = listing.filter((r) => r.open && r.close - now > CLOSING && r.close - now <= WINDOW + CLOSING && !players.some((p) => p.rounds.some((x) => x.round === r.id)));
    if (can.length) close = Math.min(...can.map((r) => r.close)); else await sleep(100);
  }
  if (close === null) { say({ step: 'no slot', slot }); continue; }
  const present = players.filter((P) => { const s = schedule[P.name] || {}; const n = Number(P.name.slice(1));
    return (s.from !== undefined ? slot >= s.from : n <= PLAYERS) && (s.until === undefined || slot < s.until); });
  // each one's moment: spread over the slot's first 4 s (pairs are not in step)
  const order = present.map((P) => ({ P, wait: Math.floor(Math.random() * 4000) })).sort((a, b) => a.wait - b.wait);
  const start = Date.now();
  // the slot before, frozen now (as the client freezes it when it first seats a slot)
  const beforeKey = [...slotsSeen.keys()].filter((k) => k < close).sort((x, y) => y - x)[0];
  let prevFrozen = beforeKey !== undefined ? [...slotsSeen.get(beforeKey).values()].map((x) => ({ ...x })) : null;
  if (prevFrozen) { const live = await liveCounts(prevFrozen.map((x) => x.id)); prevFrozen = prevFrozen.map((x) => ({ ...x, joined: live.get(x.id) ?? x.joined })); }
  const recs = await Promise.all(order.map(async ({ P, wait }) => {
    await sleep(Math.max(0, wait - (Date.now() - start)));
    const now = Date.now();
    const here = listing.filter((r) => r.close === close);
    const live = await liveCounts(here.map((r) => r.id));
    const slotRows = here.map((r) => ({ id: r.id, joined: live.get(r.id) ?? r.joined, open: r.open }));
    const row = seatAt(slotRows, { prevSlot: prevFrozen, mineId: P.last });
    if (!row) { const rec = { slot, player: P.name, round: null, at: now, why: 'no table free in this slot' }; taps.push(rec); P.last = null; return rec; }
    const full = listing.find((r) => r.id === row.id);
    return enter(P, { id: row.id, joined: row.joined, close: full ? full.close : close }, Math.floor(Math.random() * 3), slot);
  }));
  // which table each sat at (by the slot's order of round ids)
  const ids = [...new Set(listing.filter((r) => r.close === close).map((r) => r.id))].sort();
  const tables = {};
  for (const r of recs) if (r && r.round && !r.why) (tables[ids.indexOf(r.round) + 1] = tables[ids.indexOf(r.round) + 1] || []).push(r.player);
  say({ step: 'slot', slot, tables: ids.length, seated: tables, unseated: recs.filter((r) => r && r.why).map((r) => `${r.player}: ${r.why.slice(0, 60)}`) });
  // reveal this slot's moves once it closed (in the background)
  setTimeout(() => { for (const P of players) for (const x of P.rounds.filter((y) => y.close === close && !y.revealed)) {
    x.revealed = true; revealMove({ entryIdHex: x.entryIdHex, move: x.move, salt: x.salt, nodes }).catch(() => {}); } }, Math.max(0, close - Date.now() + 300));
  // wait for the next slot to be offered
  await sleep(Math.max(0, close - CLOSING - Date.now() + 50));
}
clearInterval(lookTimer);
await sleep(3000);
writeFileSync(OUT, JSON.stringify({ started: new Date(t0).toISOString(), players: players.map((P) => ({ name: P.name, rounds: P.rounds.map((r) => ({ slot: r.slot, round: r.round })) })), taps }, null, 1));
say({ step: 'done', taps: taps.length, held: taps.filter((t) => !t.why).length });
process.exit(0);
