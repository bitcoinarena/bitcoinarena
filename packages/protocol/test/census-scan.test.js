// 5A.4 STEP 1, SCAN: the chain says where an output was and whether it is
// still there - not the party handing the census over.
//
// "SCAN all outputs created at or before census_height whose script matches
// the bond template (5A.3B) and that are unspent at census_height with >=
// census_confirmations depth."
//
// `buildCensus` applied three of those four already - to fields the CALLER
// supplied. That is the whole difference this file is about: a census used to
// be a bag of entries somebody asserted heights and spends for, and now both
// come off the blocks, so a publisher who lies about either is caught by
// anyone holding the same chain.
//
// The fourth conjunct - finding which outputs are bonds at all - needs
// BOND_MARKER, which is `null` in this protocol by a recorded decision, so the
// candidate outpoints come in from the advertisements a node already holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { parseTransaction } from '../src/tx.js';
import { BOND_MARKER, bondMarker } from '../src/constants.js';
import { bondTransaction } from '../tools/bond.js';
import { scanCensus, censusRootMatchesRound, censusInputsId } from '../src/census.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (n) => ({
  nodePubkey: b32(n), operatorId: 'operator', protocolVersions: [1], roles: ['game'],
  endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), timestamp: 1788700000000n,
});
const bondOf = (n) => bondTransaction(advertFor(n), { previousTxid: b32(0xa0 + n), previousVout: 0 });

/** A spend of one outpoint, so a block can retire a bond. */
const spendOf = (txid, vout) => bondTransaction(advertFor(0x50), {
  previousTxid: txid, previousVout: vout,
});

const HEIGHT = 900000;
const depth = { minConfirmations: 6, tipHeight: 900010 };

function chainOf() {
  const bonds = [bondOf(0x11), bondOf(0x12), bondOf(0x13)];
  const ids = bonds.map((b) => parseTransaction(b).txid);
  return {
    bonds,
    ids,
    blocks: [
      { height: HEIGHT - 20, transactions: [bonds[0]] },
      { height: HEIGHT - 10, transactions: [bonds[1], bonds[2]] },
    ],
    candidates: ids.map((txid, i) => ({
      txid, vout: 0, pubkey: b32(0x11 + i), bondSats: 60000n, roles: ['game'],
    })),
  };
}

test('BOND_MARKER is unchosen, which is why the candidates come in', () => {
  assert.equal(BOND_MARKER, null,
    'a plausible address written here would settle a genesis parameter by accident');
  assert.throws(() => bondMarker(), /has not been chosen/);
});

/**
 * THE HEIGHT AND THE SPEND COME OFF THE BLOCKS. A caller can assert neither.
 */
test('scan reads each outpoint\'s height out of the chain, not out of the entry', () => {
  const { blocks, candidates } = chainOf();
  const seen = scanCensus(blocks, { censusHeight: HEIGHT, ...depth, candidates });

  assert.equal(seen.entries.length, 3);
  assert.equal(seen.entries[0].height, HEIGHT - 20);
  assert.equal(seen.entries[1].height, HEIGHT - 10);
  assert.equal(seen.entries[2].height, HEIGHT - 10);
  for (const e of seen.entries) assert.equal(e.spent, false);

  // a caller asserting another height changes nothing: the chain is asked
  const lying = candidates.map((c) => ({ ...c, height: 1, spent: true }));
  const again = scanCensus(blocks, { censusHeight: HEIGHT, ...depth, candidates: lying });
  assert.equal(again.entries[0].height, HEIGHT - 20, 'a claimed height was believed');
  assert.equal(again.entries[0].spent, false, 'a claimed spend was believed');
});

test('an outpoint the chain does not carry is named, not silently dropped', () => {
  const { blocks, candidates } = chainOf();
  const invented = [...candidates, { txid: b32(0x77), vout: 0, pubkey: b32(0x77), bondSats: 1n, roles: ['game'] }];
  const seen = scanCensus(blocks, { censusHeight: HEIGHT, ...depth, candidates: invented });

  assert.equal(seen.entries.length, 3);
  assert.equal(seen.missing.length, 1);
  assert.match(seen.missing[0].why, /no such outpoint at or before that height/,
    'a census that quietly lost a bond and one that never had it look the same from the root');
});

/**
 * A SPENT BOND IS OUT, and the spend is read from the chain too. 5A.3B: "a
 * spend of that output is itself a complete, portable proof" - here it is
 * simply the block that carries it.
 */
test('a bond spent at or before the census height is not in the census', () => {
  const { ids, blocks, candidates } = chainOf();
  const withSpend = [...blocks,
    { height: HEIGHT - 5, transactions: [spendOf(ids[1], 0)] }];

  const seen = scanCensus(withSpend, { censusHeight: HEIGHT, ...depth, candidates });
  assert.equal(seen.entries.find((e) => toHex(e.txid) === toHex(ids[1])).spent, true);
  assert.equal(seen.census.entries.length, 2, 'the spent bond still counted');

  // and a spend AFTER the census height is not this census's business
  const later = [...blocks,
    { height: HEIGHT + 1, transactions: [spendOf(ids[1], 0)] }];
  const after = scanCensus(later, { censusHeight: HEIGHT, ...depth, candidates });
  assert.equal(after.census.entries.length, 3,
    'a block later than the census is a block the census did not see');
});

/**
 * "AT OR BEFORE census_height" INCLUDES THE CENSUS BLOCK ITSELF. Found by a
 * mutant that survived: every block in the fixture was strictly earlier, so
 * `>` and `>=` were indistinguishable and a census could have silently dropped
 * every bond funded in its own block.
 */
test('a bond funded in the census block itself is in the census', () => {
  const { blocks, candidates } = chainOf();
  const atHeight = bondOf(0x15);
  const atId = parseTransaction(atHeight).txid;

  const seen = scanCensus([...blocks, { height: HEIGHT, transactions: [atHeight] }], {
    censusHeight: HEIGHT, minConfirmations: 1, tipHeight: HEIGHT + 1,
    candidates: [...candidates, { txid: atId, vout: 0, pubkey: b32(0x15), bondSats: 60000n, roles: ['game'] }],
  });
  assert.equal(seen.missing.length, 0, 'the census block itself was skipped');
  assert.equal(seen.entries.find((e) => toHex(e.txid) === toHex(atId)).height, HEIGHT);
});

/**
 * AND AN OUTPOINT IS A TXID AND A VOUT. Another survivor: every candidate in
 * the fixture sat at vout 0, so indexing every output under `:0` looked
 * correct - and a bond at vout 1 would have been read as the output beside it.
 */
test('an outpoint is the txid AND the vout', () => {
  const { blocks, ids, candidates } = chainOf();

  // a bond transaction has two outputs: the bond and the OP_RETURN commitment
  const atOne = scanCensus(blocks, {
    censusHeight: HEIGHT, ...depth,
    candidates: [{ txid: ids[0], vout: 1, pubkey: b32(0x11), bondSats: 60000n, roles: ['game'] }],
  });
  assert.equal(atOne.entries.length, 1);
  assert.equal(atOne.entries[0].vout, 1, 'vout 1 was read as some other output');

  // and a vout the transaction does not have is missing, not invented
  const beyond = scanCensus(blocks, {
    censusHeight: HEIGHT, ...depth,
    candidates: [{ txid: ids[0], vout: 9, pubkey: b32(0x11), bondSats: 60000n, roles: ['game'] }],
  });
  assert.equal(beyond.entries.length, 0);
  assert.equal(beyond.missing.length, 1);

  // the two vouts of one transaction are two different entries
  const both = scanCensus(blocks, {
    censusHeight: HEIGHT, ...depth,
    candidates: [
      { txid: ids[0], vout: 0, pubkey: b32(0x11), bondSats: 60000n, roles: ['game'] },
      { txid: ids[0], vout: 1, pubkey: b32(0x11), bondSats: 60000n, roles: ['game'] },
    ],
  });
  assert.equal(both.census.entries.length, 2, 'one outpoint swallowed the other');
});

test('a bond created after the census height is not in it either', () => {
  const { blocks, candidates } = chainOf();
  const late = bondOf(0x14);
  const lateId = parseTransaction(late).txid;
  const withLate = [...blocks, { height: HEIGHT + 2, transactions: [late] }];

  const seen = scanCensus(withLate, {
    censusHeight: HEIGHT, ...depth,
    candidates: [...candidates, { txid: lateId, vout: 0, pubkey: b32(0x14), bondSats: 60000n, roles: ['game'] }],
  });
  assert.equal(seen.entries.length, 3);
  assert.equal(seen.missing.length, 1, 'an output the census height never saw was counted');
});

test('a bond too shallow at the tip is not in the census', () => {
  const { blocks, candidates } = chainOf();
  const shallow = scanCensus(blocks, {
    censusHeight: HEIGHT, minConfirmations: 6, tipHeight: HEIGHT - 8, candidates,
  });
  // the block at HEIGHT-10 is 3 deep at a tip of HEIGHT-8, the one at -20 is 13
  assert.equal(shallow.census.entries.length, 1, 'a shallow bond was counted');
  assert.equal(shallow.census.entries[0].height, HEIGHT - 20);
});

/**
 * AND THE WHOLE POINT: a census SCANNED from the chain satisfies the root a
 * contract names when the chain really holds that set, and does not when it
 * does not.
 */
test('a scanned census matches the published root, and a different chain does not', () => {
  const { ids, blocks, candidates } = chainOf();
  const scanned = scanCensus(blocks, { censusHeight: HEIGHT, ...depth, candidates });

  const contract = { censusHeight: HEIGHT, censusRoot: scanned.census.root };
  const boundTo = censusInputsId({ censusHeight: HEIGHT, ...depth, entries: scanned.entries });
  const ok = censusRootMatchesRound(contract, { entries: scanned.entries, ...depth, boundTo });
  assert.equal(ok.ok, true, ok.why);

  // the same contract against a chain where one bond was spent: a different
  // census, so the root it names is no longer the one the chain derives to
  const spent = scanCensus([...blocks, { height: HEIGHT - 5, transactions: [spendOf(ids[1], 0)] }],
    { censusHeight: HEIGHT, ...depth, candidates });
  const no = censusRootMatchesRound(contract, {
    entries: spent.entries, ...depth,
    boundTo: censusInputsId({ censusHeight: HEIGHT, ...depth, entries: spent.entries }),
  });
  assert.equal(no.ok, false, 'a contract stood against a chain that no longer holds its census');
  assert.match(no.why, /censusRoot/);
  assert.notEqual(toHex(spent.census.root), toHex(scanned.census.root));
});

test('scan refuses to work on nothing rather than inventing a census', () => {
  const { blocks, candidates } = chainOf();
  assert.throws(() => scanCensus(undefined, { censusHeight: HEIGHT, ...depth, candidates }),
    /needs blocks/);
  assert.throws(() => scanCensus(blocks, { censusHeight: HEIGHT, ...depth }),
    /needs the outpoints/);
  assert.throws(() => scanCensus(blocks, { ...depth, candidates }), /needs a census height/);
  assert.throws(() => scanCensus([{ transactions: [] }], { censusHeight: HEIGHT, ...depth, candidates }),
    /a block names its height/);
});
