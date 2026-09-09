// WHAT POST /entry TAKES, COUNTED - THE FEE AND THE STAKE.
//
// M3.3 item 20. `feeMatchesEntry` says an entry's fee must be exactly 2% of
// its stake: too little and the round collects less than the fee table will owe
// its nodes, too much and the excess is income no table allocates. It has ZERO
// CALLERS outside its own tests. Letter 15 made the PAGE write the right fee;
// this is the door that accepts them.
//
// AND THE FEE RULE ALONE DOES NOT CLOSE IT, which is why this file counts two
// matrices and not one. `feeMatchesEntry` is SELF-REFERENTIAL: it compares the
// entry's fee to the entry's OWN stake, and the entry names both. An entry
// claiming `stakeMsat: 0, feeMsat: 0` satisfies it perfectly - and
// `custody.hold` invoices `entry.stakeMsat`, so that player pays nothing, while
// `winnings` pays `amountMsat - stake`, so a zero stake is paid the whole table
// row out of other players' money. A door enforcing only the fee would look
// checked and still pass a free seat.
//
// This file is the measurement BEFORE the door is tightened. Every case below
// is accepted today; when item 20 lands, only the matching pair stands and the
// rest of this file says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeRoundContract, encodeEntryContract, roundId } from '../../protocol/src/contracts.js';
import { entryFeeMsat, feeMatchesEntry, NODE_FEE_BPS } from '../../protocol/src/fee.js';
import { MIN_ENTRY_WINDOW_MS } from '../../protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../protocol/src/genesis-ids.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const rand = (n) => new Uint8Array(randomBytes(n));
const NOW = 1788700000000;
const STAKE = 100000n;
const OWED = entryFeeMsat(STAKE);      // 2000

const contractFor = (nodes, stakeMsat = STAKE) => ({
  networkId: NETWORK_ID_REGTEST, configHash: b32(0x43), censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1),
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS,
  entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'BURN', donationSetId: b32(0xd0), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});

async function door(stakeMsat = STAKE) {
  const node = await serve(openStore(':memory:'), { port: 0, funded: () => true, now: () => NOW });
  const contract = contractFor([node.round.pubkey], stakeMsat);
  const rid = roundId(contract);
  const r = await fetch(`http://127.0.0.1:${node.port}/round`,
    { method: 'POST', body: encodeRoundContract(contract) });
  assert.equal(r.status, 201);
  const knock = async (stake, fee) => {
    const entry = {
      roundId: rid, playerPubkey: schnorr.getPublicKey(rand(32)),
      sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
      stakeCommitment: rand(32), stakeMsat: stake, feeMsat: fee, donationMsat: 0n,
      joinTick: 0, worldSecret: rand(32), vssSharesRef: new Uint8Array(32),
    };
    const said = await fetch(`http://127.0.0.1:${node.port}/entry`,
      { method: 'POST', body: encodeEntryContract(entry) });
    return { status: said.status, why: said.status === 201 ? '' : (await said.text()).trim() };
  };
  return { node, contract, rid, knock, close: () => node.close() };
}

/** The rate is one number and it is in the config a round is bound to. */
test('the fee is 2% and it comes from one place', () => {
  assert.equal(NODE_FEE_BPS, 200);
  assert.equal(entryFeeMsat(STAKE), 2000n, '2% of 100000 msat is 2000');
  assert.equal(entryFeeMsat(0n), 0n, '2% of nothing is nothing');
  // `genesis.js` writes NODE_FEE_BPS into the genesis parameters, so a round
  // naming a config has already committed to the rate. There is no second copy
  // to drift - checked in JS and in C#.
  console.log(`  the node fee is ${NODE_FEE_BPS} bps; on a ${STAKE} msat stake that is ${OWED} msat`);
});

/**
 * MATRIX ONE: THE FEE. Six knocks, and the door takes all six today.
 */
test('the door takes any fee at all', async () => {
  const d = await door();
  try {
    const cases = [
      [OWED, 'the right 2%'],
      [0n, 'no fee at all'],
      [OWED - 1n, 'one msat too little'],
      [OWED + 1n, 'one msat too much'],
      [OWED * 10n, 'ten times the fee'],
      [STAKE, 'the whole stake again'],
    ];
    let took = 0;
    for (const [fee, what] of cases) {
      const said = await d.knock(STAKE, fee);
      const rule = feeMatchesEntry({ stakeMsat: STAKE, feeMsat: fee });
      console.log(`  ${what.padEnd(22)} fee ${String(fee).padStart(7)}  door ${said.status}  `
        + `rule ${rule.ok ? 'stands' : 'no'}`);
      if (said.status === 201) took++;
    }
    assert.equal(took, cases.length,
      'the door refuses a fee now - item 20 has moved, update this pin');
    console.log(`  the door took ${took} of ${cases.length}, and the rule stands for 1 of them`);
  } finally { await d.close(); }
});

/**
 * MATRIX TWO: THE STAKE, AND IT IS WHY THE FEE RULE ALONE IS NOT ENOUGH.
 *
 * Every one of these satisfies `feeMatchesEntry` - the entry names its own
 * stake and pays 2% of THAT. A free seat is the one that matters: the hold is
 * for `entry.stakeMsat` and the payout is `amountMsat - stake`.
 */
test('the door takes any stake the entry names, including none', async () => {
  const d = await door();
  try {
    const cases = [
      [STAKE, entryFeeMsat(STAKE), 'the round\'s own stake'],
      [1n, entryFeeMsat(1n), 'a stake of one msat'],
      [0n, 0n, 'no stake at all - a free seat'],
      [STAKE * 1000n, entryFeeMsat(STAKE * 1000n), 'a thousand times the stake'],
    ];
    let took = 0;
    for (const [stake, fee, what] of cases) {
      const said = await d.knock(stake, fee);
      const rule = feeMatchesEntry({ stakeMsat: stake, feeMsat: fee });
      assert.equal(rule.ok, true, 'this matrix is meant to satisfy the 2% rule throughout');
      console.log(`  ${what.padEnd(28)} stake ${String(stake).padStart(9)} fee ${String(fee).padStart(7)}  `
        + `door ${said.status}  rule stands`);
      if (said.status === 201) took++;
    }
    assert.equal(took, cases.length,
      'the door refuses a stake now - item 20 has moved, update this pin');
    console.log(`  the door took ${took} of ${cases.length}, and every one satisfies the 2% rule`);
    console.log('  so a free seat passes the fee check - which is why the stake is on this letter');
  } finally { await d.close(); }
});
