// KILL THE CUSTODIAN MID-RUN AND SEE WHO GOT PAID.
//
// The property 23.2 is built around is that inaction is the safe direction:
// "the default path - nobody acting - is always the refund. That is what makes
// infrastructure failure safe." A unit test cannot show that, because a unit
// test's node always comes back. This one does not: the child is killed with
// SIGKILL while three stakes are in flight, and what is measured afterwards is
// the store it left on disk and the log of everything it ever said to
// Lightning.
//
// Three things must be true of a custodian that died mid-round:
//
//   1. every stake is still HELD - in flight, in nobody's balance
//   2. the Lightning log contains createHeld and NOTHING else: no settle, no
//      cancel, no preimage released
//   3. a node that restarts and finds no FINAL result still moves nothing
//
// Nobody being paid is the correct outcome, not a failure to recover: the
// HTLCs expire and every wallet takes its own money back.
//
// SINGLE-NODE CUSTODY, NOT §23.5. One node, one port, no threshold.
//
//   node packages/blwp-node/tools/custody-crash.mjs
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { CORE_HASH } from './core-hash.mjs';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Custody, HELD, SETTLED, CANCELLED, MID_ACT } from '../src/custody.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { DELIVERED, FORFEIT, VOID } from '../../protocol/src/payout.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
// The player's own secret and the commitment their contract carries. A settle
// releases the first, so a node that has not got it settles nothing.
const preimageOf = (n) => b32(n + 60);
const preimageFor = (id, e) => preimageOf(e.pubkey[0]);
const NOW = 1788700000000;
const CONTRACT = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, simCoreHash: CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)],
};
const entryFor = (rid, n) => ({
  roundId: rid, playerPubkey: b32(n), sessionPubkey: b32(n + 40),
  stakeCommitment: sha256(preimageOf(n)),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const PLAYERS = [1, 2, 3];

/**
 * A port that writes down everything it is asked to do BEFORE it does it, on
 * a file that outlives the process. A real Lightning node's own log is the
 * equivalent, and the reason the log is the evidence rather than the store is
 * that a settle a node performed and did not record is exactly the failure
 * this measurement is looking for.
 */
function loggingPort(logPath) {
  const say = (line) => appendFileSync(logPath, line + '\n');
  return {
    async createHeld({ paymentHash, amountMsat }) {
      say(`createHeld ${toHex(paymentHash)} ${amountMsat}`);
      return { paymentHash, amountMsat, request: 'lnbcrt-fake' };
    },
    // THE PORT ANSWERS FROM ITS OWN LOG, which is the whole point: a real
    // Lightning node knows what it did to an invoice whatever this node
    // remembers, and that is the only thing that can settle the question.
    async look({ paymentHash }) {
      const hash = toHex(paymentHash);
      const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n') : [];
      say(`look ${hash}`);
      if (lines.some((l) => l === `settle ${hash}`)) return { state: SETTLED };
      if (lines.some((l) => l === `cancel ${hash}`)) return { state: CANCELLED };
      return { state: HELD };
    },
    async settle({ paymentHash }) { say(`settle ${toHex(paymentHash)}`); },
    async cancel({ paymentHash }) { say(`cancel ${toHex(paymentHash)}`); },
  };
}

/**
 * The child again, but killed at the hardest moment there is: INSIDE the
 * settle, after Lightning has been told and before this node has written down
 * that it told it. That is the only window where the two can disagree, and a
 * node that comes back into it either re-settles a stake or forgets one.
 */
async function custodianMidSettle(dbPath, logPath) {
  const round = new Round(openStore(dbPath), () => NOW + 1000);
  const rid = round.open(CONTRACT);
  const say = (line) => appendFileSync(logPath, line + '\n');
  const port = loggingPort(logPath);
  const entries = [];
  const bare = new Custody(round, { port, preimageFor });
  for (const n of PLAYERS) {
    const entry = entryFor(rid, n);
    round.enter(entry);
    await bare.hold(entry);
    entries.push(entry);
  }
  console.log('HELD ' + toHex(rid));

  const suicidal = new Custody(round, {
    preimageFor,
    port: {
      ...port,
      async settle(args) {
        say('settle ' + toHex(args.paymentHash));
        say('# lightning has the preimage and this node is about to die');
        process.kill(process.pid, 'SIGKILL');
      },
    },
  });
  const outcomes = [FORFEIT, FORFEIT, DELIVERED];
  await suicidal.settleHeldInvoices({
    roundId: rid, minScore: 1, finalFor: () => true,
    entries: entries.map((e, i) => ({
      entryId: entryIdOf(e), pubkey: e.playerPubkey, outcome: outcomes[i],
      score: outcomes[i] === DELIVERED ? 9 : 0, stakeMsat: e.stakeMsat,
      // 22A: the table asks for all three, and without them it refused the
      // whole close - so this child never reached its settle, before 9.4's
      // names too (measured on a clean copy of 70d35e1).
      feeMsat: e.feeMsat, donationMsat: e.donationMsat,
    })),
  });
  console.log('THE CHILD SURVIVED ITS OWN SETTLE');
  process.exit(4);
}

/** The child: signer node three players, hold three stakes, then run forever. */
async function custodian(dbPath, logPath) {
  const round = new Round(openStore(dbPath), () => NOW + 1000);
  const rid = round.open(CONTRACT);
  const custody = new Custody(round, { port: loggingPort(logPath), preimageFor });
  for (const n of PLAYERS) {
    const entry = entryFor(rid, n);
    round.enter(entry);
    const held = await custody.hold(entry);
    if (!held.ok) { console.error('the child could not hold a stake: ' + held.why); process.exit(3); }
  }
  console.log('HELD ' + toHex(rid));
  // The run is live. In a real daemon this is the http server and the batches
  // arriving; here it is simply a process that is not finished.
  setInterval(() => {}, 1000);
}

/**
 * Run one custodian child until it says it is holding stakes, then let the
 * caller finish it off - or, for the mid-settle child, wait for it to kill
 * itself. Either way it does not survive.
 */
function runChild(mode, dbPath, logPath, thenKill) {
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, mode, dbPath, logPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let seen = '', rid = null;
    const bail = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the child never held three stakes')); }, 30000);
    child.stdout.on('data', (d) => {
      seen += d;
      const m = /HELD ([0-9a-f]{64})/.exec(seen);
      if (m && !rid) {
        rid = Buffer.from(m[1], 'hex');
        if (thenKill) { child.rid = rid; thenKill(child); }
      }
      if (/THE CHILD SURVIVED ITS OWN SETTLE/.test(seen))
        reject(new Error('the mid-settle child was supposed to die inside a settle'));
    });
    child.on('exit', () => {
      clearTimeout(bail);
      if (rid) resolve(rid); else reject(new Error('the child exited before it held anything'));
    });
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'custody-crash-'));
  const dbPath = join(dir, 'node.db');
  const logPath = join(dir, 'lightning.log');
  const rid = await runChild('--child', dbPath, logPath, (child) => {
    console.log(`three stakes in flight, round ${toHex(child.rid)}, custodian pid ${child.pid}`);
    console.log('SIGKILL');
    child.kill('SIGKILL');
  });

  const problems = [];

  // 1. WHAT THE DEAD NODE LEFT ON DISK.
  const round = new Round(openStore(dbPath), () => NOW + 2000);
  const holds = round.holdsOf(new Uint8Array(rid));
  console.log(`\nholds the dead node left behind: ${holds.length}`);
  for (const h of holds) console.log(`  ${toHex(h.entryId).slice(0, 16)}  ${h.state}  ${h.amountMsat} msat`);
  if (holds.length !== PLAYERS.length) problems.push(`${holds.length} holds on disk, not ${PLAYERS.length}`);
  for (const h of holds)
    if (h.state !== HELD) problems.push(`a stake was ${h.state} when the node died, not ${HELD}`);

  // 2. EVERYTHING THE DEAD NODE EVER SAID TO LIGHTNING.
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  const acts = log.filter((l) => l.startsWith('settle ') || l.startsWith('cancel '));
  console.log(`\nlightning log: ${log.length} calls, of which ${acts.length} moved money`);
  for (const l of log) console.log('  ' + l);
  if (log.length !== PLAYERS.length) problems.push(`${log.length} port calls, not ${PLAYERS.length} createHeld`);
  if (acts.length) problems.push(`${acts.length} stakes moved before the node died: ${acts.join(', ')}`);

  // 3. AND THE NODE THAT COMES BACK. It has three stakes, three outcomes and
  // no FINAL result, which is what a restarted node actually has: the
  // committee's agreement is not in its own store.
  const back = new Custody(round, { port: loggingPort(logPath), preimageFor });
  const outcomes = [DELIVERED, FORFEIT, VOID];
  const out = await back.settleHeldInvoices({
    roundId: new Uint8Array(rid), minScore: 1,
    entries: PLAYERS.map((n, i) => {
      const e = entryFor(new Uint8Array(rid), n);
      return { entryId: entryIdOf(e), pubkey: e.playerPubkey, outcome: outcomes[i], score: i === 0 ? 9 : 0, stakeMsat: e.stakeMsat };
    }),
    finalFor: () => false,
  });
  const after = round.holdsOf(new Uint8Array(rid));
  const moved = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.startsWith('settle ') || l.startsWith('cancel '));
  console.log(`\nthe restarted node, with no final result: ${moved.length} stakes moved`);
  for (const a of out.actions) console.log(`  ${toHex(a.entryId).slice(0, 16)}  ${a.action} -> ${a.state}`);
  if (moved.length) problems.push(`the restarted node moved ${moved.length} stakes without a final result`);
  for (const h of after)
    if (h.state !== HELD && h.state !== 'EXPIRED')
      problems.push(`after the restart a stake was ${h.state}`);

  // ---- AND NOW THE HARD ONE. ----------------------------------------------
  //
  // Above, the node died before it had decided anything. Here it dies with
  // Lightning holding a preimage it has not written down. If the store's only
  // record is written AFTER the call, a restarted node reads HELD for a stake
  // that is already settled and settles it again.
  const dir2 = mkdtempSync(join(tmpdir(), 'custody-midsettle-'));
  const db2 = join(dir2, 'node.db');
  const log2 = join(dir2, 'lightning.log');
  const rid2 = await runChild('--child-mid-settle', db2, log2);
  console.log(`\nkilled inside the settle, round ${toHex(rid2)}`);

  const r2 = new Round(openStore(db2), () => NOW + 2000);
  const before = readFileSync(log2, 'utf8').trim().split('\n').filter(Boolean);
  const settled = before.filter((l) => l.startsWith('settle '));
  const stateOf = new Map(r2.holdsOf(new Uint8Array(rid2)).map((h) => [toHex(h.paymentHash), h.state]));
  console.log(`  lightning was told to settle ${settled.length} stake(s)`);
  for (const l of settled) console.log(`    ${l}  and this node's store says ${stateOf.get(l.split(' ')[1])}`);

  // 9.4's REQUESTED names (and the old ACTING label a store may still hold).
  const acting = r2.holdsOf(new Uint8Array(rid2)).filter((h) => MID_ACT.includes(h.state));
  console.log(`  stakes this node knows it was in the middle of acting on: ${acting.length}`);

  // THE RESTARTED NODE ASKS LIGHTNING FIRST, then runs the same close again,
  // which is what a daemon does when it comes back to a round whose result is
  // final.
  const c2 = new Custody(r2, { port: loggingPort(log2), preimageFor });
  const asked = await c2.reconcile({ roundId: new Uint8Array(rid2) });
  console.log(`  reconciled against Lightning: ${asked.asked.length}`);
  for (const a of asked.asked) console.log(`    ${toHex(a.entryId).slice(0, 16)}  ${a.state}`);
  if (acting.length !== settled.length)
    problems.push(`${acting.length} stakes recorded as in-flight acts, but ${settled.length} settle calls were made`);
  const outs = [FORFEIT, FORFEIT, DELIVERED];
  await c2.settleHeldInvoices({
    roundId: new Uint8Array(rid2), minScore: 1, finalFor: () => true,
    entries: PLAYERS.map((n, i) => {
      const e = entryFor(new Uint8Array(rid2), n);
      return { entryId: entryIdOf(e), pubkey: e.playerPubkey, outcome: outs[i],
        score: outs[i] === DELIVERED ? 9 : 0, stakeMsat: e.stakeMsat,
        feeMsat: e.feeMsat, donationMsat: e.donationMsat };
    }),
  });
  const twice = readFileSync(log2, 'utf8').trim().split('\n').filter(Boolean)
    .filter((l) => l.startsWith('settle '));

  const doubled = twice.filter((l, i) => twice.indexOf(l) !== i);
  console.log(`  after the restart: ${twice.length} settle call(s) in the whole log, ${doubled.length} repeated`);
  for (const d of new Set(doubled)) console.log(`    REPEATED  ${d}`);
  if (doubled.length)
    problems.push(`a restarted node settled ${new Set(doubled).size} stake(s) a second time`);
  const left = r2.holdsOf(new Uint8Array(rid2)).filter((h) => h.state === HELD);
  if (left.length) problems.push(`${left.length} stake(s) are still HELD after a final close`);

  console.log('');
  if (problems.length) {
    for (const p of problems) console.error('  ' + p);
    console.error(`custody crash: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('custody crash: the custodian died with three stakes in flight, nobody was paid,');
  console.log('and the node that came back moved nothing without a final result.');
  console.log(`scratch: ${dir}`);
}

if (process.argv[2] === '--child') await custodian(process.argv[3], process.argv[4]);
else if (process.argv[2] === '--child-mid-settle') await custodianMidSettle(process.argv[3], process.argv[4]);
else await main();
