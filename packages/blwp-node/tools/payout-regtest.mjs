// A WINNER PAID, ON A REAL CHAIN.
//
// `payout-pay.test.js` proves the states and the arithmetic against a fake
// chain that says yes. What it cannot prove is that the transaction those
// bytes make is one a Bitcoin node will take - and a payout that only exists
// in a unit test has paid nobody.
//
// So this deals a committee, funds their pool output on an ISOLATED regtest -
// own datadir, non-default ports, cookie auth, stopped when the numbers are in
// - and asks consensus:
//
//   four of seven      REJECTED
//   five of seven      sendrawtransaction -> a txid, a block carries it, and
//                      the winner's own key holds the sats
//
// It touches no mainnet and no testnet4 datadir. The coins are worthless.
//
//   node packages/blwp-node/tools/payout-regtest.mjs [--keep]
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

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Payouts, PAYOUT_QUEUED, PAID } from '../src/payout.js';
import { tableFor, signPayoutTable } from '../src/payout-table.js';
import { trustedDealerSplit } from '../../protocol/src/frost.js';
import { evenGroupSecret } from '../../protocol/src/frost-bip340.js';
import { poolOutput, poolShare, poolSigningKey, poolWitness } from '../../protocol/src/pool.js';
import { tapSighash, serializeSpend } from '../../protocol/src/bond-spend.js';
import { signShare340, aggregate340 } from '../../protocol/src/frost-bip340.js';
import { nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { payoutOutputs } from '../../protocol/src/payout-spend.js';
import { payToKey } from '../../protocol/src/payout-spend.js';
import { DELIVERED, FORFEIT } from '../../protocol/src/payout.js';
import { scalarFrom32, FIELD, SHARES_NEEDED, SHARES_TOTAL } from '../../protocol/src/shares.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { assumeSeated } from '../test/seating.js';
import { PAID_IN_PART } from '../src/payout.js';
import { parseTransaction } from '../../protocol/src/tx.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

const BITCOIN = process.env.BITCOIN_BIN || '/mnt/bitcoin/bitcoin-31.1/bin';
const KEEP = process.argv.includes('--keep');
const P = { rpc: 29673, p2p: 29674 };
const rand = (n) => new Uint8Array(randomBytes(n));
const b32 = (n) => new Uint8Array(32).fill(n);
const curve = { ...feldmanGroup, tweakPoint };
const say = (s) => console.log(s);
const NOW = 1788700000000;

// A STAKE THAT CLEARS THE RELAY FLOOR. The fixtures run at 100000 msat, and a
// whole round's pool at that stake is 100 or 200 sats - below the 330 a node
// will relay. That is a real limit of the daily and it is named on PRIORITIES;
// what this tool measures is the mechanism, so it uses a stake that can be paid.
const STAKE_MSAT = 1000000n;                       // 1000 sats

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

async function main() {
  const dir = process.env.PAYRT || mkdtempSync(join(tmpdir(), 'payout-regtest-'));
  mkdirSync(join(dir, 'btc'), { recursive: true });
  say(`an isolated regtest of its own: ${dir}`);
  const btcArgs = ['-regtest', `-datadir=${join(dir, 'btc')}`, `-rpcport=${P.rpc}`];
  const cli = (...a) => sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, ...a]);
  const cookie = join(dir, 'btc', 'regtest', '.cookie');
  const problems = [];

  try {
    spawn(join(BITCOIN, 'bitcoind'), [...btcArgs, `-port=${P.p2p}`, '-listenonion=0',
      '-fallbackfee=0.0001', '-txindex', '-daemon'], { stdio: 'ignore' });
    await until('bitcoind', () => existsSync(cookie) && cli('getblockcount'));
    try { cli('createwallet', 'payout'); } catch { cli('loadwallet', 'payout'); }
    const mine = (n) => cli('generatetoaddress', String(n), cli('getnewaddress'));
    if (Number(cli('getblockcount')) < 200) mine(200 - Number(cli('getblockcount')));
    say(`bitcoind at height ${cli('getblockcount')}, rpc ${P.rpc}, cookie auth`);

    // ---- THE COMMITTEE, THE ROUND, AND TWO PLAYERS WHOSE KEYS ARE KEYS. ----
    const seatSecrets = Array.from({ length: SHARES_TOTAL }, () => rand(32));
    const seatKeys = seatSecrets.map((s) => schnorr.getPublicKey(s));
    const round = new Round(openStore(join(dir, 'node.db')), () => NOW);
    const contract = {
      networkId: NETWORK_ID_REGTEST, configHash: TRUCK_CONFIG_HASH, censusConfirmations: 1,
      gameVerifySlots: 7, settlementSlots: 7, simCoreHash: CORE_HASH,
      committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
      startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
      entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
      objectionWindowMs: 600000n, custody: 'THRESHOLD_LN', slashMinimumServed: 20,
      slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
      censusRoot: b32(2), stakeMsat: STAKE_MSAT, bondMinSats: 50000n, blockTicks: 9000,
      exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
      timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
      nodes: seatKeys,
    };
    const rid = round.open(contract);
    assumeSeated(round, rid, [round.pubkey, ...seatKeys.slice(1)]);

    const winnerSecret = rand(32);
    const loserSecret = rand(32);
    const winner = schnorr.getPublicKey(winnerSecret);
    const loser = schnorr.getPublicKey(loserSecret);
    const entries = [
      { entryId: b32(1), pubkey: winner, outcome: DELIVERED, score: 9, stakeMsat: STAKE_MSAT },
      { entryId: b32(2), pubkey: loser, outcome: FORFEIT, score: 0, stakeMsat: STAKE_MSAT },
    ];

    // ---- THE POOL, FUNDED WITH WHAT THE LOSER FORFEITED. ----
    const even = evenGroupSecret(scalarFrom32(rand(32)) % FIELD, feldmanGroup);
    const dealt = trustedDealerSplit({
      secret: even.secret, max: SHARES_TOTAL, min: SHARES_NEEDED,
      coefficients: Array.from({ length: SHARES_NEEDED - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      curve: feldmanGroup,
    });
    const out = poolOutput({ groupPublicKey: dealt.groupPublicKey, curve });
    const poolAddress = JSON.parse(cli('decodescript', toHex(out.script))).address;
    const funding = cli('sendtoaddress', poolAddress, '0.00001200');
    mine(1);
    const fundingTx = parseTransaction(fromHex(cli('getrawtransaction', funding)));
    const vout = fundingTx.outputs.findIndex((o) => toHex(o.script) === toHex(out.script));
    const utxo = { txid: fromHex(funding).reverse(), vout, value: fundingTx.outputs[vout].value };
    say(`\nthe pool holds ${utxo.value} sats at ${poolAddress}`);
    say(`  the round's stake is ${STAKE_MSAT} msat, so the pool owes the winner ${STAKE_MSAT / 1000n} sats`);

    // ---- FIVE OF SEVEN SIGN THE TABLE. ----
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
    const payouts = new Payouts(round, { curve, random: rand, chain, pool: dealt });

    const built = tableFor({ roundId: rid, entries, minScore: contract.minScore });
    for (let i = 1; i < 5; i++)
      round.putPayoutSignature(rid, seatKeys[i],
        signPayoutTable({ tableId: built.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
    const queued = payouts.queue({ roundId: rid, entries, minScore: contract.minScore, contract });
    say(`\nthe payout table: ${queued.ok ? queued.state : queued.why}`);
    if (!queued.ok || queued.state !== PAYOUT_QUEUED) problems.push('the table was not queued');
    else say(`  ${queued.agreed} of 5 seats signed it, and it owes ${queued.owedMsat} msat`);

    // ---- AND THE FLOOR, ON THIS NODE'S OWN NUMBER. ----
    //
    // Not a remembered 330: the boundary is asked of the chain that is about
    // to relay the transaction, by offering it one sat less and then the floor.
    const floorOf = () => {
      const to = cli('getnewaddress', '', 'bech32m');
      for (let sats = 300; sats <= 1000; sats++) {
        try { cli('sendtoaddress', to, (sats / 1e8).toFixed(8)); return BigInt(sats); }
        catch { /* still too small */ }
      }
      return null;
    };
    const floor = floorOf();
    say(`\nthe relay floor this node enforces: ${floor} sats`);
    if (floor === null) problems.push('the node never accepted an output up to 1000 sats');


    // ---- FOUR OF SEVEN, TWICE. ----
    //
    // The daemon refuses them before it builds anything, which is a courtesy.
    // The property underneath is that four shares do not make a signature for
    // this key at all - so the same spend is built by hand and put in front of
    // consensus, which owes nobody a courtesy.
    const four = await payouts.pay({
      roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 4),
    });
    say(`\nfour of seven ask the daemon: ${four.ok ? 'ACCEPTED' : 'refused: ' + four.why}`);
    if (four.ok) problems.push('four of seven paid the winner');

    const byHand = new Payouts(round, { curve, random: rand, chain, pool: dealt });
    const built4 = payoutOutputs({ rows: queued.rows, poolSats: utxo.value });
    const inputs = [{ txid: utxo.txid, vout: utxo.vout, sequence: 0xfffffffd }];
    const sighash4 = tapSighash({
      inputs, prevouts: [{ value: utxo.value, script: out.script }],
      outputs: built4.outputs, inputIndex: 0,
    });
    const gk = poolSigningKey(out.outputKey);
    const r1 = dealt.shares.slice(0, 4).map((s) => {
      const share = poolShare({ share: s.share, tweak: out.tweak, negated: out.negated });
      const hiding = nonceGenerate340(rand(32), share);
      const binding = nonceGenerate340(rand(32), share);
      return { id: s.id, share, hiding, binding,
        commitment: { id: s.id,
          hiding: feldmanGroup.pointFromScalar(hiding),
          binding: feldmanGroup.pointFromScalar(binding) } };
    });
    const cs = r1.map((s) => s.commitment);
    const sig4 = aggregate340({
      commitments: cs, message: sighash4, groupPublicKey: gk, curve: feldmanGroup,
      shares: r1.map((s) => signShare340({
        id: s.id, share: s.share, groupPublicKey: gk,
        nonces: { hiding: s.hiding, binding: s.binding },
        message: sighash4, commitments: cs, curve: feldmanGroup,
      })),
    });
    const raw4 = serializeSpend({
      inputs, outputs: built4.outputs, witnesses: [poolWitness(sig4.signature)],
    });
    const sent4 = await chain.send(raw4);
    say(`four of seven ask consensus: ${sent4.ok ? 'ACCEPTED ' + toHex(sent4.txid) : 'REJECTED: ' + sent4.why}`);
    if (sent4.ok) problems.push('consensus took a four-of-seven payout');
    void byHand;

    // ---- FIVE OF SEVEN. ----
    const paid = await payouts.pay({
      roundId: rid, rows: queued.rows, utxo, signers: dealt.shares.slice(0, 5),
      dustSats: floor === null ? undefined : floor,
    });
    say('five of seven:');
    if (!paid.ok) { say(`  REJECTED: ${paid.why}`); problems.push(`five of seven were rejected: ${paid.why}`); }
    else {
      say(`  sendrawtransaction -> ${toHex(new Uint8Array(paid.txid).reverse())}`);
      mine(1);
      const height = Number(cli('getblockcount'));
      const block = JSON.parse(cli('getblock', cli('getblockhash', String(height))));
      const txidHex = toHex(new Uint8Array(paid.txid).reverse());
      say(`  block ${height} ${block.tx.includes(txidHex) ? 'contains it' : 'DOES NOT contain it'}`);
      if (!block.tx.includes(txidHex)) problems.push('the payout never made it into a block');

      const spent = JSON.parse(cli('gettxout', funding, String(vout)) || 'null');
      if (spent !== null) problems.push('the pool output was not spent');

      // AND THE WINNER'S OWN KEY HOLDS THE SATS.
      const won = JSON.parse(cli('gettxout', txidHex, '0'));
      const paysWinner = toHex(fromHex(won.scriptPubKey.hex)) === toHex(payToKey(winner));
      say(`  the winner's own key holds ${Math.round(won.value * 1e8)} sats: ${paysWinner}`);
      if (!paysWinner) problems.push('the payout pays a key that is not the winner\'s');
      if (Math.round(won.value * 1e8) !== Number(STAKE_MSAT / 1000n))
        problems.push(`the winner got ${Math.round(won.value * 1e8)} sats, not ${STAKE_MSAT / 1000n}`);
      const row = round.payout(rid);
      if (row.state !== PAID) problems.push(`the round was written down as ${row.state}, not PAID`);
      if (row.owedSats !== 0n) problems.push(`the round records ${row.owedSats} sats still owed`);
      say(`  this node's row says ${row.state}, paid ${paid.paidSats} sats, ${paid.feeSats} to the miner`);
      say(`  and it owes ${row.owedSats} sats to ${row.owedCount} player(s)`);

      // ---- AND A WINNER UNDER THAT FLOOR, ON THE SAME CHAIN. ----
      //
      // The pool is spent, so this is a second round on a second output: what
      // is measured is that no transaction is made at all and the debt is
      // written down rather than the sats being quietly kept.
      const small = cli('sendtoaddress', poolAddress, '0.00002000');
      mine(1);
      const smallTx = parseTransaction(fromHex(cli('getrawtransaction', small)));
      const smallVout = smallTx.outputs.findIndex((o) => toHex(o.script) === toHex(out.script));
      const rid2 = round.open({ ...contract, configHash: TRUCK_CONFIG_HASH, slashMinimumServed: 21 });
      assumeSeated(round, rid2, [round.pubkey, ...seatKeys.slice(1)]);
      const tiny = [{ pubkey: winner, msat: (floor - 1n) * 1000n }];
      const built2 = tableFor({ roundId: rid2, entries, minScore: contract.minScore });
      for (let i = 1; i < 5; i++)
        round.putPayoutSignature(rid2, seatKeys[i],
          signPayoutTable({ tableId: built2.tableId, secret: seatSecrets[i], pubkey: seatKeys[i] }));
      round.putPayout({ roundId: rid2, tableId: built2.tableId, state: 'PAYOUT_QUEUED',
        why: 'a round whose only winner is under the floor' });
      const under = await payouts.pay({
        roundId: rid2, rows: tiny, signers: dealt.shares.slice(0, 5), dustSats: floor,
        utxo: { txid: fromHex(small).reverse(), vout: smallVout, value: smallTx.outputs[smallVout].value },
      });
      say(`\na winner owed ${floor - 1n} sats, one under the floor:`);
      say(`  ${under.ok ? 'PAID - which it must not be' : 'not sent: ' + under.why.slice(0, 96)}`);
      if (under.ok) problems.push('a sub-floor payout was broadcast');
      const row2 = round.payout(rid2);
      say(`  the round records ${row2.owedSats} sats owed to ${row2.owedCount} player(s), state ${row2.state}`);
      if (row2.owedSats !== floor - 1n) problems.push('the debt was not written down');
    }

    say('');
    if (problems.length) {
      for (const p of problems) console.error('  ' + p);
      console.error(`payout on regtest: ${problems.length} problem(s)`);
      process.exitCode = 1;
    } else {
      say('payout on regtest: five of seven paid the winner out of the pool and consensus took it.');
      say('four could not, and the sats are on the player\'s own key.');
    }
  } finally {
    if (KEEP) { say(`\nleft running, --keep: ${dir}`); return; }
    say('\nstopping bitcoind.');
    try { sh(join(BITCOIN, 'bitcoin-cli'), [...btcArgs, 'stop']); } catch { /* not running */ }
    await new Promise((r) => setTimeout(r, 3000));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    say('stopped, and the scratch datadir is gone. No testnet or mainnet datadir was touched.');
  }
}

await main();
