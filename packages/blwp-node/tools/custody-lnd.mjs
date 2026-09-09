// 23.1 AND 23.2 AGAINST A REAL LIGHTNING NODE.
//
// Everything the rules say has been measured against a fake port with nothing
// running. This runs the same `Custody` against `lnd v0.21.3-beta` on an
// ISOLATED regtest of its own - its own bitcoind, its own datadir, its own
// non-default ports, cookie auth - and stops all of it when the numbers are
// in. It touches no mainnet and no testnet datadir. The coins are worthless.
//
// WHY THERE ARE TWO LND NODES. A hold invoice cannot be settled until somebody
// has paid it, and "paid but not settled" is the whole state the chapter is
// about. Alice is the player's wallet; Bob is the daemon's custodian. Alice's
// three payments sit in flight while Bob decides what the core's outcome word
// means for each of them.
//
// WHAT IS MEASURED, in millisatoshi across a real channel:
//
//   FORFEIT    Bob releases the preimage      the stake moves to Bob
//   DELIVERED  Bob cancels                    Alice's payment fails, money back
//   VOID       BOB DOES NOTHING AT ALL        the HTLC times out and the
//                                             money goes back to Alice
//
// The third is the one worth the wait: an operator who walks away must not be
// able to keep a player's stake. What actually refunds her was measured rather
// than assumed - an invoice expiry stops applying once an HTLC is accepted, so
// the refund comes from BITCOIN'S timelock, in blocks, which is why this tool
// mines rather than sleeps.
//
// SINGLE-NODE CUSTODY, NOT §23.5. Bob is one node holding everyone's money.
//
//   node packages/blwp-node/tools/custody-lnd.mjs [--keep]
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Custody, HELD, SETTLED, CANCELLED, EXPIRED } from '../src/custody.js';
import { lndPort } from '../src/lnd-port.js';
import { DELIVERED, FORFEIT, VOID } from '../../protocol/src/payout.js';
import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const LND = process.env.LND_BIN || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta';
const KEEP = process.argv.includes('--keep');

// NON-DEFAULT, ALL OF THEM. bitcoind also binds port+1 for onion unless told
// not to, which is why the zmq pair is nowhere near the p2p port.
const P = { rpc: 29643, p2p: 29644, zmqBlock: 29745, zmqTx: 29746,
  alice: { rpc: 29650, listen: 29651, rest: 29652 },
  bob: { rpc: 29660, listen: 29661, rest: 29662 } };

const STAKE_MSAT = 100000n;
const EXPIRY_SECONDS = 90;
const b32 = (n) => new Uint8Array(32).fill(n);
const preimageOf = (n) => b32(n + 60);
const NOW = Date.now();

const say = (s) => console.log(s);
const sh = (bin, args) => execFileSync(bin, args,
  { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

/** Poll until a thing is true or a deadline passes. Never a file mtime. */
async function until(what, check, ms = 120000, every = 2000) {
  const stop = Date.now() + ms;
  for (;;) {
    let got = null;
    try { got = await check(); } catch { got = null; }
    if (got) return got;
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    await new Promise((r) => setTimeout(r, every));
  }
}

async function main() {
  const dir = process.env.LNDRT || mkdtempSync(join(tmpdir(), 'custody-lnd-'));
  mkdirSync(join(dir, 'btc'), { recursive: true });
  mkdirSync(join(dir, 'alice'), { recursive: true });
  mkdirSync(join(dir, 'bob'), { recursive: true });
  say(`an isolated regtest of its own: ${dir}`);
  const running = [];

  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
  const cli = (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, ...a]).trim();
  const cookie = join(dir, 'btc', 'regtest', '.cookie');

  try {
    // ---- 1. THE CHAIN. Cookie auth, no listenonion, its own everything. ----
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgs, `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex',
      `-zmqpubrawblock=tcp://127.0.0.1:${P.zmqBlock}`, `-zmqpubrawtx=tcp://127.0.0.1:${P.zmqTx}`,
      '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'blwp'); } catch { cli('loadwallet', 'blwp'); }
    const addr = cli('getnewaddress');
    const mine = (n) => cli('generatetoaddress', String(n), addr);
    if (Number(cli('getblockcount')) < 250) mine(250 - Number(cli('getblockcount')));
    say(`bitcoind at height ${cli('getblockcount')}, rpc ${P.rpc}, cookie auth`);

    // ---- 2. TWO LIGHTNING NODES. ----
    const lncliFor = (who) => [`--lnddir=${join(dir, who)}`,
      `--rpcserver=127.0.0.1:${P[who].rpc}`, '--network=regtest'];
    const ln = (who, ...a) => sh(join(LND, 'lncli'), [...lncliFor(who), ...a]);
    const lnj = (who, ...a) => JSON.parse(ln(who, ...a));

    for (const who of ['alice', 'bob']) {
      const p = spawn(join(LND, 'lnd'), [`--lnddir=${join(dir, who)}`,
        '--bitcoin.regtest', '--bitcoin.node=bitcoind',
        `--bitcoind.rpchost=127.0.0.1:${P.rpc}`, `--bitcoind.rpccookie=${cookie}`,
        `--bitcoind.zmqpubrawblock=tcp://127.0.0.1:${P.zmqBlock}`,
        `--bitcoind.zmqpubrawtx=tcp://127.0.0.1:${P.zmqTx}`,
        `--rpclisten=127.0.0.1:${P[who].rpc}`, `--listen=127.0.0.1:${P[who].listen}`,
        `--restlisten=127.0.0.1:${P[who].rest}`,
        '--noseedbackup', '--nobootstrap', `--alias=${who}`], { stdio: 'ignore' });
      running.push(p);
    }
    for (const who of ['alice', 'bob'])
      await until(`${who} to sync to the chain`, () => lnj(who, 'getinfo').synced_to_chain);
    const bobKey = lnj('bob', 'getinfo').identity_pubkey;
    say(`lnd ${sh(join(LND, 'lnd'), ['--version']).trim().split(' ')[2]}: alice on ${P.alice.rpc}, bob on ${P.bob.rpc}`);

    // ---- 3. A CHANNEL WITH REAL (WORTHLESS) COINS IN IT. ----
    cli('sendtoaddress', lnj('alice', 'newaddress', 'p2tr').address, '5');
    mine(6);
    await until('alice to see her coins', () => BigInt(lnj('alice', 'walletbalance').confirmed_balance) > 0n);
    ln('alice', 'connect', `${bobKey}@127.0.0.1:${P.bob.listen}`);
    ln('alice', 'openchannel', `--node_key=${bobKey}`, '--local_amt=2000000', '--push_amt=1000000');
    mine(6);
    const channel = await until('the channel to come up',
      () => (lnj('alice', 'listchannels').channels || []).find((c) => c.active));
    const aliceMsat = () => BigInt((lnj('alice', 'listchannels').channels[0] || {}).local_balance || 0) * 1000n;
    const bobMsat = () => BigInt((lnj('bob', 'listchannels').channels[0] || {}).local_balance || 0) * 1000n;
    say(`channel ${channel.chan_id} active: alice ${aliceMsat()} msat, bob ${bobMsat()} msat`);

    // ---- 4. THREE ENTRIES, AND BOB'S CUSTODY OVER THEM. ----
    const round = new Round(openStore(join(dir, 'bob-node.db')), () => NOW);
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

    const port = lndPort({ lncli: join(LND, 'lncli'), args: lncliFor('bob'), expirySeconds: EXPIRY_SECONDS });
    const custody = new Custody(round, {
      port,
      // The committee's reconstructed shares, stood in for: see 23.4. What a
      // settle needs is the 32 bytes, and this slice does not reconstruct them.
      preimageFor: (id, e) => preimageOf(e.pubkey[0]),
    });

    const players = [
      { n: 1, name: 'winner ', outcome: DELIVERED, score: 9 },
      { n: 2, name: 'loser  ', outcome: FORFEIT, score: 0 },
      { n: 3, name: 'voided ', outcome: VOID, score: 0 },
    ];
    for (const p of players) {
      p.entry = {
        roundId: rid, playerPubkey: b32(p.n), sessionPubkey: b32(p.n + 40),
        stakeCommitment: sha256(preimageOf(p.n)),
        stakeMsat: STAKE_MSAT, feeMsat: entryFeeMsat(STAKE_MSAT), donationMsat: 0n, joinTick: 0,
        worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
      };
      round.enter(p.entry);
      const held = await custody.hold(p.entry);
      if (!held.ok) throw new Error(`bob could not hold ${p.name.trim()}'s stake: ${held.why}`);
      p.request = held.invoice;
      p.id = entryIdOf(p.entry);
      say(`  ${p.name} hold invoice for ${toHex(p.entry.stakeCommitment).slice(0, 16)}...  ${STAKE_MSAT} msat`);
    }

    // ---- 5. ALICE PAYS. The payments stay in flight; that is the point. ----
    const before = { alice: aliceMsat(), bob: bobMsat() };
    for (const p of players)
      p.pay = new Promise((resolve) => execFile(join(LND, 'lncli'),
        [...lncliFor('alice'), 'payinvoice', '--force', '--timeout', '600s', p.request],
        { maxBuffer: 8 << 20 }, (err, out) => resolve(((out || '') + (err ? err.message : '')))));
    for (const p of players)
      await until(`${p.name.trim()}'s payment to arrive`,
        async () => (await port.look({ paymentHash: p.entry.stakeCommitment })).paidMsat === STAKE_MSAT);
    say(`\nthree stakes in flight: alice ${before.alice} -> ${aliceMsat()} msat`);
    for (const p of players)
      say(`  ${p.name} lnd says ${JSON.parse(ln('bob', 'lookupinvoice', toHex(p.entry.stakeCommitment))).state}`
        + `, this node says ${custody.stateOf(p.id).state}`);

    // ---- 6. THE CORE'S OUTCOME WORD, AND WHAT BOB DOES ABOUT IT. ----
    const out = await custody.settleHeldInvoices({
      roundId: rid, minScore: 1, finalFor: () => true,
      entries: players.map((p) => ({ entryId: p.id, pubkey: p.entry.playerPubkey,
        outcome: p.outcome, score: p.score, stakeMsat: STAKE_MSAT })),
    });
    if (!out.ok) throw new Error(out.why);
    say('\nthe round is final, and bob acts:');
    for (const p of players) {
      const mine2 = out.actions.find((a) => toHex(a.entryId) === toHex(p.id));
      say(`  ${p.name} ${p.outcome.padEnd(10)} -> ${mine2.action.padEnd(8)} -> ${mine2.state}`);
    }

    await until('the settled stake to land in bob\'s balance', () => bobMsat() >= before.bob + STAKE_MSAT);
    await until('the cancelled payment to fail back', async () =>
      (await port.look({ paymentHash: players[0].entry.stakeCommitment })).state === CANCELLED);
    say(`\nafter the acts: alice ${aliceMsat()} msat, bob ${bobMsat()} msat`);
    say(`  the pool gained ${bobMsat() - before.bob} msat, which is one forfeited stake`);

    // ---- 7. AND THE ONE NOBODY TOUCHED. ----
    //
    // Bob issued no command for the void stake. It is still ACCEPTED - still
    // in flight, still in nobody's balance - and the only thing that will move
    // it is the timelock.
    //
    // MEASURED, AND NOT WHAT THIS TOOL FIRST ASSUMED. An invoice expiry is a
    // wall clock and it stops mattering the moment an HTLC is accepted: 150
    // seconds past a 90-second expiry, lnd still said the stake was held. What
    // refunds a player when nobody acts is BITCOIN'S timelock, in blocks, and
    // that is the honest reading of 23.2 - "the HTLC expires and the wallet is
    // refunded automatically" is a consensus rule, not a courtesy.
    const voided = players[2];
    const seenNow = await port.look({ paymentHash: voided.entry.stakeCommitment });
    const htlc = JSON.parse(ln('bob', 'lookupinvoice', toHex(voided.entry.stakeCommitment))).htlcs[0];
    const startHeight = Number(cli('getblockcount'));
    say(`\nthe void stake, which bob was told to leave alone: lnd says ${seenNow.state}, `
      + `${seenNow.paidMsat} msat paid`);
    say(`  its HTLC expires at height ${htlc.expiry_height}, and the chain is at ${startHeight}`);
    say('  nobody acts. the chain moves.');

    const back = await until('the void stake to time out', async () => {
      const seen = await port.look({ paymentHash: voided.entry.stakeCommitment });
      if (seen.state === CANCELLED) return seen;
      if (Number(cli('getblockcount')) < htlc.expiry_height + 10) mine(10);
      return null;
    }, 240000, 3000);
    const text = await voided.pay;
    say(`  at height ${cli('getblockcount')} lnd says ${back.state}; alice's payment `
      + `${/SUCCEEDED/.test(text) ? 'SUCCEEDED' : 'FAILED'}, and her balance is ${aliceMsat()} msat`);
    say(`  this node's own row still says ${custody.stateOf(voided.id).state}, because that is `
      + 'what it decided; lnd has no word for a hold that timed out and calls it CANCELED');

    // ---- WHAT THE NUMBERS HAVE TO BE. ----
    const problems = [];
    const gained = bobMsat() - before.bob;
    if (gained !== STAKE_MSAT) problems.push(`the pool gained ${gained} msat, not one stake of ${STAKE_MSAT}`);
    if (custody.stateOf(players[0].id).state !== CANCELLED) problems.push('the delivered stake did not come back');
    if (custody.stateOf(players[1].id).state !== SETTLED) problems.push('the forfeited stake did not enter the pool');
    if (custody.stateOf(players[2].id).state !== EXPIRED) problems.push('the void stake was acted on');
    if (aliceMsat() + gained !== before.alice) problems.push(
      `alice is ${before.alice - aliceMsat()} msat down but the pool only gained ${gained}: somebody is keeping the difference`);

    say('');
    if (problems.length) {
      for (const p of problems) console.error('  ' + p);
      console.error(`custody on lnd: ${problems.length} problem(s)`);
      process.exitCode = 1;
    } else {
      say('custody on lnd: one stake settled, one cancelled, and one refunded by nobody doing anything.');
      say('every millisatoshi alice is down is in the pool.');
    }
  } finally {
    if (KEEP) { say(`\nleft running, --keep: ${dir}`); return; }
    say('\nstopping everything.');
    for (const p of running) { try { p.kill('SIGTERM'); } catch { /* already gone */ } }
    await new Promise((r) => setTimeout(r, 3000));
    for (const p of running) { try { p.kill('SIGKILL'); } catch { /* already gone */ } }
    try { sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, 'stop']); } catch { /* not running */ }
    say('bitcoind and both lnd nodes are stopped. No testnet or mainnet datadir was touched.');
  }
}

await main();
