// A CUSTODIAN KILLED INSIDE A SETTLE, RESTARTED THE WAY A REAL DAEMON STARTS.
//
// `custody-crash.mjs` kills a custodian against a fake port and restarts it
// in-process with that port handed back. This asks the question M3's finish
// line asks - "a node killed mid-settlement recovers to the right state on
// restart" - of the real `src/main.js`, on its own store and against a real
// lnd, with nothing handed over but what an operator can set.
//
// An isolated regtest of its own: bitcoind, two lnd v0.21.3-beta nodes (alice
// is the players' wallet, bob the daemon's custodian), a channel between them.
// Two stakes are held on bob and paid by alice; the round is final, one
// player delivered and one forfeited. A child process runs the close with
// bob's real port and is SIGKILLed inside the forfeit's settle:
//
//   --point=1   after ACTING is on disk, before `settleinvoice` leaves
//   --point=2   after lnd took `settleinvoice`, before SETTLED is written
//
// Then the store is started as `node src/main.js <port> <store>`, twice:
//
//   (a) with no Lightning settings - what every launch path did until now
//   (b) with BLWP_LNCLI, BLWP_LND_DIR, BLWP_LND_RPC and BLWP_LND_NETWORK
//
// and the forfeit's row is read against what lnd says. The right state is
// lnd's: HELD at point 1 (the act never left, and the next close makes it
// once), SETTLED at point 2 (it landed, and is never made twice).
//
// The preimage in the child is a stand-in for the committee's five of seven
// (as in `custody-lnd.mjs`): what is measured is the restart, not 23.4.
//
//   node packages/blwp-node/tools/custody-restart-lnd.mjs --point=1|2 [--keep]
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Custody, HELD, SETTLED, CANCELLED, ACTING } from '../src/custody.js';
import { lndPort } from '../src/lnd-port.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, '..', 'src', 'main.js');
const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const LND = process.env.LND_BIN || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta';
const LNCLI = join(LND, 'lncli');
const KEEP = process.argv.includes('--keep');
const POINT = Number(process.env.KILL_POINT
  || (process.argv.find((a) => a.startsWith('--point=')) || '--point=2').split('=')[1]);

// NON-DEFAULT, ALL OF THEM, and each point on its own so the two run side by side.
// bitcoind also binds p2p+1 for onion even with -listenonion=0: measured, a zmq
// port there stopped bitcoind at start ("Unable to bind to 127.0.0.1:29803").
const O = 20 * (POINT - 1);
const P = { rpc: 29801 + O, p2p: 29802 + O, zmqBlock: 29805 + O, zmqTx: 29806 + O,
  alice: { rpc: 29807 + O, listen: 29808 + O, rest: 29809 + O },
  bob: { rpc: 29810 + O, listen: 29811 + O, rest: 29812 + O },
  daemon: 18500 + POINT };

const STAKE_MSAT = 100000n;
const b32 = (n) => new Uint8Array(32).fill(n);
const preimageOf = (n) => b32(n + 60);
const NOW = Date.now();

const say = (s) => console.log(s);
const sh = (bin, args) => execFileSync(bin, args,
  { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const lncliFor = (dir, who) => [`--lnddir=${join(dir, who)}`,
  `--rpcserver=127.0.0.1:${P[who].rpc}`, '--network=regtest'];

async function until(what, check, ms = 120000, every = 1000) {
  const stop = Date.now() + ms;
  for (;;) {
    let got = null;
    try { got = await check(); } catch { got = null; }
    if (got) return got;
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---- THE CHILD: the close, with bob's real port, killed inside the settle. ----
if (process.argv.includes('--child')) {
  const dir = process.env.DIR;
  const round = new Round(openStore(join(dir, 'bob-node.db')));
  const real = lndPort({ lncli: LNCLI, args: lncliFor(dir, 'bob') });
  const port = {
    ...real,
    async settle(a) {
      if (POINT === 1) process.kill(process.pid, 'SIGKILL');
      await real.settle(a);
      if (POINT === 2) process.kill(process.pid, 'SIGKILL');
    },
  };
  const entries = JSON.parse(process.env.ENTRIES).map((e) => ({
    entryId: fromHex(e.id), pubkey: fromHex(e.pubkey), outcome: e.outcome,
    score: e.score, stakeMsat: BigInt(e.stakeMsat), feeMsat: BigInt(e.feeMsat), donationMsat: 0n,
    preimage: fromHex(e.preimage),
  }));
  const custody = new Custody(round, {
    port, preimageFor: (id) => entries.find((e) => toHex(e.entryId) === toHex(id)).preimage,
  });
  await custody.settleHeldInvoices({
    roundId: fromHex(process.env.RID), minScore: 1, finalFor: () => true, entries,
  });
  console.log('the close finished without being killed');
  process.exit(3);
}

/** Start the real launcher on the store, let it do what it does on start, stop it. */
async function startMain(dir, env, tag) {
  const out = [];
  const child = spawn(process.execPath, [MAIN, String(P.daemon), join(dir, 'bob-node.db')],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(String(d)));
  child.stderr.on('data', (d) => out.push(String(d)));
  const text = () => out.join('');
  await until(`${tag} to listen`, () => /blwp-node on/.test(text()) || child.exitCode !== null, 60000, 200);
  // The start-up reconcile is a promise the launcher does not await; give it
  // the time an lncli round trip takes, and stop as soon as it says something.
  await until(`${tag} to reconcile`, () => /\[custody\]/.test(text()), 15000, 200).catch(() => null);
  child.kill('SIGTERM');
  await until(`${tag} to stop`, () => child.exitCode !== null || child.signalCode !== null, 15000, 200)
    .catch(() => child.kill('SIGKILL'));
  return text().trim().split('\n').map((l) => `      | ${l}`).join('\n');
}

async function main() {
  const dir = process.env.LNDRT || mkdtempSync(join(tmpdir(), `custody-restart-${POINT}-`));
  for (const d of ['btc', 'alice', 'bob']) mkdirSync(join(dir, d), { recursive: true });
  say(`kill point ${POINT}, an isolated regtest of its own: ${dir}`);
  const running = [];
  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
  const cli = (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, ...a]).trim();
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  const ln = (who, ...a) => sh(LNCLI, [...lncliFor(dir, who), ...a]);
  const lnj = (who, ...a) => JSON.parse(ln(who, ...a));
  const problems = [];

  try {
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgs, `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex',
      `-zmqpubrawblock=tcp://127.0.0.1:${P.zmqBlock}`, `-zmqpubrawtx=tcp://127.0.0.1:${P.zmqTx}`,
      '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'blwp'); } catch { cli('loadwallet', 'blwp'); }
    const addr = cli('getnewaddress');
    const mine = (n) => cli('generatetoaddress', String(n), addr);
    mine(250);

    for (const who of ['alice', 'bob']) {
      running.push(spawn(join(LND, 'lnd'), [`--lnddir=${join(dir, who)}`,
        '--bitcoin.regtest', '--bitcoin.node=bitcoind',
        `--bitcoind.rpchost=127.0.0.1:${P.rpc}`, `--bitcoind.rpccookie=${cookie}`,
        `--bitcoind.zmqpubrawblock=tcp://127.0.0.1:${P.zmqBlock}`,
        `--bitcoind.zmqpubrawtx=tcp://127.0.0.1:${P.zmqTx}`,
        `--rpclisten=127.0.0.1:${P[who].rpc}`, `--listen=127.0.0.1:${P[who].listen}`,
        `--restlisten=127.0.0.1:${P[who].rest}`,
        '--noseedbackup', '--nobootstrap', `--alias=${who}`], { stdio: 'ignore' }));
    }
    for (const who of ['alice', 'bob'])
      await until(`${who} to sync`, () => lnj(who, 'getinfo').synced_to_chain);
    const bobKey = lnj('bob', 'getinfo').identity_pubkey;
    cli('sendtoaddress', lnj('alice', 'newaddress', 'p2tr').address, '5');
    mine(6);
    await until('alice to see her coins', () => BigInt(lnj('alice', 'walletbalance').confirmed_balance) > 0n);
    ln('alice', 'connect', `${bobKey}@127.0.0.1:${P.bob.listen}`);
    ln('alice', 'openchannel', `--node_key=${bobKey}`, '--local_amt=2000000', '--push_amt=1000000');
    mine(6);
    await until('the channel', () => (lnj('alice', 'listchannels').channels || []).find((c) => c.active));
    const bobMsat = () => BigInt((lnj('bob', 'listchannels').channels[0] || {}).local_balance || 0) * 1000n;

    // ---- TWO STAKES HELD ON BOB, PAID BY ALICE. ----
    const db = openStore(join(dir, 'bob-node.db'));
    const round = new Round(db, () => NOW);
    const contract = {
      networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 6,
      gameVerifySlots: 2, settlementSlots: 2, simCoreHash: b32(1),
      committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
      startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
      objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
      slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
      censusRoot: b32(2), stakeMsat: STAKE_MSAT, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
      exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
      nodes: [b32(8), b32(9)],
    };
    const rid = round.open(contract);
    const port = lndPort({ lncli: LNCLI, args: lncliFor(dir, 'bob') });
    const custody = new Custody(round, { port });
    const dbB = openStore(join(dir, 'second-node.db'));
    const roundB = new Round(dbB, () => NOW);
    roundB.open(contract);
    const custodyB = new Custody(roundB, { port });
    const players = [
      { n: 1, outcome: DELIVERED, score: 9 },
      { n: 2, outcome: FORFEIT, score: 0 },
    ];
    for (const p of players) {
      p.entry = {
        roundId: rid, playerPubkey: b32(p.n), sessionPubkey: b32(p.n + 40),
        stakeCommitment: sha256(preimageOf(p.n)),
        stakeMsat: STAKE_MSAT, feeMsat: entryFeeMsat(STAKE_MSAT), donationMsat: 0n, joinTick: 0,
        worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
      };
      const entered = round.enter(p.entry);
      if (entered && entered.ok === false) throw new Error(`the door refused an entry: ${entered.why}`);
      roundB.enter(p.entry);
      const held = await custody.hold(p.entry);
      if (!held.ok) throw new Error(`bob could not hold a stake: ${held.why}`);
      p.id = entryIdOf(p.entry);
      // A SECOND DAEMON ON THE SAME ENDPOINT. §23.1: "the settlement
      // committee's Lightning endpoint issues a hold invoice" - one endpoint,
      // several daemons, and the client posts the entry to every one of them.
      const heldB = await custodyB.hold(p.entry);
      say(`  a second daemon on bob's endpoint holds the same entry: `
        + `${heldB.ok ? `${heldB.state}, ${heldB.invoice === held.invoice ? 'the same invoice' : 'A DIFFERENT INVOICE'}` : heldB.why}`);
      if (!heldB.ok) problems.push(`a second daemon on the committee's one endpoint could not hold the stake: ${heldB.why}`);
      else if (heldB.invoice !== held.invoice) problems.push('the second daemon holds a different invoice for the same hash');
      // NOT YET PAID, so not yet seen held (23.1 step 5): play would be refused.
      const early = await custody.seenPaid(p.id);
      say(`  before alice pays, seen held: ${early.ok ? `YES (${early.paidMsat} msat)` : early.why}`);
      if (early.ok) problems.push('a stake nobody has paid was seen held');
      p.pay = new Promise((resolve) => execFile(LNCLI,
        [...lncliFor(dir, 'alice'), 'payinvoice', '--force', '--timeout', '600s', held.invoice],
        { maxBuffer: 8 << 20 }, (err, o) => resolve((o || '') + (err ? err.message : ''))));
      p.pay.then((t) => { p.payText = t; });
    }
    for (const p of players)
      await until('a payment to arrive', async () => {
        const seen = await port.look({ paymentHash: p.entry.stakeCommitment });
        return seen.paidMsat > 0n && seen.paidMsat === seen.amountMsat;
      }).catch((err) => {
        // WHAT ALICE'S WALLET SAID, not only that the money never came.
        throw new Error(`${err.message}; payinvoice: ${(p.payText || 'still running').trim().slice(-300)}`);
      });
    for (const p of players) {
      const seen = await custody.seenPaid(p.id);
      say(`  after alice paid, seen held: ${seen.ok ? `${seen.state}, ${seen.paidMsat} msat` : seen.why}`);
      if (!seen.ok) problems.push(`a paid, held stake was not seen: ${seen.why}`);
    }
    const bobBefore = bobMsat();
    try { db.close(); } catch { /* node:sqlite */ }
    const forfeit = players[1];
    const lndSays = async () => (await port.look({ paymentHash: forfeit.entry.stakeCommitment })).state;
    const rowOf = () => {
      const d = openStore(join(dir, 'bob-node.db'));
      const r = new Round(d).hold(forfeit.id);
      try { d.close(); } catch { /* node:sqlite */ }
      return r ? r.state : 'none';
    };
    say(`two stakes held on bob and paid by alice; bob's balance ${bobBefore} msat`);

    // ---- THE KILL. ----
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
      env: { ...process.env, DIR: dir, KILL_POINT: String(POINT), RID: toHex(rid),
        ENTRIES: JSON.stringify(players.map((p) => ({
          id: toHex(p.id), pubkey: toHex(p.entry.playerPubkey), outcome: p.outcome, score: p.score,
          stakeMsat: String(STAKE_MSAT), feeMsat: String(p.entry.feeMsat), preimage: toHex(preimageOf(p.n)),
        }))) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const died = await new Promise((r) => child.on('exit', (code, sig) => r(sig || `exit ${code}`)));
    const expected = POINT === 1 ? HELD : SETTLED;
    say(`the close, killed at point ${POINT}: ${died}`);
    say(`  the forfeit: this node's row ${rowOf()}, lnd says ${await lndSays()}`);
    if (died !== 'SIGKILL') problems.push(`the child was not killed where it was meant to be: ${died}`);
    if (rowOf() !== ACTING) problems.push(`the killed node's row says ${rowOf()}, not ACTING`);
    if (await lndSays() !== expected) problems.push(`lnd says ${await lndSays()} after the kill, not ${expected}`);

    // ---- RESTART (a): the real launcher, as every launch path started it. ----
    say('\nRESTART (a), `src/main.js <port> <store>`, no Lightning settings:');
    say(await startMain(dir, {}, 'restart (a)'));
    const rowA = rowOf();
    say(`  the forfeit: this node's row ${rowA}, lnd says ${await lndSays()}`);

    // ---- RESTART (b): the same, told where its lnd is. ----
    const lightningEnv = {
      BLWP_LNCLI: LNCLI, BLWP_LND_DIR: join(dir, 'bob'),
      BLWP_LND_RPC: `127.0.0.1:${P.bob.rpc}`, BLWP_LND_NETWORK: 'regtest',
    };
    say('\nRESTART (b), the same, with BLWP_LNCLI, BLWP_LND_DIR, BLWP_LND_RPC, BLWP_LND_NETWORK:');
    say(await startMain(dir, lightningEnv, 'restart (b)'));
    const rowB = rowOf();
    say(`  the forfeit: this node's row ${rowB}, lnd says ${await lndSays()}`);
    if (rowB !== expected) problems.push(`restarted with its lnd, the row says ${rowB}, not lnd's ${expected}`);

    // ---- AND THE NEXT CLOSE MAKES A HELD ACT EXACTLY ONCE. ----
    if (rowB === HELD) {
      const d = openStore(join(dir, 'bob-node.db'));
      const again = new Custody(new Round(d), { port, preimageFor: () => preimageOf(forfeit.n) });
      const out = await again.settleHeldInvoices({
        roundId: rid, minScore: 1, finalFor: () => true,
        entries: players.map((p) => ({ entryId: p.id, pubkey: p.entry.playerPubkey,
          outcome: p.outcome, score: p.score, stakeMsat: STAKE_MSAT,
          feeMsat: p.entry.feeMsat, donationMsat: 0n })),
      });
      try { d.close(); } catch { /* node:sqlite */ }
      say(`\nthe next close: ${out.ok ? out.actions.map((a) => a.state).join(', ') : out.why}`);
    }
    if (await lndSays() === SETTLED)
      await until('the settled stake in bob\'s balance', () => bobMsat() > bobBefore, 30000).catch(() => null);
    const gained = bobMsat() - bobBefore;
    const net = forfeit.entry.stakeMsat - forfeit.entry.feeMsat;
    say(`bob gained ${gained} msat; one forfeited net stake is ${net}; the forfeit's row ${rowOf()}, lnd ${await lndSays()}`);
    if (gained !== net) problems.push(`bob gained ${gained} msat, not one net stake of ${net}`);
    if (rowOf() !== SETTLED || await lndSays() !== SETTLED) problems.push('the forfeit did not end SETTLED on both sides');
    const winner = (await port.look({ paymentHash: players[0].entry.stakeCommitment })).state;
    if (winner !== CANCELLED) problems.push(`the delivered stake is ${winner} at lnd, not CANCELLED`);
  } catch (err) {
    // A RUN THAT STOPPED IS NOT A RUN WITH NO PROBLEMS.
    problems.push(`the run stopped: ${err.message}`);
  } finally {
    say('');
    if (problems.length) {
      for (const p of problems) console.error(`  ${p}`);
      console.error(`${problems.length} problem(s)`);
      process.exitCode = 1;
    } else say('no problems');
    if (!KEEP) {
      for (const p of running) { try { p.kill('SIGTERM'); } catch { /* gone */ } }
      await new Promise((r) => setTimeout(r, 3000));
      for (const p of running) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      try { sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, 'stop']); } catch { /* gone */ }
    } else say(`left running, --keep: ${dir}`);
  }
}

await main();
