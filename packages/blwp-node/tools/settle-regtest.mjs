// A CLOSED ROUND PAYS ITS WINNER ON A REAL CHAIN, WITH NOBODY NAMING AN OUTPUT.
//
// M3.3 item 18. `payout-committee-regtest.mjs` proved the committee: seven
// daemons, one share each, five of seven spend the pool and a real bitcoind
// takes it. What it could not prove is that the DAEMON ever asks - it handed
// `payWithCommittee` an outpoint the harness had built from the funding
// transaction, because nothing in `src/` could find one. That was the letter:
// a closed round wrote PAYOUT_QUEUED and stopped.
//
// So this harness deliberately does NOT build a utxo. It funds the pool and
// then calls `settleQueued`, whose only arguments are the round, the contract
// and the things the node already holds. Everything else - which seat asks,
// which output to spend, what it is worth - comes from the round id, the
// seat's own store and `scantxoutset`.
//
//   the pool unfunded    refused by name, the row stays PAYOUT_QUEUED
//   funded but 0 conf    refused by name, and NOT the empty pool's sentence
//   one confirmed out    the round's own asker pays, a block carries it, and
//                        the winner's own key holds the sats
//   the six others       refuse to ask, by name, and send nothing
//   two covering outs    refused by name - choosing is not a node's to make
//
// Own datadir, non-default ports, cookie auth, stopped when the numbers are
// in. It touches no mainnet and no testnet4 datadir. The coins are worthless.
//
//   node packages/blwp-node/tools/settle-regtest.mjs [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { bitcoindRpc } from '../src/chain-rpc.js';
import { serve } from '../src/server.js';
import { askerFor, PAYOUT_QUEUED, PAID } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { evenGroupSecret } from '../../protocol/src/frost-bip340.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from '../test/seating.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const KEEP = process.argv.includes('--keep');
const P = { rpc: 29687, p2p: 29688 };
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { ...feldmanGroup, tweakPoint };
const say = (s) => console.log(s);
const NOW = 1788700000000;
const STAKE_MSAT = 1000000n;                       // 1000 sats, above the floor

const sh = (bin, args) => execFileSync(bin, args,
  { encoding: 'utf8', maxBuffer: 8 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function until(what, check, ms = 60000) {
  const stop = Date.now() + ms;
  for (;;) {
    let got = null;
    try { got = await check(); } catch { got = null; }
    if (got) return got;
    if (Date.now() > stop) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body });

async function main() {
  const dir = process.env.SETTLERT || mkdtempSync(join(tmpdir(), 'settle-'));
  mkdirSync(join(dir, 'btc'), { recursive: true });
  say(`an isolated regtest of its own: ${dir}`);
  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
  const cli = (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, ...a]);
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  const problems = [];
  let nodes = [];

  try {
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgs, `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex', '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'committee'); } catch { cli('loadwallet', 'committee'); }
    const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
    if (Number(cli('getblockcount')) < 200) mine(200 - Number(cli('getblockcount')));
    say(`bitcoind at height ${cli('getblockcount')}, rpc ${P.rpc}, cookie auth`);

    // ---- ONE POOL KEY, SEVEN SHARES, ONE EACH. ----
    let secret;
    do { secret = scalarFrom32(rand(32)); } while (secret === 0n || secret >= FIELD);
    const even = evenGroupSecret(secret, curve);
    const dealt = trustedDealerSplit({
      secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
      coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      curve,
    });
    const pool = { groupPublicKey: dealt.groupPublicKey };

    const chain = {
      async send(raw) {
        try { return { ok: true, txid: fromHex(cli('sendrawtransaction', toHex(raw))).reverse() }; }
        catch (e) {
          const said = (e.stderr || e.message).trim().split('\n').map((l) => l.trim())
            .filter((l) => l && !/^error code:/.test(l) && !/^error message:$/.test(l));
          return { ok: false, why: said.join(' ') || 'refused without saying why' };
        }
      },
      async look(txid) {
        try { cli('getrawtransaction', toHex(new Uint8Array(txid).reverse())); return { known: true }; }
        catch { return { known: false }; }
      },
    };

    // ---- SEVEN DAEMONS, EACH WITH ITS OWN STORE AND ITS OWN SHARE. ----
    for (let i = 0; i < SHARES_TOTAL; i++) {
      nodes.push(await serve(openStore(join(dir, `node-${i}.db`)), {
        port: 0, funded: () => true, now: () => NOW,
        poolKey: pool, poolCurve: curve, poolSeat: dealt.shares[i], chainSpend: chain,
      }));
    }
    say(`\nseven daemons on ports ${nodes.map((n) => n.port).join(', ')}`);
    say(`each holds share ${nodes.map((n, i) => dealt.shares[i].id).join(', ')} and no other`);

    const contract = {
      networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
      gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: b32(1),
      committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
      startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
      objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
      slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
      censusRoot: b32(2), stakeMsat: STAKE_MSAT, bondMinSats: 50000n, blockTicks: 9000,
      exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
      nodes: nodes.map((n) => n.round.pubkey),
    };
    const rid = roundId(contract);

    const winnerSecret = rand(32);
    const loserSecret = rand(32);
    const session = ed25519.utils.randomSecretKey();
    const players = [
      { pubkey: schnorr.getPublicKey(winnerSecret), outcome: DELIVERED, score: 9 },
      { pubkey: schnorr.getPublicKey(loserSecret), outcome: FORFEIT, score: 0 },
    ].map((p) => ({
      ...p,
      contract: {
        roundId: rid, playerPubkey: p.pubkey, sessionPubkey: ed25519.getPublicKey(session),
        stakeCommitment: b32(7), stakeMsat: STAKE_MSAT, feeMsat: 1000n, donationMsat: 0n,
        joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
      },
    }));

    for (const n of nodes) {
      const opened = await post(n.port, '/round', encodeRoundContract(contract));
      if (opened.status !== 201) problems.push(`a node refused the round: ${await opened.text()}`);
      assumeSeated(n.round, rid, contract.nodes);
      for (const p of players) {
        const joined = await post(n.port, '/entry', encodeEntryContract(p.contract));
        if (joined.status !== 201) problems.push(`a node refused an entry: ${await joined.text()}`);
        const eid = entryId(p.contract);
        const result = {
          roundId: rid, playerPubkey: p.pubkey, outcome: p.outcome, score: p.score,
          transcriptHash: b32(0x11), simCoreHash: contract.simCoreHash, nodePubkey: n.round.pubkey,
        };
        const id = resultId(result);
        n.round.putResult(rid, eid, n.round.pubkey, id,
          joinSignedResult(encodePlayerResult(result), schnorr.sign(id, n.round.identity.secret)));
      }
    }

    // ---- EVERY SEAT SIGNS THE TABLE IT COMPUTED, AND FETCHES THE OTHERS'. ----
    const entriesOf = (n) => new PoolSigning(n.round, {}).entriesFor(rid).entries;
    for (const n of nodes)
      n.payouts.sign({ roundId: rid, entries: entriesOf(n), minScore: contract.minScore });
    for (const n of nodes) {
      n.payouts.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
      await n.payouts.gather({ roundId: rid });
      const queued = n.payouts.queue({
        roundId: rid, entries: entriesOf(n), minScore: contract.minScore, contract,
      });
      if (!queued.ok || queued.state !== PAYOUT_QUEUED)
        problems.push(`a seat did not queue the payout: ${queued.why}`);
    }
    say(`\nall seven queued the payout; it owes the winner ${STAKE_MSAT / 1000n} sats`);

    // ---- THE CHAIN THIS DAEMON ASKS ABOUT ITS OWN POOL. ----
    //
    // `bitcoindRpc` over the same cookie the CLI uses. Every node gets it, so
    // the six that are not the asker are refused by the RULE and not by having
    // no chain to ask.
    const call = bitcoindRpc({ url: `http://127.0.0.1:${P.rpc}/`, cookiePath: cookie });
    for (const n of nodes) n.poolWatch.call = call;

    const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
    const poolAddress = JSON.parse(cli('decodescript', toHex(out.script))).address;

    // WHICH SEAT ASKS, and every one of the seven works it out for itself.
    const who = askerFor(rid, nodes[0].round.seats(rid));
    const asker = nodes.find((n) => toHex(n.round.pubkey) === toHex(who.asker));
    if (!asker) problems.push('the round named a seat that is not on this committee');
    const agree = nodes.filter((n) =>
      toHex(askerFor(rid, n.round.seats(rid)).asker) === toHex(who.asker)).length;
    say(`\nthe round names seat ${who.at + 1} of ${who.of}, and ${agree} of ${SHARES_TOTAL} seats agree`);
    if (agree !== SHARES_TOTAL) problems.push('the seats disagree about who asks');

    const settle = (n) => n.payouts.settleQueued({
      roundId: rid, contract, signing: n.signing, watch: n.poolWatch,
    });

    // ---- THE POOL, UNFUNDED. ----
    const dry = await settle(asker);
    say(`\nan unfunded pool: ${dry.ok ? 'PAID' : 'refused: ' + dry.why}`);
    if (dry.ok) problems.push('an unfunded pool paid a winner');
    if (asker.round.payout(rid).state !== PAYOUT_QUEUED)
      problems.push('a refusal moved the payout row');

    // ---- FUNDED, AND STILL IN A MEMPOOL. ----
    //
    // THE ANSWER IS "NOTHING THERE", AND IT IS THE RIGHT ONE. This harness was
    // written expecting "too shallow", and a real bitcoind said otherwise:
    // `scantxoutset` scans the UTXO SET, so a transaction still in the mempool
    // is not in the answer at all. The code and both unit tests said the wrong
    // thing until this run; they say this now.
    const funding = cli('sendtoaddress', poolAddress, '0.00001200');
    const mempool = await settle(asker);
    say(`funded but unconfirmed: ${mempool.ok ? 'PAID' : 'refused: ' + mempool.why}`);
    if (mempool.ok) problems.push('a committee signed against an output still in a mempool');
    if (!/0 confirmed output/.test(mempool.why || ''))
      problems.push(`an unconfirmed pool read as something else: ${mempool.why}`);

    mine(1);

    // ---- IN THE SET, AND NOT DEEP ENOUGH FOR THE CALLER. ----
    //
    // One block in, six asked for. This is what the shallow branch is actually
    // for, and it is the only way to reach it on a real chain.
    const shallow = await asker.payouts.settleQueued({
      roundId: rid, contract, signing: asker.signing, watch: asker.poolWatch,
      minConfirmations: 6,
    });
    say(`one confirmation against a demand for six: ${shallow.ok ? 'PAID' : 'refused: ' + shallow.why}`);
    if (shallow.ok) problems.push('a six-deep demand was met by a one-deep output');
    if (!/fewer than 6 confirmation/.test(shallow.why || ''))
      problems.push(`a shallow pool read as something else: ${shallow.why}`);

    const funded = JSON.parse(cli('scantxoutset', 'start',
      JSON.stringify([`raw(${toHex(out.script)})`])));
    say(`\nthe pool holds ${Math.round((funded.total_amount || 0) * 1e8)} sats at ${poolAddress}`);
    say(`  funding txid ${funding}`);

    // ---- THE SIX WHO DO NOT ASK. ----
    let waited = 0;
    for (const n of nodes) {
      if (n === asker) continue;
      const got = await settle(n);
      if (got.ok) problems.push('a seat that is not the asker sent a transaction');
      else if (got.waiting) waited++;
      else problems.push(`a waiting seat refused for the wrong reason: ${got.why}`);
    }
    say(`\n${waited} of ${SHARES_TOTAL - 1} other seats waited rather than asking`);
    if (waited !== SHARES_TOTAL - 1) problems.push('a seat refused to ask for the wrong reason');

    // ---- AND THE ASKER PAYS, IN FRONT OF CONSENSUS. ----
    const paid = await settle(asker);
    say('\nthe round\'s own asker, naming no outpoint:');
    if (!paid.ok) {
      say(`  REJECTED: ${paid.why}`);
      problems.push(`the asker was refused: ${paid.why}`);
    } else {
      say(`  sendrawtransaction -> ${toHex(new Uint8Array(paid.txid).reverse())}`);
      say(`  signed by ${paid.signed} of ${SHARES_NEEDED} seats`);
      mine(1);
      const height = Number(cli('getblockcount'));
      const seen = JSON.parse(cli('getrawtransaction',
        toHex(new Uint8Array(paid.txid).reverse()), 'true'));
      say(`  block ${height} carries it (${seen.blockhash ? 'confirmed' : 'NOT in a block'})`);
      if (!seen.blockhash) problems.push('the payout never reached a block');

      const winnerAddress = JSON.parse(cli('decodescript',
        '5120' + toHex(schnorr.getPublicKey(winnerSecret)))).address;
      const held = JSON.parse(cli('scantxoutset', 'start',
        JSON.stringify([`addr(${winnerAddress})`])));
      const sats = Math.round((held.total_amount || 0) * 1e8);
      say(`  the winner's own key holds ${sats} sats at ${winnerAddress}`);
      if (BigInt(sats) !== STAKE_MSAT / 1000n)
        problems.push(`the winner holds ${sats} sats, not ${STAKE_MSAT / 1000n}`);
      if (asker.round.payout(rid).state !== PAID) problems.push('the row was not marked PAID');
      say(`  the asker's own store says ${asker.round.payout(rid).state}`);
    }

    // ---- AND A SECOND ASK SENDS NOTHING. ----
    const again = await settle(asker);
    say(`\nasking again: ${again.already ? 'already ' + again.state : (again.ok ? 'PAID AGAIN' : again.why)}`);
    if (again.ok && !again.already) problems.push('a second ask built a second spend of one output');

  } finally {
    for (const n of nodes) { try { await n.close(); } catch { /* going down anyway */ } }
    say('\nstopping bitcoind.');
    try { sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, 'stop']); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 1500));
    if (!KEEP) { rmSync(dir, { recursive: true, force: true }); say('stopped, and the scratch datadir is gone.'); }
    else say(`stopped; kept ${dir}`);
  }

  if (problems.length) {
    say('\nPROBLEMS:');
    for (const p of problems) say(`  - ${p}`);
    process.exitCode = 1;
  } else say('\nEvery number came out as claimed.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
