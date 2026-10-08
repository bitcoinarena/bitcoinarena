// DO TWO TABS THAT PRESS PLAY A LITTLE APART LAND IN THE SAME ROUND? (the owner 2026-09-17 19:15, the two-tab gate.)
//
// Every ghost number on this letter was measured with BOTH seats pinned to one round id: the probe reads the lobby
// once and hands the same round to the driver and the watcher. A player does not do that. the owner opens one tab, presses
// PLAY, then opens the second and presses PLAY - seconds or a minute later - and each tab picks a round out of its own
// lobby listing. If the first tab's round stops being joinable in between, the second tab joins the NEXT one, the two
// are in different rounds, and neither is ever shown the other: no ghost, no label, no rim marker, and nothing in the
// draw path is wrong.
//
// So this reads the lobby the page reads - `fetchLobby`, the same rows, the same `joinable` rule - and writes down how
// long a free round stays joinable and how long the gap is before the next one. It seats nobody and drives nothing.
import { readFileSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { fetchLobby } from '../src/lobby.js';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const DAILY = arg('daily', process.env.ARENA_2OF2_DIR || '/mnt/bitcoin/blwp-2of2');
const MINUTES = Number(arg('minutes', 6));
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);

const NODES = JSON.parse(readFileSync(`${DAILY}/daily.json`, 'utf8')).node;
const until = Date.now() + MINUTES * 60000;
const rounds = new Map();          // id -> { firstJoinable, lastJoinable }
let noneJoinable = 0, looks = 0;

console.log(`# the Daily lobby, ${MINUTES} min: how long a free round stays joinable for a second tab`);
while (Date.now() < until) {
  const lobby = await fetchLobby({ nodes: NODES, verify }).catch(() => ({ rows: [] }));
  const now = Date.now();
  const free = (lobby.rows || []).filter((r) => r.free);
  const joinable = free.filter((r) => r.phase === 'open' && r.joinable);
  looks++;
  if (joinable.length === 0) noneJoinable++;
  for (const r of joinable) {
    const kept = rounds.get(r.id) || { firstJoinable: now, lastJoinable: now };
    kept.lastJoinable = now;
    rounds.set(r.id, kept);
  }
  console.log(`${clock(now)}  free rows ${free.length}, joinable ${joinable.length}  `
    + joinable.map((r) => `${r.id.slice(0, 8)} closes in ${Math.round((Number(r.entryCloseMs) - now) / 1000)}s`).join('  '));
  await wait(5000);
}

console.log('\n# each free round, and how long a second tab could still have joined it');
const windows = [];
const seen = [...rounds.entries()].sort((a, b) => a[1].firstJoinable - b[1].firstJoinable);
for (const [id, k] of seen) {
  const open = Math.round((k.lastJoinable - k.firstJoinable) / 1000);
  windows.push(open);
  console.log(`${id.slice(0, 8)}  joinable ${clock(k.firstJoinable)} -> ${clock(k.lastJoinable)}  ${open}s at least`);
}
const gaps = [];
for (let i = 1; i < seen.length; i++) gaps.push(Math.round((seen[i][1].firstJoinable - seen[i - 1][1].lastJoinable) / 1000));
console.log(`\njoinable window: ${windows.length ? `${Math.min(...windows)}-${Math.max(...windows)}s` : 'none seen'}`);
console.log(`gap with NO joinable free round: ${gaps.length ? `${Math.min(...gaps)}-${Math.max(...gaps)}s` : 'none seen'}`
  + `, and ${noneJoinable} of ${looks} looks found none at all`);
console.log('a second tab pressing PLAY inside a window joins the same round as the first; one that presses PLAY after '
  + 'that window joins the next round, and the two tabs never see each other.');
