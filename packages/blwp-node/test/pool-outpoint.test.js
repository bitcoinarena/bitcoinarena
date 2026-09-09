// WHICH BITCOIN OUTPUT A PAYOUT SPENDS, AND WHO GETS TO SAY.
//
// Item 17 put the signing on a wire: the asker names a round and an OUTPUT, and
// every seat rebuilds the transaction from its own store before it signs. What
// it did not ask is where that output comes from. `payWithCommittee` takes a
// `utxo` - txid, vout, value and script - as an argument, and nothing in the
// daemon can produce one: no `scantxoutset`, no `gettxout`, no `listunspent`
// anywhere in `src/`, and `chainSpend` can only `send` bytes and `look` up a
// txid it already has. So a closed round stops at PAYOUT_QUEUED and the winner
// is paid by a test handing the daemon an outpoint.
//
// This file is the measurement before that is fixed. It writes down what the
// asker can and cannot do with the four fields it names today, and the answer
// is not the one this letter was opened on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';

import { PoolSigning } from '../src/pool-signing.js';
import { poolOutput } from '../../protocol/src/pool.js';
import { payoutOutputs, winnings } from '../../protocol/src/payout-spend.js';
import { tapSighash } from '../../protocol/src/bond-spend.js';
import { aggregate340 } from '../../protocol/src/frost-bip340.js';
import { tableFor } from '../src/payout-table.js';
import { SHARES_NEEDED } from '../../protocol/src/shares.js';
import {
  committee, dealThePool, signWith, signingEntries, rand, b32, curve, POOL_SATS,
} from './pool-fixture.js';

/**
 * WHAT THE DAEMON CAN ASK THE CHAIN, counted rather than remembered.
 *
 * The row for this letter says the daemon watches nothing. That is a claim
 * about the source, so it is checked against the source: a call that could
 * find an output appearing in `src/` should turn this red and make somebody
 * update the letter rather than leave it stale.
 */
test('one file asks the chain about outputs, and nothing calls the payer yet', () => {
  const src = readdirSync(new URL('../src/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ f, text: readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8') }));

  // THE COUNT WAS ZERO WHEN THIS FILE WAS WRITTEN and `pool-watch.js` is the
  // one that changed it. Pinned as a LIST rather than a count: a second file
  // learning to ask the chain about outputs is a second place for the rule
  // "the value is the chain's" to be got wrong, and it should turn this red.
  const finders = src.filter((s) => /scantxoutset|listunspent|gettxout\b|getrawtransaction/.test(s.text));
  assert.deepEqual(finders.map((s) => s.f), ['pool-watch.js'],
    'a second file in src/ now asks the chain about outputs - one of them is the wrong one');

  // A CALL SITE, NOT A MENTION. Grepping the name counts the comment in
  // `pool-watch.js` that explains why this letter exists, which is a sentence
  // and not a caller. A call is the name on an object.
  const callers = src.filter((s) => /\.payWithCommittee\s*\(/.test(s.text));
  assert.deepEqual(callers.map((s) => s.f), [],
    'payWithCommittee has a caller in src/ now - update the letter');
  const defs = (src.find((s) => s.f === 'payout.js').text.match(/\bpayWithCommittee\s*\(/g) || []).length;
  assert.equal(defs, 1, `payWithCommittee is written ${defs} times in payout.js, so one of them is a caller`);
  console.log('  callers of payWithCommittee in src/: 0');
  console.log('  files in src/ that can find an output: 1 (pool-watch.js)');
});

/**
 * THE OUTPUTS DO NOT DEPEND ON THE VALUE THE ASKER NAMES, and that is worth
 * writing down before anybody builds a defence against a theft that cannot
 * happen this way.
 *
 * `payoutOutputs` pays each row its own sats and makes NO CHANGE OUTPUT: what
 * is left over is the fee, by subtraction on the chain rather than by a field.
 * So a lying value moves no output by a satoshi. What it does move is the
 * SIGHASH - BIP-341 hashes every prevout amount into it - so the signature the
 * committee produces is a signature over an input that does not exist, and the
 * one thing an asker can do with a false value is waste a signing round.
 */
test('a false value moves no output and burns nothing, because the amount is in the sighash', () => {
  const c = committee();
  const five = c.seats.slice(0, SHARES_NEEDED);

  const entries = signingEntries(c.rounds[0], c.rid);
  const table = tableFor({ roundId: c.rid, entries, minScore: c.minScore }).table;
  const owed = winnings({ table, stakes: entries.map((e) => ({ pubkey: e.pubkey, stakeMsat: e.stakeMsat })) });

  const honest = payoutOutputs({ rows: owed.rows, poolSats: POOL_SATS });
  const understated = payoutOutputs({ rows: owed.rows, poolSats: POOL_SATS / 4n });
  assert.equal(honest.ok, true, honest.why);
  assert.equal(understated.ok, true, understated.why);

  // THE NUMBER THIS LETTER WAS OPENED ON: how many sats a false value can send
  // to the miner that an honest one would not.
  assert.deepEqual(understated.outputs, honest.outputs,
    'an understated pool value changed what the winners are paid');
  const burn = understated.outputs.reduce((s, o) => s + o.value, 0n)
    - honest.outputs.reduce((s, o) => s + o.value, 0n);
  console.log(`  sats a false pool value can burn: ${burn < 0n ? -burn : burn}`);
  assert.equal(burn, 0n);
  console.log(`  the fee it REPORTS moves: honest ${honest.feeSats} sats, understated ${understated.feeSats} sats`
    + ' - a number in a return value, not an output in a transaction');

  // AND THE SIGNATURE IS OVER AN INPUT THAT DOES NOT EXIST. Five seats sign a
  // spend of the pool at a value the chain does not hold, and the signature
  // does not verify against the sighash of the real one.
  const lying = { ...c.utxo, value: POOL_SATS / 4n };
  const { commitments, shares } = signWith(five, { rid: c.rid, contract: c.contract, utxo: lying });
  const spend = five[0].spendFor({ roundId: c.rid, utxo: lying, contract: c.contract });
  assert.equal(spend.ok, true, spend.why);
  const sig = aggregate340({
    commitments, message: spend.sighash, groupPublicKey: spend.groupPublicKey, shares, curve,
  });
  assert.ok(schnorr.verify(sig.signature, spend.sighash, c.out.outputKey),
    'the five did not even agree with each other');

  const real = tapSighash({
    inputs: spend.inputs,
    prevouts: [{ value: POOL_SATS, script: c.out.script }],
    outputs: spend.outputs, inputIndex: 0,
  });
  assert.notDeepEqual(spend.sighash, real, 'the amount is not in the sighash after all');
  assert.equal(schnorr.verify(sig.signature, real, c.out.outputKey), false,
    'a signature taken over a false amount verified against the real output');
  console.log('  a signing round at a false value produces a signature the real output refuses');
});

/**
 * THE HOLE THAT IS REAL: TWO ROUNDS, ONE OUTPOINT, TWO SIGNATURES.
 *
 * A pool is dealt once and many rounds settle out of it, and a seat's memory of
 * what it has signed is per ROUND - `PoolSigning#live` is keyed by round id.
 * Nothing anywhere remembers which OUTPOINT a committee has already signed
 * away. So the same output can be signed twice, for two different sets of
 * winners, and both transactions are valid on their face: whichever reaches a
 * miner first pays its round and the other is a double spend that will never
 * confirm - while its own row says the payout was sent.
 *
 * Measured here as what it is - two verifying signatures over one outpoint -
 * and put in front of a real chain in `tools/`.
 */
test('two rounds sign spends of the same pool output, and nothing refuses', () => {
  const dealt = dealThePool();
  const a = committee({ dealt });
  const b = committee({ dealt });
  assert.notDeepEqual(a.rid, b.rid, 'the fixture built one round twice');
  assert.deepEqual(a.out.outputKey, b.out.outputKey, 'the two rounds are not on one pool');

  // ONE output. Both rounds are asked to spend it.
  const utxo = { txid: b32(0xab), vout: 0, value: POOL_SATS, script: a.out.script };

  const signRound = (c) => {
    const five = c.seats.slice(0, SHARES_NEEDED);
    const { commitments, shares } = signWith(five, { rid: c.rid, contract: c.contract, utxo });
    const spend = five[0].spendFor({ roundId: c.rid, utxo, contract: c.contract });
    const sig = aggregate340({
      commitments, message: spend.sighash, groupPublicKey: spend.groupPublicKey, shares, curve,
    });
    return { spend, sig };
  };

  const first = signRound(a);
  const second = signRound(b);

  assert.ok(schnorr.verify(first.sig.signature, first.spend.sighash, a.out.outputKey));
  assert.ok(schnorr.verify(second.sig.signature, second.spend.sighash, b.out.outputKey));
  assert.notDeepEqual(first.spend.sighash, second.spend.sighash,
    'the two rounds built the same transaction, so this proves nothing');
  assert.notDeepEqual(first.spend.outputs, second.spend.outputs,
    'the two rounds pay the same winners, so this proves nothing');

  console.log(`  round A signs ${first.spend.outputs.length} output(s) spending `
    + `${Buffer.from(utxo.txid).toString('hex').slice(0, 16)}…:${utxo.vout}`);
  console.log(`  round B signs ${second.spend.outputs.length} output(s) spending the SAME outpoint`);
  console.log('  seats that refused the second: 0');
});
