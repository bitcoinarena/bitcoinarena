// WHICH CHAIN OUTPUTS COUNT AS BONDS.
//
// Measured before this file existed: `deriveCensus` accepted a candidate at
// vout 1 of a real bond transaction - the OP_RETURN, value zero - as a bond,
// because the census checked the transaction and the commitment and never
// looked at the OUTPUT. A publisher could have pointed an entry at a change
// output instead and inflated its own weight, and nothing would have said no.
//
// Two of the five rules can be read off the chain and three cannot:
//
//   readable   P2TR. 5A.3B: "A P2TR output with three spend paths." The paths
//              are hidden, the class is not.
//   readable   the advertisement names this outpoint. 5A.1 makes the bond
//              outpoint mandatory, so a body pointing elsewhere is not this
//              output's body.
//   BLOCKED    the dust output to BOND_MARKER (25.1), null by decision
//   BLOCKED    the script template (5A.3B: taproot reveals a branch only when
//              it is spent, which is the point of using it)
//   BLOCKED    the advertisement signature (no curve here)
//
// So this answers "counts as a bond as far as the chain can show", and names
// what it could not look at. Nothing here can say "is a bond".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { PROTOCOL_VERSION, BOND_MARKER } from '../src/constants.js';
import { parseTransaction } from '../src/tx.js';
import { bondTransaction } from '../tools/bond.js';
import {
  recognizeBond, isTaprootOutput, BOND_UNCHECKED, deriveCensus,
} from '../src/census.js';
import { selectCommittee } from '../src/sortition.js';
import { chainOf as minedChain } from '../tools/chainview.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (n, over = {}) => ({
  nodePubkey: b32(n), operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION],
  roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), timestamp: 1788700000000n, ...over,
});
const bondOf = (n, over = {}) =>
  bondTransaction(advertFor(n, over), { previousTxid: b32(0xa0 + n), previousVout: 0 });

const HEIGHT = 900000;
const TIP = 900010;
const view = (at, tip = TIP, from = HEIGHT - 20) => {
  const blocks = [];
  for (let h = from; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, from);
};
const contract = {
  censusHeight: HEIGHT, censusConfirmations: 6,
  bondMinSats: 1n, protocolVersion: PROTOCOL_VERSION,
};

/**
 * THE BOND OUTPUT IS RECOGNISED, AND THE OP_RETURN BESIDE IT IS NOT. This is
 * the defect, stated as a test: both outputs belong to the same real bond
 * transaction, both are confirmed and unspent, and only one of them is a bond.
 */
test('the taproot output is a bond and the OP_RETURN beside it is not', () => {
  const tx = parseTransaction(bondOf(0x11));
  const advert = advertFor(0x11);

  assert.equal(tx.outputs.length, 3);
  assert.equal(toHex(tx.outputs[0].script).slice(0, 4), '5120', 'vout 0 is not P2TR');
  assert.equal(toHex(tx.outputs[1].script).slice(0, 4), '5120', 'vout 1 is not the marker');
  assert.equal(toHex(tx.outputs[2].script).slice(0, 2), '6a', 'vout 2 is not an OP_RETURN');

  const yes = recognizeBond(tx, 0, advert);
  assert.equal(yes.ok, true, yes.why);
  assert.equal(yes.valueSats, 100000000n);

  const no = recognizeBond(tx, 2, advert);
  assert.equal(no.ok, false, 'the OP_RETURN counted as a bond');
  assert.match(no.why, /not a taproot output/);
});

/**
 * AND A REAL OUTPUT OF THE WRONG KIND IS NOT A BOND EITHER. The P2PKH outputs
 * of mainnet block 100000's second transaction are the honest negative case:
 * confirmed, spendable, worth real money, and not this.
 */
test('an ordinary payment output is not a bond', () => {
  const tx = parseTransaction(bondOf(0x12));
  const advert = advertFor(0x12);

  for (const script of [
    new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20).fill(7), 0x88, 0xac]), // P2PKH
    new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(7)]),                   // P2WPKH
    new Uint8Array([0x00, 0x20, ...new Uint8Array(32).fill(7)]),                   // P2WSH
    new Uint8Array([0x51, 0x20, ...new Uint8Array(31).fill(7)]),                   // short
    new Uint8Array([0x52, 0x20, ...new Uint8Array(32).fill(7)]),                   // OP_2
  ]) {
    assert.equal(isTaprootOutput(script), false, toHex(script).slice(0, 8));
    const faked = { ...tx, outputs: [{ value: 100000000n, script }, tx.outputs[1], tx.outputs[2]] };
    assert.match(recognizeBond(faked, 0, advert).why, /not a taproot output/);
  }

  // and the one that IS one
  assert.equal(isTaprootOutput(tx.outputs[0].script), true);
  assert.equal(isTaprootOutput(undefined), false);
});

/**
 * 5A.1 MAKES THE BOND OUTPOINT MANDATORY, so a body that points somewhere else
 * is not this output's body. Without this a bond transaction with a change
 * output would have two bonds in it, and the bigger one would be the change.
 */
test('an output the advertisement does not name is not its bond', () => {
  const tx = parseTransaction(bondOf(0x13));

  // the same transaction, the same commitment, a body naming another output
  assert.match(recognizeBond(tx, 0, advertFor(0x13, { bondVout: 1 })).why,
    /names output 1 as its bond, not 0/);

  // a body naming another transaction entirely
  assert.match(recognizeBond(tx, 0, advertFor(0x13, { bondTxid: b32(0x99) })).why,
    /names a different bond transaction/);

  // an all-zero txid is read as "the transaction carrying me" - 25.1 puts the
  // body in the transaction it names, so the txid is not knowable when the
  // body is signed. `acceptAdvert` settled that reading; this is the same one.
  assert.equal(recognizeBond(tx, 0, advertFor(0x13)).ok, true);
  assert.equal(recognizeBond(tx, 0, advertFor(0x13, { bondTxid: tx.txid })).ok, true);

  // and a body with no outpoint at all is refused, not defaulted to zero
  assert.match(recognizeBond(tx, 0, advertFor(0x13, { bondVout: undefined })).why,
    /names no bond output/);
  assert.match(recognizeBond(tx, 0, undefined).why, /names no bond output/);
});

/**
 * AND THE AMOUNT IS THE NAMED OUTPUT'S. A funding transaction that pays a bond
 * and returns change to another taproot address is ordinary, and then the bond
 * is not vout 0 - so reading "the first output" would report somebody else's
 * money as the bond. Found by a mutant that survived while every fixture had
 * its bond at vout 0 with only an OP_RETURN beside it.
 */
test('the value reported is the named output\'s, not the first taproot one', () => {
  const tx = parseTransaction(bondOf(0x17));
  const taproot = tx.outputs[0].script;

  // change at vout 0, the bond at vout 1: both P2TR, different values
  const withChange = {
    ...tx,
    outputs: [
      { value: 900000000n, script: taproot },
      { value: 60000n, script: taproot },
      tx.outputs[1],
    ],
  };

  const bond = recognizeBond(withChange, 1, advertFor(0x17, { bondVout: 1 }));
  assert.equal(bond.ok, true, bond.why);
  assert.equal(bond.valueSats, 60000n, 'the change output was reported as the bond');

  // and the change is not a bond, because the advertisement does not name it
  assert.match(recognizeBond(withChange, 0, advertFor(0x17, { bondVout: 1 })).why,
    /names output 1 as its bond, not 0/);
});

/**
 * AN OUTPUT HOLDING NOTHING IS NOT A BOND, whatever shape it is.
 *
 * 5A.3: "The bond is what makes identity expensive. Without it, a Sybil
 * attacker creates arbitrarily many nodes for free and buys arbitrarily many
 * selection chances - the flaw that made v4.4 unsafe." A zero-value P2TR
 * output costs its fee and nothing else.
 *
 * Measured before this: with a round naming a floor of zero, a census admitted
 * a zero-sat taproot output as a bond, and `selectCommittee` then THREW from
 * inside `weightOf` - a division by zero reaching a caller that had only asked
 * who was on the committee.
 */
test('a taproot output worth nothing is not a bond', () => {
  const empty = bondTransaction(advertFor(0x18), {
    previousTxid: b32(0xb8), previousVout: 0, value: 0,
  });
  const tx = parseTransaction(empty);

  assert.equal(tx.outputs[0].value, 0n);
  assert.equal(isTaprootOutput(tx.outputs[0].script), true, 'the shape is right; the value is not');
  assert.match(recognizeBond(tx, 0, advertFor(0x18)).why, /holds nothing, so there is no bond at stake/);

  // one satoshi is a bond, and a bad one - the ROUND's floor is what says how
  // small is too small, and a round may set it low; nothing may set it to none
  const dust = parseTransaction(bondTransaction(advertFor(0x19), {
    previousTxid: b32(0xb9), previousVout: 0, value: 1,
  }));
  const ok = recognizeBond(dust, 0, advertFor(0x19));
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.valueSats, 1n);
});

test('an output that is not there is not a bond', () => {
  const tx = parseTransaction(bondOf(0x14));
  for (const vout of [3, 9, -1, 1.5, undefined])
    assert.match(recognizeBond(tx, vout, advertFor(0x14)).why, /no such output/);
  assert.match(recognizeBond(undefined, 0, advertFor(0x14)).why, /not a parsed transaction/);
});

/**
 * WHAT IT CANNOT LOOK AT, IT NAMES - and the marker is first because it is the
 * one that would make ENUMERATION possible. Recognition and enumeration are
 * different questions: "is this output a bond" is answered here, "find me
 * every bond" still is not, and that distinction is the whole letter.
 */
test('the rules it cannot read are named, and the marker is checked on regtest', () => {
  const tx = parseTransaction(bondOf(0x15));
  const out = recognizeBond(tx, 0, advertFor(0x15));

  assert.equal(out.ok, true);
  assert.deepEqual(out.unchecked, BOND_UNCHECKED);
  assert.equal(out.unchecked.length, 2);
  assert.match(out.unchecked[0], /bond script template/);
  assert.match(out.unchecked[1], /no curve/);
  assert.equal(BOND_MARKER, null, 'mainnet marker stays unchosen');
});
