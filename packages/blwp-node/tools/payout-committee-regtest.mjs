// A COMMITTEE PAID A WINNER, ON A REAL CHAIN, WITH NO SHARE IN ONE PLACE.
//
// `payout-regtest.mjs` put five shares in one process and asked consensus. It
// proved the transaction; it could not prove the committee, because the thing
// holding the five secrets was a `map`. This stands SEVEN DAEMONS on seven
// sockets, deals one share to each, funds the pool on an isolated regtest, and
// has one of them ask the others:
//
//   five of seven      sendrawtransaction -> a txid, a block carries it, and
//                      the winner's own key holds the sats
//   four of seven      nothing is sent; the row stays PAYOUT_QUEUED
//   a rogue asker      every seat refuses, by name, over HTTP
//
// The asker holds ONE share. What crosses the wire is a nonce commitment and a
// signature share, twice five of them, and never a secret.
//
// Own datadir, non-default ports, cookie auth, stopped when the numbers are
// in. It touches no mainnet and no testnet4 datadir. The coins are worthless.
//
//   node packages/blwp-node/tools/payout-committee-regtest.mjs [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { PAYOUT_QUEUED, PAID } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { encodeUtxo } from '../src/pool-wire.js';
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
const P = { rpc: 29683, p2p: 29684 };
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
  const dir = process.env.PAYRT || mkdtempSync(join(tmpdir(), 'payout-committee-'));
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

    // ---- NO DEALER. The committee makes its own key, below. ----
    //
    // This opened with `trustedDealerSplit` and handed each daemon a share,
    // which measured the mechanism and not the custody: THIS process held all
    // seven and therefore the group secret. Letter 14 took it out.

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
        poolCurve: curve, chainSpend: chain,
      }));
    }
    say(`\nseven daemons on ports ${nodes.map((n) => n.port).join(', ')}`);

    // ---- AND THEY MAKE THEIR OWN KEY (M3.3 item 14). ----
    const committee = nodes.map((n) => n.round.pubkey);
    for (const n of nodes) n.dkg.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
    for (const n of nodes) await n.dkg.run(committee);
    for (const n of nodes) await n.dkg.run(committee);
    const seatsHeld = nodes.map((n) => n.dkg.seatFor(committee));
    for (const [i, h] of seatsHeld.entries())
      if (!h.ok) problems.push(`daemon ${i} ended with no share: ${h.why}`);
    const keys = new Set(seatsHeld.filter((h) => h.ok).map((h) => toHex(h.pool.groupPublicKey)));
    if (keys.size !== 1) problems.push(`the daemons named ${keys.size} different keys`);
    const pool = { groupPublicKey: seatsHeld[0].pool.groupPublicKey };
    say(`each made its own share; one key across all ${SHARES_TOTAL}, and this process holds none`);
    say(`  the committee's key: ${toHex(pool.groupPublicKey).slice(0, 32)}…`);
    for (const [i, n] of nodes.entries()) {
      n.signing.seat = seatsHeld[i].seat;
      n.signing.pool = pool;
      n.payouts.pool = pool;
    }

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

    // ---- THE POOL, FUNDED ON THE CHAIN. ----
    const out = poolOutput({ groupPublicKey: pool.groupPublicKey, curve });
    const poolAddress = JSON.parse(cli('decodescript', toHex(out.script))).address;
    const funding = cli('sendtoaddress', poolAddress, '0.00001200');
    mine(1);
    const fundingTx = parseTransaction(fromHex(cli('getrawtransaction', funding)));
    const vout = fundingTx.outputs.findIndex((o) => toHex(o.script) === toHex(out.script));
    const utxo = {
      txid: fromHex(funding).reverse(), vout,
      value: fundingTx.outputs[vout].value, script: out.script,
    };
    say(`the pool holds ${utxo.value} sats at ${poolAddress}`);

    // ---- A ROGUE ASKER. ----
    //
    // There is no door that takes a sighash, so the attack has no shape: the
    // nearest thing an asker can do is name an output of its own, and every
    // seat rebuilds the spend before it answers.
    const rogue = { ...utxo, script: fromHex('5120' + toHex(schnorr.getPublicKey(rand(32)))) };
    let refusedRogue = 0;
    for (const n of nodes) {
      const got = await post(n.port, `/pool/commit?round=${toHex(rid)}`, encodeUtxo(rogue));
      const why = (await got.text()).trim();
      if (got.status !== 200) refusedRogue++;
      else problems.push('a seat committed to a spend of an output that is not the pool');
      if (n === nodes[0]) say(`\na rogue asker naming its own output: ${got.status} ${why}`);
    }
    say(`  ${refusedRogue} of ${SHARES_TOTAL} seats refused it`);

    // ---- FOUR OF SEVEN. ----
    const asker = nodes[0];
    const four = await asker.payouts.payWithCommittee({
      roundId: rid, utxo, contract, signing: asker.signing,
      seats: nodes.slice(1, SHARES_NEEDED - 1).map((n) => `http://127.0.0.1:${n.port}`),
    });
    say(`\nfour of seven: ${four.ok ? 'PAID' : 'refused: ' + four.why}`);
    if (four.ok) problems.push('four of seven paid the winner');
    if (asker.round.payout(rid).state !== PAYOUT_QUEUED)
      problems.push('a short committee moved the payout row');

    // ---- FIVE OF SEVEN, IN FRONT OF CONSENSUS. ----
    const paid = await asker.payouts.payWithCommittee({
      roundId: rid, utxo, contract, signing: asker.signing,
      seats: nodes.slice(1, SHARES_NEEDED).map((n) => `http://127.0.0.1:${n.port}`),
    });
    say('\nfive of seven, each on its own socket with its own share:');
    if (!paid.ok) {
      say(`  REJECTED: ${paid.why}`);
      problems.push(`five of seven were rejected: ${paid.why}`);
    } else {
      say(`  sendrawtransaction -> ${toHex(new Uint8Array(paid.txid).reverse())}`);
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
      if (asker.round.payout(rid).state !== PAID)
        problems.push('the row was not marked PAID');
      say(`  the asker's own store says ${asker.round.payout(rid).state}, signed by ${paid.signed} seats`);
    }
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
