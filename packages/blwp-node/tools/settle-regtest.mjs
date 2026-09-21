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
// and the things the node already holds. Everything else - which signer node asks,
// which output to spend, what it is worth - comes from the round id, the
// signer node's own store and `scantxoutset`.
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
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { CORE_HASH } from './core-hash.mjs';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../protocol/src/donation.js';
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
import { askerFor, askerOrder, TAKEOVER_BLOCKS, PAYOUT_QUEUED, PAID } from '../src/payout.js';
import { PoolSigning } from '../src/pool-signing.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../protocol/src/contracts.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../protocol/src/result.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeAssigned } from '../test/assignment.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
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

    // ---- NO DEALER. The committee makes its own key, further down. ----
    //
    // This harness used to open with `trustedDealerSplit` and hand each daemon
    // a share, which measured the mechanism and not the custody: THIS process
    // held all seven and therefore the group secret. Letter 14 took it out.
    // The daemons are started with no pool key at all and run the DKG between
    // themselves before anything is funded.
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

    // ---- THE ROUND'S BEACON, TAKEN OFF THIS CHAIN. ----
    const beacon = {
      hash: fromHex(cli('getblockhash', cli('getblockcount'))),
      height: Number(cli('getblockcount')),
      timeMs: BigInt(NOW),
    };
    say(`the round's beacon is block ${beacon.height}`);

    // ---- SEVEN DAEMONS, EACH WITH ITS OWN STORE AND NO KEY AT ALL. ----
    for (let i = 0; i < SHARES_TOTAL; i++) {
      nodes.push(await serve(openStore(join(dir, `node-${i}.db`)), {
        port: 0, funded: () => true, now: () => NOW,
        poolCurve: curve, chainSpend: chain,
        // THE ROUND'S OWN CHAIN ANCHOR. Item 19's takeover order is measured
        // in BLOCKS past this height, and it is a real height off this chain -
        // the harness reads it rather than naming one, so the waits below are
        // waits the chain actually served.
        randomnessFor: () => beacon,
      }));
    }
    say(`\nseven daemons on ports ${nodes.map((n) => n.port).join(', ')}`);

    // ---- AND THEY MAKE THEIR OWN KEY (M3.3 item 14). ----
    //
    // Every daemon deals one contribution to the committee, keeps the one
    // envelope addressed to it, and combines. Nothing in THIS process ever
    // holds a share: the harness only tells them who the committee is, which
    // is public.
    const committee = nodes.map((n) => n.round.pubkey);
    for (const n of nodes) n.dkg.peers = nodes.filter((o) => o !== n).map((o) => `http://127.0.0.1:${o.port}`);
    for (const n of nodes) await n.dkg.run(committee);
    for (const n of nodes) await n.dkg.run(committee);

    const signerNodesHeld = nodes.map((n) => n.dkg.signerNodeFor(committee));
    for (const [i, h] of signerNodesHeld.entries())
      if (!h.ok) problems.push(`daemon ${i} ended with no share: ${h.why}`);
    const keys = new Set(signerNodesHeld.filter((h) => h.ok).map((h) => toHex(h.pool.groupPublicKey)));
    say(`each made its own share; ${keys.size} distinct group key(s) across ${SHARES_TOTAL} daemons`);
    if (keys.size !== 1) problems.push(`the daemons named ${keys.size} different keys`);
    const shares = new Set(signerNodesHeld.filter((h) => h.ok).map((h) => String(h.signerNode.share)));
    say(`  ${shares.size} distinct shares, one each, and this process holds none`);
    if (shares.size !== SHARES_TOTAL) problems.push('two daemons hold the same share');

    const pool = { groupPublicKey: signerNodesHeld[0].pool.groupPublicKey };
    say(`  the committee's key: ${toHex(pool.groupPublicKey).slice(0, 32)}…`);

    // AND THE SIGNING HALF IS POINTED AT WHAT THEY MADE. `PoolSigning` takes
    // `{ id, share }` and a group key, which is exactly the shape `signerNodeFor`
    // hands back - so nothing about item 17's two rounds changes.
    for (const [i, n] of nodes.entries()) {
      n.signing.signerNode = signerNodesHeld[i].signerNode;
      n.signing.pool = pool;
      n.payouts.pool = pool;
      n.poolWatch.pool = pool;
    }

    const contract = {
      networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
      gameVerifySlots: SHARES_TOTAL, settlementSlots: SHARES_TOTAL, simCoreHash: CORE_HASH,
      committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
      startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
      objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
      slashRemainder: 'SPLIT', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
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
        stakeCommitment: b32(7), stakeMsat: STAKE_MSAT, feeMsat: entryFeeMsat(STAKE_MSAT), donationMsat: 0n,
        joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
      },
    }));

    for (const n of nodes) {
      const opened = await post(n.port, '/round', encodeRoundContract(contract));
      if (opened.status !== 201) problems.push(`a node refused the round: ${await opened.text()}`);
      assumeAssigned(n.round, rid, contract.nodes);
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

    // ---- EVERY SIGNER NODE SIGNS THE TABLE IT COMPUTED, AND FETCHES THE OTHERS'. ----
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
        problems.push(`a signer node did not queue the payout: ${queued.why}`);
    }
    say(`\nall seven queued the payout; it owes the winner ${STAKE_MSAT / 1000n} sats`);

    // ---- THE CHAIN THIS DAEMON ASKS ABOUT ITS OWN POOL. ----
    //
    // `bitcoindRpc` over the same cookie the CLI uses. Every node gets it, so
    // the signer nodes that are not the asker are refused by the RULE and not by
    // having no chain to ask.
    const call = bitcoindRpc({ url: `http://127.0.0.1:${P.rpc}/`, cookiePath: cookie });
    for (const n of nodes) n.poolWatch.call = call;

    const out = poolOutput({ groupPublicKey: pool.groupPublicKey, curve });
    const poolAddress = JSON.parse(cli('decodescript', toHex(out.script))).address;

    // ---- WHO ASKS, AND IN WHAT ORDER AFTER THAT. ----
    const ring = askerOrder(rid, nodes[0].round.signerNodes(rid));
    const nodeAt = (k) => nodes.find((n) => toHex(n.round.pubkey) === toHex(ring.order[k]));
    const agree = nodes.filter((n) =>
      toHex(askerOrder(rid, n.round.signerNodes(rid)).order[0]) === toHex(ring.order[0])).length;
    say(`\nthe round names signer node ${ring.at + 1} of ${ring.of}, and ${agree} of ${SHARES_TOTAL} signer nodes agree`);
    if (agree !== SHARES_TOTAL) problems.push('the signer nodes disagree about who asks');

    // AND NO NODE CAN MOVE ITS OWN PLACE. The store sorts the signer nodes by pubkey,
    // so a node handed the same seven in another order computes the same ring.
    const shuffled = [...nodes[0].round.signerNodes(rid)].reverse()
      .sort((a, b) => (toHex(a) < toHex(b) ? -1 : 1));
    const same = askerOrder(rid, shuffled).order.every((k, i) => toHex(k) === toHex(ring.order[i]));
    say(`  the order survives being handed round the other way: ${same}`);
    if (!same) problems.push('the takeover order depends on how the signer nodes arrive');

    const settle = (n, extra = {}) => n.payouts.settleQueued({
      roundId: rid, contract, signing: n.signing, watch: n.poolWatch, ...extra,
    });

    // ---- THE POOL, UNFUNDED. ----
    const dry = await settle(nodeAt(0));
    say(`\nan unfunded pool: ${dry.ok ? 'PAID' : 'refused: ' + dry.why}`);
    if (dry.ok) problems.push('an unfunded pool paid a winner');
    if (nodeAt(0).round.payout(rid).state !== PAYOUT_QUEUED)
      problems.push('a refusal moved the payout row');

    // ---- FUNDED, AND STILL IN A MEMPOOL. ----
    //
    // THE ANSWER IS "NOTHING THERE", AND IT IS THE RIGHT ONE. This harness was
    // written expecting "too shallow", and a real bitcoind said otherwise:
    // `scantxoutset` scans the UTXO SET, so a transaction still in the mempool
    // is not in the answer at all.
    const funding = cli('sendtoaddress', poolAddress, '0.00001200');
    const mempool = await settle(nodeAt(0));
    say(`funded but unconfirmed: ${mempool.ok ? 'PAID' : 'refused: ' + mempool.why}`);
    if (mempool.ok) problems.push('a committee signed against an output still in a mempool');
    if (!/0 confirmed output/.test(mempool.why || ''))
      problems.push(`an unconfirmed pool read as something else: ${mempool.why}`);

    mine(1);
    const funded = JSON.parse(cli('scantxoutset', 'start',
      JSON.stringify([`raw(${toHex(out.script)})`])));
    say(`\nthe pool holds ${Math.round((funded.total_amount || 0) * 1e8)} sats at ${poolAddress}`);
    say(`  funding txid ${funding}`);

    // ---- IN THE SET, AND NOT DEEP ENOUGH FOR THE CALLER. ----
    const shallow = await settle(nodeAt(0), { minConfirmations: 6 });
    say(`one confirmation against a demand for six: ${shallow.ok ? 'PAID' : 'refused: ' + shallow.why}`);
    if (shallow.ok) problems.push('a six-deep demand was met by a one-deep output');
    if (!/fewer than 6 confirmation/.test(shallow.why || ''))
      problems.push(`a shallow pool read as something else: ${shallow.why}`);

    // ================= ITEM 19 =================
    //
    // THE ASKER IS DOWN. It never runs. Everything below is the signer nodes behind
    // it, and the only clock any of them reads is the height of this chain.
    say(`\n---- the round's own asker is down; nobody runs it ----`);
    say(`the chain is at ${cli('getblockcount')}, the beacon was ${beacon.height}`);

    let waited = 0;
    for (let k = 1; k < SHARES_TOTAL; k++) {
      const got = await settle(nodeAt(k));
      if (got.ok) problems.push(`signer node ${k + 1} paid before its turn`);
      else if (got.waiting) waited++;
      else problems.push(`signer node ${k + 1} refused for the wrong reason: ${got.why}`);
      if (k === 1) say(`  the next signer node: ${got.why}`);
    }
    say(`  ${waited} of ${SHARES_TOTAL - 1} signer nodes waited; nothing was broadcast`);
    if (waited !== SHARES_TOTAL - 1) problems.push('a signer node took over before its turn');
    if (nodeAt(0).round.payout(rid).state !== PAYOUT_QUEUED)
      problems.push('the winner was paid while every signer node was still waiting');

    // ---- THE CHAIN ADVANCES, AND THE NEXT SIGNER NODE PAYS. ----
    const need = beacon.height + TAKEOVER_BLOCKS - Number(cli('getblockcount'));
    if (need > 0) mine(need);
    say(`\n---- ${TAKEOVER_BLOCKS} block(s) past the beacon: the chain is at ${cli('getblockcount')} ----`);

    const took = await settle(nodeAt(1));
    if (!took.ok) {
      say(`  REFUSED: ${took.why}`);
      problems.push(`the takeover was refused: ${took.why}`);
    } else {
      const txid = toHex(new Uint8Array(took.txid).reverse());
      say(`  signer node ${(ring.at + 1) % SHARES_TOTAL + 1} took over: sendrawtransaction -> ${txid}`);
      say(`  signed by ${took.signed} of ${SHARES_NEEDED} signer nodes`);

      // ---- AND THE SIGNER NODE BEHIND, WHILE THAT SPEND IS STILL IN THE MEMPOOL. ----
      //
      // THE WINDOW `gettxout` EXISTS FOR, and it is only open right here:
      // nothing has been mined, so the output is still in the UTXO SET and
      // `scantxoutset` would hand it over as spendable. `takeoverBlocks: 1`
      // brings this signer node's turn forward rather than waiting for a block,
      // because a block would confirm the spend and close the window.
      const inFlight = await settle(nodeAt(2), { takeoverBlocks: 1 });
      say(`  the signer node behind, spend still in the mempool: `
        + `${inFlight.ok ? 'PAID AGAIN' : 'refused: ' + inFlight.why}`);
      if (inFlight.ok) problems.push('a signer node signed a second spend of an output already in a mempool');
      if (inFlight.waiting) problems.push('the mempool window was not measured: the clock stopped it');
      if (!inFlight.spending)
        problems.push(`the mempool spend was not what stopped it: ${inFlight.why}`);

      mine(1);
      const height = Number(cli('getblockcount'));
      const seen = JSON.parse(cli('getrawtransaction', txid, 'true'));
      say(`  block ${height} carries it (${seen.blockhash ? 'confirmed' : 'NOT in a block'})`);
      if (!seen.blockhash) problems.push('the takeover never reached a block');

      const winnerAddress = JSON.parse(cli('decodescript',
        '5120' + toHex(schnorr.getPublicKey(winnerSecret)))).address;
      const held = JSON.parse(cli('scantxoutset', 'start',
        JSON.stringify([`addr(${winnerAddress})`])));
      const sats = Math.round((held.total_amount || 0) * 1e8);
      say(`  the winner's own key holds ${sats} sats at ${winnerAddress}`);
      if (BigInt(sats) !== STAKE_MSAT / 1000n)
        problems.push(`the winner holds ${sats} sats, not ${STAKE_MSAT / 1000n}`);
      if (nodeAt(1).round.payout(rid).state !== PAID) problems.push('the takeover did not mark the row PAID');
    }

    // ---- A SPEND ALREADY GONE STOPS THE SIGNER NODE BEHIND. ----
    //
    // ITS TURN HAS TO HAVE COME FIRST, or this measures the clock and not the
    // output. Written the other way first and it read as a refusal - "may ask
    // at height 204" - which is a true sentence about the wrong thing. Mined
    // up to signer node three's own turn, so the only thing left to stop it is that
    // the pool output is not there any more.
    const thirdAt = beacon.height + TAKEOVER_BLOCKS * 2;
    const toThird = thirdAt - Number(cli('getblockcount'));
    if (toThird > 0) mine(toThird);
    const behind = await settle(nodeAt(2));
    say(`\nthe signer node behind, at its own turn (height ${cli('getblockcount')}, due ${thirdAt}): `
      + `${behind.ok ? 'PAID AGAIN' : 'refused: ' + behind.why}`);
    if (behind.ok) problems.push('a signer node behind the takeover spent the pool a second time');
    if (behind.waiting) problems.push('the signer node behind was stopped by the clock, so the output was not measured');

    // ---- AND THE ASKER COMES BACK, AFTER A RESTART. ----
    //
    // Fresh `PoolSigning` objects over the same stores, which is what a
    // process restart leaves behind. Before letter 19 put the nonce pair on
    // disk, a restarted committee signed the same input with DIFFERENT bytes -
    // the unit suite measures that byte for byte. What is measured HERE is the
    // outcome that matters on a chain: the signer node that was down comes back, its
    // own row still says queued, and it spends nothing, because the pool
    // output it would have spent is gone.
    for (const n of nodes)
      n.signing = new PoolSigning(n.round, {
        curve, signerNode: signerNodesHeld[nodes.indexOf(n)].signerNode, pool,
      });
    const back = await settle(nodeAt(0));
    say(`the asker came back after a restart: ${back.ok ? 'PAID AGAIN' : 'refused: ' + back.why}`);
    if (back.ok) problems.push('the returning asker spent the pool a second time');
    if (back.waiting) problems.push('the returning asker was stopped by the clock rather than by the chain');

    // ---- ONE SPEND OF THAT OUTPUT, COUNTED ON THE CHAIN ITSELF. ----
    const spends = JSON.parse(cli('getrawtransaction', funding, 'true'));
    void spends;
    const poolNow = JSON.parse(cli('scantxoutset', 'start',
      JSON.stringify([`raw(${toHex(out.script)})`])));
    const left = Math.round((poolNow.total_amount || 0) * 1e8);
    say(`\nthe pool now holds ${left} sats, and the winner holds ${STAKE_MSAT / 1000n}`);
    const winnerAddress = JSON.parse(cli('decodescript',
      '5120' + toHex(schnorr.getPublicKey(winnerSecret)))).address;
    const paidOut = JSON.parse(cli('scantxoutset', 'start', JSON.stringify([`addr(${winnerAddress})`])));
    const paidSats = Math.round((paidOut.total_amount || 0) * 1e8);
    say(`  the winner's key holds ${paidSats} sats - ONE payment, not two`);
    if (BigInt(paidSats) !== STAKE_MSAT / 1000n)
      problems.push(`the winner ended up with ${paidSats} sats, not ${STAKE_MSAT / 1000n}`);

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
