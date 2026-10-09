// 5A.4 STEP 1, SCAN: the chain says where an output was and whether it is
// still there - not the party handing the census over.
//
// "SCAN all outputs created at or before census_height whose script matches
// the bond template (5A.3B) and that are unspent at census_height with >=
// census_confirmations depth."
//
// The commit step applied three of those four already - to fields the CALLER
// supplied. That is the whole difference this file is about: a census used to
// be a bag of entries somebody asserted heights and spends for, and now both
// come off the blocks, so a publisher who lies about either is caught by
// anyone holding the same chain.
//
// SCAN NOW APPLIES ITS OWN CONJUNCTS AND RETURNS NO ROOT. It used to hand back
// a `census` field, and that root had steps 2 and 3 of 5A.4 unrun - a census
// over nodes whose advertisements nobody had read. `deriveCensus` is the only
// place a root comes from; see `census-derive.test.js`.
//
// The fourth conjunct - finding which outputs are bonds at all - needs
// BOND_MARKER, which is `null` in this protocol by a recorded decision, so the
// candidate outpoints come in from the advertisements a node already holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { parseTransaction } from '../src/tx.js';
import { BOND_MARKER, bondMarker } from '../src/constants.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../src/genesis-ids.js';
import { bondTransaction } from '../tools/bond.js';
import { scanCensus } from '../src/census.js';
import { chainOf as minedChain } from '../tools/chainview.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (n, over = {}) => ({
  nodePubkey: b32(n), operatorId: 'operator', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  ...over,
});
const bondOf = (n) => bondTransaction(advertFor(n), { previousTxid: b32(0xa0 + n), previousVout: 0 });

/** A spend of one outpoint, so a block can retire a bond. */
const spendOf = (txid, vout) => bondTransaction(advertFor(0x50), {
  previousTxid: txid, previousVout: vout,
});

const HEIGHT = 900000;
const TIP = 900010;
// EVERY ROUND NAMES ITS NETWORK. A contract without one used to be answered
// with regtest's marker; it is refused now, so the fixtures say which chain
// they are on like a real contract does.
const round = (over = {}) => ({
  censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST, ...over,
});

/**
 * A REAL CHAIN, MINED. The census refuses a header whose hash misses its
 * target and a block whose transactions do not hash to the root its header
 * commits to, so a test cannot hand it a bag of blocks any more. `at` places
 * the given blocks at their heights and pads the rest so the view runs to
 * `tip` - a chain is contiguous or it is not a chain.
 */
const view = (at, tip = TIP, from = HEIGHT - 20) => {
  const blocks = [];
  for (let h = from; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, from);
};

function rig() {
  const bonds = [bondOf(0x11), bondOf(0x12), bondOf(0x13)];
  const ids = bonds.map((b) => parseTransaction(b).txid);
  return {
    bonds,
    ids,
    at: { [HEIGHT - 20]: [bonds[0]], [HEIGHT - 10]: [bonds[1], bonds[2]] },
    candidates: ids.map((txid, i) => ({
      txid, vout: 0, pubkey: b32(0x11 + i), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
    })),
  };
}

test('BOND_MARKER is set for regtest and testnet, not mainnet', () => {
  assert.equal(BOND_MARKER, null, 'mainnet is still unchosen');
  assert.equal(bondMarker('regtest').length, 32);
  assert.equal(bondMarker('testnet').length, 32);
  assert.notDeepEqual(bondMarker('regtest'), bondMarker('testnet'));
  assert.throws(() => bondMarker('mainnet'), /has not been chosen/);
  assert.throws(() => bondMarker(), /has not been chosen/);
});

/**
 * THE HEIGHT AND THE SPEND COME OFF THE BLOCKS. A caller can assert neither.
 */
test('scan reads each outpoint\'s height out of the chain, not out of the entry', () => {
  const { at, candidates } = rig();
  const seen = scanCensus(view(at), { contract: round(), candidates });

  assert.equal(seen.entries.length, 3);
  assert.equal(seen.entries[0].height, HEIGHT - 20);
  assert.equal(seen.entries[1].height, HEIGHT - 10);
  assert.equal(seen.entries[2].height, HEIGHT - 10);
  for (const e of seen.entries) assert.equal(e.spent, false);

  // a caller asserting another height changes nothing: the chain is asked
  const lying = candidates.map((c) => ({ ...c, height: 1, spent: true }));
  const again = scanCensus(view(at), { contract: round(), candidates: lying });
  assert.equal(again.entries[0].height, HEIGHT - 20, 'a claimed height was believed');
  assert.equal(again.entries[0].spent, false, 'a claimed spend was believed');
});

test('an outpoint the chain does not carry is named, not silently dropped', () => {
  const { at, candidates } = rig();
  const invented = [...candidates, { txid: b32(0x77), vout: 0, pubkey: b32(0x77), bondSats: 1n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }];
  const seen = scanCensus(view(at), { contract: round(), candidates: invented });

  assert.equal(seen.entries.length, 3);
  assert.equal(seen.excluded.length, 1);
  assert.match(seen.excluded[0].why, /no such outpoint between height \d+ and \d+/,
    'a census that quietly lost a bond and one that never had it look the same from the root');

  // AND THE REASON SAYS WHAT THIS VIEW KNOWS, not more. A window beginning
  // after a bond's funding block cannot tell "not in the chain" from "below
  // where I start", and it used to claim the first.
  assert.match(seen.excluded[0].why, /does not reach further back/);
});

/**
 * A SPENT BOND IS OUT, and the spend is read from the chain too. 5A.3B: "a
 * spend of that output is itself a complete, portable proof" - here it is
 * simply the block that carries it.
 */
test('a bond spent at or before the census height is not in the census', () => {
  const { ids, at, candidates } = rig();
  const withSpend = { ...at, [HEIGHT - 5]: [spendOf(ids[1], 0)] };

  const seen = scanCensus(view(withSpend), { contract: round(), candidates });
  assert.equal(seen.entries.length, 2, 'the spent bond still counted');
  assert.equal(seen.entries.find((e) => toHex(e.txid) === toHex(ids[1])), undefined);
  const out = seen.excluded.find((e) => toHex(e.txid) === toHex(ids[1]));
  assert.equal(out.spent, true);
  assert.match(out.why, /already spent at the census height/);

  // and a spend AFTER the census height is not this census's business
  const later = { ...at, [HEIGHT + 1]: [spendOf(ids[1], 0)] };
  const after = scanCensus(view(later), { contract: round(), candidates });
  assert.equal(after.entries.length, 3,
    'a block later than the census is a block the census did not see');
});

/**
 * "AT OR BEFORE census_height" INCLUDES THE CENSUS BLOCK ITSELF. Found by a
 * mutant that survived: every block in the fixture was strictly earlier, so
 * `>` and `>=` were indistinguishable and a census could have silently dropped
 * every bond funded in its own block.
 */
test('a bond funded in the census block itself is in the census', () => {
  const { at, candidates } = rig();
  const atHeight = bondOf(0x15);
  const atId = parseTransaction(atHeight).txid;

  const seen = scanCensus(view({ ...at, [HEIGHT]: [atHeight] }, HEIGHT + 1), {
    contract: round({ censusConfirmations: 1 }),
    candidates: [...candidates, { txid: atId, vout: 0, pubkey: b32(0x15), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }],
  });
  assert.equal(seen.excluded.length, 0, 'the census block itself was skipped');
  assert.equal(seen.entries.find((e) => toHex(e.txid) === toHex(atId)).height, HEIGHT);
});

/**
 * AND AN OUTPOINT IS A TXID AND A VOUT. Another survivor: every candidate in
 * the fixture sat at vout 0, so indexing every output under `:0` looked
 * correct - and a bond at vout 1 would have been read as the output beside it.
 */
test('an outpoint is the txid AND the vout', () => {
  const { at, ids, candidates } = rig();

  // a bond transaction has two outputs: the bond and the OP_RETURN commitment
  const atOne = scanCensus(view(at), {
    contract: round(),
    candidates: [{ txid: ids[0], vout: 1, pubkey: b32(0x11), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }],
  });
  assert.equal(atOne.entries.length, 1);
  assert.equal(atOne.entries[0].vout, 1, 'vout 1 was read as some other output');

  // and a vout the transaction does not have is missing, not invented
  const beyond = scanCensus(view(at), {
    contract: round(),
    candidates: [{ txid: ids[0], vout: 9, pubkey: b32(0x11), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }],
  });
  assert.equal(beyond.entries.length, 0);
  assert.equal(beyond.excluded.length, 1);

  // the two vouts of one transaction are two different entries
  const both = scanCensus(view(at), {
    contract: round(),
    candidates: [
      { txid: ids[0], vout: 0, pubkey: b32(0x11), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] },
      { txid: ids[0], vout: 1, pubkey: b32(0x11), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] },
    ],
  });
  assert.equal(both.entries.length, 2, 'one outpoint swallowed the other');
});

test('a bond created after the census height is not in it either', () => {
  const { at, candidates } = rig();
  const late = bondOf(0x14);
  const lateId = parseTransaction(late).txid;
  const withLate = { ...at, [HEIGHT + 2]: [late] };

  const seen = scanCensus(view(withLate), {
    contract: round(),
    candidates: [...candidates, { txid: lateId, vout: 0, pubkey: b32(0x14), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }],
  });
  assert.equal(seen.entries.length, 3);
  assert.equal(seen.excluded.length, 1, 'an output the census height never saw was counted');
});

test('a bond too shallow at the tip is not in the census', () => {
  const { at, candidates } = rig();

  // A BOND FUNDED IN THE CENSUS BLOCK ITSELF, at a tip of the census height:
  // one confirmation, where the round asks six. Depth is measured against the
  // chain's own tip now, so a shallow bond is made by funding it late rather
  // than by naming a tip below the census - which is refused, see below.
  const fresh = bondOf(0x16);
  const freshId = parseTransaction(fresh).txid;
  const shallow = scanCensus(view({ ...at, [HEIGHT]: [fresh] }, HEIGHT), {
    contract: round({ censusConfirmations: 6 }),
    candidates: [...candidates,
      { txid: freshId, vout: 0, pubkey: b32(0x16), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }],
  });

  assert.equal(shallow.entries.length, 3, 'a shallow bond was counted');
  assert.equal(shallow.excluded.length, 1);
  assert.match(shallow.excluded[0].why, /1 confirmations deep where this round needs 6/,
    'the rule that dropped it was not named');
});

/**
 * AND THE DEPTH RULE IS `>=`, AT THE BOUNDARY. Found by a mutant that survived:
 * the fixture was 3 deep against a floor of 6 and 13 deep against the same
 * floor, so nothing sat on the line and an off-by-one was invisible. A bond
 * EXACTLY `census_confirmations` deep is in - 5A.4 says ">= census_confirmations
 * depth" - and one confirmation short of it is out.
 */
test('a bond exactly deep enough is in, and one short of it is out', () => {
  const { at, candidates } = rig();
  const six = bondOf(0x17);
  const five = bondOf(0x18);
  const also = (tx, n) => ({
    txid: parseTransaction(tx).txid, vout: 0, pubkey: b32(n), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
  });

  // at a tip of HEIGHT, a bond funded at HEIGHT-5 is exactly 6 deep and one
  // funded at HEIGHT-4 is 5
  const seen = scanCensus(view({ ...at, [HEIGHT - 5]: [six], [HEIGHT - 4]: [five] }, HEIGHT), {
    contract: round({ censusConfirmations: 6 }),
    candidates: [...candidates, also(six, 0x17), also(five, 0x18)],
  });

  assert.equal(seen.entries.some((e) => e.pubkey[0] === 0x17), true,
    'a bond exactly at the floor was dropped');
  assert.equal(seen.entries.some((e) => e.pubkey[0] === 0x18), false,
    'a bond one confirmation short was counted');
  assert.equal(seen.excluded.length, 1);
  assert.match(seen.excluded[0].why, /5 confirmations deep where this round needs 6/);
});

/**
 * AND A CHAIN THAT ENDS BEFORE THE CENSUS HEIGHT IS NOT A SHALLOW CHAIN, IT IS
 * THE WRONG QUESTION. It used to be accepted, and the arithmetic answered with
 * "that output is -979 confirmations deep", which is not a depth.
 */
test('a chain that ends before the census height is refused, not counted backwards', () => {
  const { at, candidates } = rig();
  for (const tip of [HEIGHT - 1, HEIGHT - 8, HEIGHT - 20])
    assert.throws(() => scanCensus(view(at, tip), { contract: round(), candidates }),
      new RegExp(`ends at height ${tip}, before this round's census height ${HEIGHT}`),
      `a tip of ${tip} was accepted`);

  // and the census height itself is fine: the census is the chain UP TO it
  assert.equal(scanCensus(view(at, HEIGHT), { contract: round(), candidates }).entries.length, 3);
});

test('scan refuses to work on nothing rather than inventing a census', () => {
  const { at, candidates } = rig();
  assert.throws(() => scanCensus(undefined, { contract: round(), candidates }),
    /a chain view is at least one block/);
  // OMITTING THE LIST IS NOT NOTHING ANY MORE - it means "ask the chain", which
  // is what 5A.4 step 1 says a participant does. Handing something that is not
  // a list still throws: a caller who built one and got it wrong should hear
  // about it rather than have the chain quietly scanned instead.
  assert.equal(scanCensus(view(at), { contract: round() }).entries.length, 3);
  assert.throws(() => scanCensus(view(at), { contract: round(), candidates: null }),
    /takes the outpoints as a list/);
  assert.throws(() => scanCensus(view(at), { contract: round(), candidates: 'all of them' }),
    /takes the outpoints as a list/);
  assert.throws(() => scanCensus(view(at), { contract: {}, candidates }), /names no census height/);

  // AND A BAG OF BLOCKS IS NOT A CHAIN. What used to be the input is now
  // refused by name: no header means nothing was mined and nothing links.
  assert.throws(() => scanCensus({ blocks: [{ transactions: [] }], firstHeight: HEIGHT - 20 },
    { contract: round(), candidates }), /every block in a chain view carries its header/);
  assert.throws(() => scanCensus({ blocks: [] , firstHeight: HEIGHT }, { contract: round(), candidates }),
    /at least one block/);
  assert.throws(() => scanCensus({ blocks: view(at).blocks }, { contract: round(), candidates }),
    /says which height it starts at/);
});

/**
 * THE CENSUS FINDS THE BONDS ITSELF.
 *
 * 5A.4 step 1: "SCAN all outputs created at or before census_height whose
 * script matches the bond template". 25.1 answers "which nodes count?" with
 * "Bitcoin: bond outputs" - not "whatever list you were handed". Until now
 * this function threw unless somebody supplied the outpoints, so every census
 * in this tree was a census of a list somebody else made: a directory with
 * extra steps.
 *
 * The rule it walks by is 5A.2's own findability - the dust output to this
 * network's BOND_MARKER, "without it the census is unfindable in practice".
 */
test('SCAN finds the bonds by marker, without being handed the outpoints', () => {
  const { at, ids, candidates } = rig();

  // A DOZEN TRANSACTIONS THAT ARE NOT BONDS, in the same blocks: a coinbase,
  // ordinary spends, and transactions carrying no marker at all.
  const noise = [];
  for (let i = 0; i < 12; i++) {
    noise.push(bondTransaction(advertFor(0x90 + i), {
      previousTxid: b32(0x60 + i), previousVout: 0, network: 'regtest',
      commitment: b32(0xee),          // commits to an advertisement nobody carries
    }));
  }
  const noisy = {
    [HEIGHT - 20]: [...(at[HEIGHT - 20] || []), ...noise.slice(0, 6)],
    [HEIGHT - 10]: [...(at[HEIGHT - 10] || []), ...noise.slice(6)],
  };

  const seen = scanCensus(view(noisy), { contract: round() });
  assert.equal(seen.entries.length, 3,
    `expected the three bonds, got ${seen.entries.length}`);
  assert.deepEqual(seen.entries.map((e) => toHex(e.txid)).sort(),
    ids.map((t) => toHex(t)).sort(), 'the scan found something other than the bonds');

  // and what it found carries the outpoint, the key and the roles - off the
  // chain and the advertisement rather than off a caller's list.
  //
  // NOT THE AMOUNT. This used to assert `bondSats > 0`, which passed and meant
  // nothing: RESOLVE reads `output.valueSats` off the funding transaction and
  // overwrites the field before the floor is applied or a leaf is hashed, so
  // whatever the scan wrote there was never read. The scan no longer writes
  // one, and this says so, so putting one back is a failing test rather than a
  // number a later caller might trust.
  for (const e of seen.entries) {
    assert.equal(e.vout, 0);
    assert.equal('bondSats' in e, false, 'the scan is claiming an amount again');
    assert.deepEqual(e.roles, ['game']);
  }

  // THE SAME CENSUS, NOT A SECOND ONE: the self-found list and the handed-in
  // list end at the same entries.
  const handed = scanCensus(view(noisy), { contract: round(), candidates });
  assert.deepEqual(seen.entries.map((e) => toHex(e.txid)).sort(),
    handed.entries.map((e) => toHex(e.txid)).sort());
});

test('a transaction with no marker, or another network\'s marker, is not scanned', () => {
  const bonds = [bondOf(0x11)];
  const unmarked = bondTransaction(advertFor(0x21), {
    previousTxid: b32(0x71), previousVout: 0, marker: false,
  });
  const elsewhere = bondTransaction(advertFor(0x22), {
    previousTxid: b32(0x72), previousVout: 0, network: 'testnet',
  });

  const at = { [HEIGHT - 20]: [bonds[0], unmarked, elsewhere] };
  const seen = scanCensus(view(at), { contract: round() });

  assert.equal(seen.entries.length, 1, 'the scan took something that is not marked for this network');
  assert.deepEqual(seen.entries[0].pubkey, b32(0x11));
});

/**
 * AND THE MARKER IS THE ROUND'S NETWORK, NOT THIS BUILD'S FAVOURITE.
 *
 * Measured with a mutant: hardcoding 'regtest' in the scan left every test
 * above green, because every round above IS regtest. A round on another
 * network has to be the one that says so, or the marker check is decoration
 * that happens to agree with the fixtures.
 */
test("the round's own network decides which marker the scan looks for", () => {
  const here = bondTransaction(advertFor(0x31), {
    previousTxid: b32(0x73), previousVout: 0, network: 'testnet',
  });
  const elsewhere = bondTransaction(advertFor(0x32), {
    previousTxid: b32(0x74), previousVout: 0, network: 'regtest',
  });
  const at = { [HEIGHT - 20]: [here, elsewhere] };

  const seen = scanCensus(view(at), { contract: round({ networkId: NETWORK_ID_TESTNET4 }) });
  assert.equal(seen.entries.length, 1,
    'a testnet4 round scanned something marked for another chain');
  assert.deepEqual(seen.entries[0].pubkey, b32(0x31));
});

/**
 * A BODY THAT NAMES AN OUTPUT ITS OWN TRANSACTION DOES NOT HAVE.
 *
 * There is no outpoint there, so there is nothing to carry forward and
 * nothing to refuse: it is not a candidate. The mutant that reads output 0
 * whenever the named one is missing turns that into a phantom entry which
 * then gets excluded as "no such outpoint" - an invented outpoint, named.
 */
test('a marked transaction whose body names an output it does not have is no candidate', () => {
  const phantom = bondTransaction(advertFor(0x33, { bondVout: 9 }), {
    previousTxid: b32(0x75), previousVout: 0,
  });
  const at = { [HEIGHT - 20]: [bondOf(0x11), phantom] };

  const seen = scanCensus(view(at), { contract: round() });
  assert.equal(seen.entries.length, 1);
  assert.deepEqual(seen.entries[0].pubkey, b32(0x11));
  assert.equal(seen.excluded.some((e) => toHex(e.pubkey) === toHex(b32(0x33))), false,
    'the scan invented an outpoint for a vout that does not exist');
});

/**
 * DEPTH IS MEASURED AT THE CENSUS HEIGHT, NOT AT THE TIP.
 *
 * Found by a mutant that survived every test in this tree: `tipHeight` and
 * `censusHeight` were interchangeable here because no fixture put a bond in
 * the gap between them. They are not interchangeable. 5A.4 step 1 says
 * "unspent AT CENSUS_HEIGHT with >= census_confirmations depth", and the point
 * of "given census_height, every participant runs the same five steps" is that
 * the answer does not depend on when it is asked.
 *
 * Measured against the tip it did: this bond is two blocks under the census
 * and seven under a tip five blocks later, so one participant would count it
 * and another would not - the divergence 5A.2 exists to remove.
 */
test('a bond two blocks under the census stays shallow however far the tip has moved', () => {
  const fresh = bondOf(0x17);
  const at = { [HEIGHT - 20]: [bondOf(0x11)], [HEIGHT - 1]: [fresh] };
  const candidates = [
    { txid: parseTransaction(bondOf(0x11)).txid, vout: 0, pubkey: b32(0x11), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] },
    { txid: parseTransaction(fresh).txid, vout: 0, pubkey: b32(0x17), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] },
  ];

  for (const tip of [HEIGHT, HEIGHT + 5, HEIGHT + 50]) {
    const seen = scanCensus(view(at, tip), { contract: round(), candidates });
    assert.equal(seen.entries.length, 1,
      `at tip ${tip} the census took ${seen.entries.length} bonds, so its answer moved with the chain`);
    assert.deepEqual(seen.entries[0].pubkey, b32(0x11));
    const thin = seen.excluded.find((e) => toHex(e.pubkey) === toHex(b32(0x17)));
    assert.match(thin.why, /is 2 confirmations deep where this round needs 6/,
      `at tip ${tip} the depth was not the census's own`);
  }
});
