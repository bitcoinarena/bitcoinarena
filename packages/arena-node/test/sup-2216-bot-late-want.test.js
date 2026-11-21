// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 state machine audit 8, head-to-head (the test opponent): THE BOT LOCKS A STAKE NO SEAT WILL TAKE.
// Adapted to 1.9 by #2536 (kanban #2216): 1.9's rps-opponent (#2043) starts no entry with less than the seats' 1.5x handout lead left and
// posts its handout before any lock, so a late want may be declined outright - the test no longer requires the bot to take it, only that
// nothing is locked for an entry no seat takes. The card's two tests of its own env knobs (H2H_HANDOUT_LEAD_MS, LOCK_LEAD_MS) are not kept.
// #1485 made a live seat refuse a head-to-head handout under H2H_HANDOUT_LEAD_MS (2 s, node-start.js) before the entry close, and
// the page refuses the tap - so nothing is locked for an entry that cannot land. The test opponent (tools/rps-opponent.mjs) was not
// changed: it still enters with as little as MIN_LEFT_MS (900 ms) / 400 ms left, and it LOCKS FIRST (lockEntry, the stake, the fee
// lock and the donation outputs in one transaction) and posts the handout and the entry after. With 0.9-2 s left every seat refuses
// the handout, so every seat refuses the entry; the bot hands its locks only to the seats that took the entry - none - so no seat
// ever learns the lock (no refused-lock forfeit, no unentered return, kanban #593): the stake waits for its lock's expiry and the
// fee/donation outputs are spent. And the player it was called for is left alone: his paid round is VOID.
// Driven here: two real seats (serve(), h2hHandoutLeadMs 2000 as node-start.js sets it), the real bot as a child process, a lock
// client that only records what the bot locks. The invariant: nothing is locked for an entry no seat takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lockRound } from './lock-round-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const BOT = fileURLToPath(new URL('../tools/rps-opponent.mjs', import.meta.url));

// A LOCK CLIENT THAT ONLY RECORDS: every lockSubmit the bot makes is one line in LOCKED_FILE (the stake, the fee lock, the donations)
const fakeLockClient = (fedHex, lockedFile) => `
import { appendFileSync } from 'node:fs';
export default async function init() {}
let n = 0;
export class LockClient {
  static federationIdOf() { return ${JSON.stringify(fedHex)}; }
  static async join() { return new LockClient(); }
  async feeRule() { return JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }); }
  async balanceMsat() { return '100000000'; }
  async lockSubmit(point, netMsat, feeHash, feeMsat, claimPk, refundPk, expiry, shares) {
    n += 1;
    appendFileSync(${JSON.stringify(lockedFile)}, JSON.stringify({ at: Date.now(), netMsat, feeMsat, shares: JSON.parse(shares || '[]').length }) + '\\n');
    const txid = String(n).padStart(64, '0');
    const outputs = [{ role: 'stake', amount_msat: netMsat, out_idx: 0, computed_expiration: 1000 }];
    if (feeHash) outputs.push({ role: 'fee', amount_msat: feeMsat, out_idx: 1, computed_expiration: 1000 });
    return JSON.stringify({ txid, outputs });
  }
  lockAccepted() { return Promise.resolve('{}'); }
}
`;

// the bot run against two real seats; the want list names the round while `from` > left > `to` ms; `check` reads what came of it
const run = async ({ from, to, endPad = 12000, seatLeadMs = 2000, botEnv = {} }, check) => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: seatLeadMs }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + endPad });
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm8-h2h-1-'));
  const pkg = join(dir, 'pkg'), botDir = join(dir, 'bot'), locked = join(dir, 'locked.jsonl');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(pkg); mkdirSync(botDir);
  writeFileSync(join(pkg, 'blwp_lock_client.js'), fakeLockClient(toHex(TEST_FEDERATION_ID), locked));
  writeFileSync(join(pkg, 'blwp_lock_client_bg.wasm'), Buffer.alloc(8));
  writeFileSync(join(dir, 'invite.txt'), 'fed11testinvite');
  let bot = null, wants = null;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // THE BOT'S CLOCK IS THE SEATS' (the fixtures' clock runs ahead of the wall clock by the skip)
    const offset = testNow() - Date.now();
    const clock = join(dir, 'clock.mjs');
    writeFileSync(clock, `const real = Date.now.bind(Date); Date.now = () => real() + ${offset};\n`);
    const ridHex = toHex(w.rid), closeMs = Number(w.c.entryCloseMs);
    const startLeftMs = closeMs - testNow();
    // THE PAGE'S WANT LIST (faucet /opponent): a player tapped at this table - said once the round has 1.7 s left, as a want read
    // late (or "a player paid", read off /api/round-result ~4 s after the tap) reaches the bot
    let toldAt = null;
    wants = http.createServer((req, res) => {
      const left = closeMs - testNow();
      const list = left < from && left > to ? [{ round: ridHex, agoMs: 0, tapped: true }] : [];
      if (list.length && toldAt === null) toldAt = left;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ wants: list }));
    });
    await new Promise((r) => wants.listen(0, '127.0.0.1', r));
    const out = [];
    bot = spawn(process.execPath, ['--import', pathToFileURL(clock).href, BOT], {
      env: { ...process.env, NODES: w.nodes.map((d) => `http://127.0.0.1:${d.port}`).join(','), WANTS: `http://127.0.0.1:${wants.address().port}/opponent`,
        INVITES: join(dir, 'invite.txt'), WASM_PKG: pkg, DIR: botDir, ONCE: '1', ...botEnv },
      stdio: ['ignore', 'pipe', 'pipe'] });
    bot.stdout.on('data', (b) => out.push(String(b)));
    bot.stderr.on('data', (b) => out.push(String(b)));
    // until the round's entries are closed and the bot's posts had their time
    for (let i = 0; i < 200 && testNow() < closeMs + 2500; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500));
    const lines = out.join('').split('\n').filter(Boolean);
    const steps = lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l.slice(0, 200) }; } });
    const lockedRows = existsSync(locked) ? readFileSync(locked, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const entries = w.nodes.map((d) => d.round.entriesOf(w.rid).length);
    const locksHeld = w.nodes.map((d) => d.round.entriesOf(w.rid).filter(({ entryId }) => !!d.round.stakeLock(entryId)).length);
    console.log('  FACTS (#1489 sm8-h2h-1):', JSON.stringify({ startLeftMs, toldAtLeftMs: toldAt, locked: lockedRows.map((x) => ({ leftMs: closeMs - x.at, netMsat: x.netMsat, feeMsat: x.feeMsat })),
      entriesPerSeat: entries, stakeLocksPerSeat: locksHeld, bot: steps.filter((s) => s.step || s.raw).map((s) => s.raw || `${s.step}${s.why ? ': ' + s.why : ''}${s.refused ? ': ' + JSON.stringify(s.refused) : ''}`).slice(-12) }));
    assert.ok(toldAt !== null, 'the want list never named the round');
    // 1.9 (#2043): the bot does not even start an entry with less than the seats' 1.5x handout lead left - it may decline the want outright
    check({ entries, locksHeld, lockedRows, closeMs, steps });
  } finally {
    if (bot) bot.kill('SIGKILL');
    if (wants) wants.close();
    await w.close();
  }
};

test('#1489 sm8-h2h-1: the test opponent locks nothing for an entry the seats refuse at the head-to-head handout lead', { timeout: 110000 }, async () => {
  await run({ from: 1700, to: 0 }, ({ entries, lockedRows, closeMs }) => {
    // the seats took nothing of it: the handout lead refused the handout, so the entry too
    assert.deepEqual(entries, [0, 0], 'a seat took the bot\'s entry inside the handout lead');
    // THE INVARIANT: no stake (and no fee, no donation) is locked for an entry no seat takes
    assert.equal(lockedRows.length, 0, `the bot locked ${lockedRows.length} stake transaction(s) (${lockedRows.map((x) => `${x.netMsat} msat stake + ${x.feeMsat} msat fee, ${closeMs - x.at} ms before the close`).join('; ')}) for an entry every seat refused - no seat holds the lock, nothing returns it before its expiry`);
  });
});

// kanban #2216, the honest path: seats with no handout lead (serve()'s fixture default) and a bot told the same, so the fixtures' 1.5 s entry
// window is enough - the bot posts its handout first, locks once both seats took it, and both seats take its entry
