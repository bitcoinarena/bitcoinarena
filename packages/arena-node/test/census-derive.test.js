// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 5A.4, ALL FIVE STEPS, AND THE ONLY PLACE A CENSUS ROOT COMES FROM.
//
// "Given `census_height`, EVERY PARTICIPANT RUNS THE SAME FIVE STEPS."
//
// Measured before this file existed: the five steps never assigned. `scanCensus`
// returned a `census` field of its own, and that root was taken with steps 2
// and 3 unrun - so the shortest path through this package produced a census
// over nodes whose advertisements nobody had read. RESOLVE was a thing a
// caller might remember to do.
//
// And one field of the same hole: RESOLVE overrode the entry's ROLES with the
// advertisement's, and left its PUBKEY alone. The leaf hashes the pubkey, so a
// census over transcriptions could name a key that never bonded - and the
// committee seed, the receipts and the payout table all read that key
// afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { BOND, keyFor, bondFor } from './curve.js';
import { selectCommittee } from '../../arena-protocol/src/sortition.js';
import { recognizeBond } from '../../arena-protocol/src/chain.js';
import { PROTOCOL_VERSION } from '../../arena-protocol/src/constants.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import {
  deriveCensus, scanCensus, commitCensus, leafHash, censusRootMatchesRound, censusInputsId,
} from '../../arena-protocol/src/census.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (n, over = {}) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n, ...over,
});
// THE OUTPUT IS THE ONE GENESIS SAYS IT MUST BE. The fixtures used to leave
// the builder's filler key in place, which was invisible while nothing
// recomputed it; the composed census recomputes it now, so a fixture with a
// filler key is a fixture of a bond nobody posted.
const bondOf = (n, over = {}) =>
  bondTransaction(advertFor(n, over), {
    previousTxid: b32(0xa0 + n), previousVout: 0, outputKey: bondFor(keyFor(n)),
  });

const HEIGHT = 900000;
const TIP = 900010;
/** A mined chain from HEIGHT-20 to `tip`, with `at` placing transactions. */
const view = (at, tip = TIP, from = HEIGHT - 20) => {
  const blocks = [];
  for (let h = from; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, from);
};
const contract = {
  gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION,
  censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST,
};

/**
 * Three bonds in two blocks, and a resolver that hands back the funding
 * transaction the way a peer would.
 *
 * `claims` decides what the CANDIDATE says the node's key is. The default is a
 * transcription that is simply wrong for every entry: 0xEE, which is nobody.
 */
function rig({ claims = () => b32(0xEE), extraBlocks = {}, extraCandidates = [] } = {}) {
  const ns = [0x11, 0x12, 0x13];
  const bonds = new Map(ns.map((n) => [n, bondOf(n)]));
  const ids = new Map(ns.map((n) => [n, parseTransaction(bonds.get(n)).txid]));
  const byTxid = new Map([...bonds].map(([n, tx]) => [toHex(ids.get(n)), tx]));

  return {
    ns,
    ids,
    at: {
      [HEIGHT - 20]: [bonds.get(0x11)],
      [HEIGHT - 10]: [bonds.get(0x12), bonds.get(0x13)],
      ...extraBlocks,
    },
    candidates: [
      ...ns.map((n) => ({
        txid: ids.get(n), vout: 0, pubkey: claims(n), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['settlement'],
      })),
      ...extraCandidates,
    ],
    resolve: (e) => {
      const tx = byTxid.get(toHex(e.txid));
      return tx ? { transaction: tx } : null;
    },
  };
}

const derive = (r, over = {}) => deriveCensus(view(r.at), {
  candidates: r.candidates, contract, resolve: r.resolve, bond: BOND, ...over,
});

/**
 * THE FIVE STEPS ARE ONE CALL, and it ends in a root.
 */
test('one derivation scans, resolves, filters, sorts and commits', () => {
  const r = rig();
  const out = derive(r);

  assert.equal(out.ok, true, out.why);
  assert.equal(out.entries.length, 3);
  assert.equal(out.leaves.length, 3);
  assert.equal(out.root.length, 32);

  // sorted by outpoint, which is step 4 and cannot be ground
  const txids = out.entries.map((e) => toHex(e.txid));
  assert.deepEqual(txids, [...txids].sort(), 'the entries came back in some other order');

  // and the heights came off the blocks, which is step 1
  assert.deepEqual(
    out.entries.map((e) => e.height).sort((a, b) => a - b),
    [HEIGHT - 20, HEIGHT - 10, HEIGHT - 10],
  );
});

/**
 * THE HEADLINE: A CANDIDATE CLAIMING KEY X, AN ADVERTISEMENT DECLARING KEY Y,
 * AND A ROOT THAT NAMES Y.
 *
 * Same class as the roles override, one field over, and the field that matters
 * more: the leaf hashes this one.
 */
test('the leaf names the advertisement\'s key, not the candidate\'s', () => {
  const lying = rig({ claims: () => b32(0xEE) });
  const honest = rig({ claims: (n) => keyFor(n) });

  const a = derive(lying);
  const b = derive(honest);

  // every entry carries the key its own advertisement declared
  for (const e of a.entries) assert.deepEqual(e.pubkey, e.advert.nodePubkey);
  assert.deepEqual(a.entries.map((e) => toHex(e.pubkey)).sort(),
    [0x11, 0x12, 0x13].map((n) => toHex(keyFor(n))).sort());
  assert.equal(a.entries.some((e) => e.pubkey[0] === 0xEE), false,
    'the transcribed key reached the census');

  // so a wrong transcription does not move the root at all
  assert.equal(toHex(a.root), toHex(b.root),
    'what the candidate claimed about the key changed the root');

  // and the leaf a census over the transcription would have produced is a
  // different leaf, which is what makes the override load-bearing
  const asClaimed = leafHash({ ...a.entries[0], pubkey: b32(0xEE) });
  assert.notEqual(toHex(asClaimed), toHex(a.leaves[0]));
});

/**
 * The same override, for the roles, through the whole derivation rather than
 * through RESOLVE alone: the candidates all claim `settlement`, every
 * advertisement declares `game`.
 */
test('the roles in the census are the advertisement\'s too', () => {
  const out = derive(rig());
  for (const e of out.entries) assert.deepEqual(e.roles, ['game']);
});

/**
 * NO ROOT BEFORE RESOLVE. The old shortest path - scan, then root - is now a
 * refusal, because a scanned entry carries no advertisement id and only step 2
 * puts one there.
 */
test('a root cannot be taken over unresolved entries', () => {
  const r = rig();
  const scanned = scanCensus(view(r.at), { contract, candidates: r.candidates });

  assert.equal(scanned.census, undefined, 'scan handed back a root again');
  assert.throws(
    () => commitCensus(scanned.entries, { contract, view: view(r.at) }),
    /has not been resolved/,
    'a census root was taken over nodes nobody had read the advertisement of',
  );

  // and one entry short of resolved is still short: the guard is per entry
  const resolved = derive(r).entries;
  assert.throws(
    () => commitCensus([...resolved.slice(1), { ...resolved[0], advertId: undefined }],
      { contract, view: view(r.at) }),
    /has not been resolved/);
  assert.doesNotThrow(() => commitCensus(resolved, { contract, view: view(r.at) }));

  // and the guard is a COMMITMENT, not a flag: the advertisement id is
  // thirty-two bytes because it is a hash, so sixteen is not a short id, it is
  // not an id. A mutant that only checked the field existed survived here.
  assert.throws(
    () => commitCensus([{ ...resolved[0], advertId: new Uint8Array(16) }],
      { contract, view: view(r.at) }),
    /has not been resolved/);
});

/**
 * AND THE ID IS THE ADVERTISEMENT'S OWN. Another survivor: nothing checked
 * WHICH id RESOLVE handed on, so a placeholder would have satisfied the guard
 * and the derivation would have claimed a resolution it never did.
 */
test('the advertisement id a census carries is the one the bond committed to', () => {
  const out = derive(rig());
  for (const e of out.entries)
    assert.equal(toHex(e.advertId), toHex(advertId(e.advert)),
      'the census carries an advertisement id that is not the advertisement\'s');
  assert.notEqual(toHex(out.entries[0].advertId), toHex(new Uint8Array(32)));
});

/**
 * A NODE DROPPED AT EITHER STEP IS OUT OF THE ROOT, and the step that dropped
 * it is named. A node accused of publishing the wrong census has to be able to
 * point at the rule that removed a name.
 */
test('exclusions come back from both steps, each carrying its step', () => {
  const r = rig({ extraCandidates: [{ txid: b32(0x77), vout: 0, pubkey: b32(0x77), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }] });
  // 0x77 is on no chain at all -> scan drops it
  // and 0x13 resolves to a body nobody can retrieve -> resolve drops it
  const gone = toHex(r.ids.get(0x13));
  const out = deriveCensus(view(r.at), {
    candidates: r.candidates, contract, bond: BOND,
    resolve: (e) => (toHex(e.txid) === gone ? null : r.resolve(e)),
  });

  assert.equal(out.ok, true, out.why);
  assert.equal(out.entries.length, 2);
  assert.equal(out.entries.some((e) => toHex(e.txid) === gone), false);

  const steps = out.excluded.map((e) => e.step).sort();
  assert.deepEqual(steps, ['resolve', 'scan']);
  assert.match(out.excluded.find((e) => e.step === 'scan').why, /no such outpoint/);
  assert.match(out.excluded.find((e) => e.step === 'resolve').why, /could not be retrieved/);

  // and the root really is the root of what survived, not of what was asked for
  assert.equal(toHex(out.root),
    toHex(commitCensus(out.entries, { contract, view: view(r.at) }).root));
});

/**
 * A ROUND NAMING THE ROOT ITS OWN CHAIN DERIVES TO IS PLAYABLE, and the same
 * round against a chain that spent one of those bonds is not. This is the test
 * that used to live beside SCAN and check a root SCAN had no business taking.
 */
test('a derived census satisfies the round that names its root', () => {
  const r = rig();
  const out = derive(r);

  const round = { censusHeight: HEIGHT, censusConfirmations: 6, censusRoot: out.root };
  const boundTo = censusInputsId({ contract, view: view(r.at), entries: out.entries });
  const yes = censusRootMatchesRound(round, { entries: out.entries, view: view(r.at), boundTo });
  assert.equal(yes.ok, true, yes.why);

  // spend one bond before the census height and the chain derives elsewhere
  const spend = bondTransaction(advertFor(0x50), { previousTxid: r.ids.get(0x12), previousVout: 0 });
  const after = derive(rig({ extraBlocks: { [HEIGHT - 5]: [spend] } }));
  assert.equal(after.entries.length, 2);
  assert.notEqual(toHex(after.root), toHex(out.root));

  const no = censusRootMatchesRound(round, {
    entries: after.entries, view: view(r.at),
    boundTo: censusInputsId({ contract, view: view(r.at), entries: after.entries }),
  });
  assert.equal(no.ok, false, 'a round stood against a chain that no longer holds its census');
  assert.match(no.why, /censusRoot/);
});

/**
 * TWO PARTICIPANTS, THE SAME BLOCKS, THE SAME ROOT - including when the
 * candidates arrive in a different order, which is whatever order a node's
 * advertisements happened to reach it in.
 */
test('the order the candidates arrived in does not move the root', () => {
  const r = rig();
  const a = derive(r);
  const b = derive({ ...r, candidates: [...r.candidates].reverse() });
  assert.equal(toHex(a.root), toHex(b.root));
});

/**
 * THE DEPTH RULE IS THE ROUND'S, AND A CALLER CANNOT REACH IT.
 *
 * 5A.11: "The Round Contract contains: `census_height, census_confirmations`."
 * The height was already taken off the contract - `censusRootMatchesRound`
 * says so in its own comment - and the depth beside it was still an argument,
 * so a caller could recompute an honest census under a rule nobody signed up
 * to. The census picks the committee, so that was picking the committee.
 *
 * Measured with the contract HELD FIXED: passing a depth of 1 alongside
 * changes nothing, because there is no longer a parameter to pass. Moving the
 * ROUND's number does change it, which is what makes the field load-bearing.
 */
test('a caller cannot choose the confirmation depth; the round does', () => {
  const r = rig();
  const honest = derive(r);
  assert.equal(honest.entries.length, 3);

  // a caller trying the old argument, and every spelling of it
  for (const extra of [{ minConfirmations: 1 }, { censusConfirmations: 1 },
                       { minConfirmations: 999 }, { censusHeight: 1 }]) {
    const tried = deriveCensus(view(r.at), {
      contract, candidates: r.candidates, resolve: r.resolve, bond: BOND, ...extra,
    });
    assert.equal(tried.entries.length, honest.entries.length);
    assert.equal(toHex(tried.root), toHex(honest.root),
      `a caller passing ${Object.keys(extra)[0]} moved the census`);
  }

  // and the ROUND moving it does move the census: at 999 confirmations
  // nothing is deep enough, and the reason names the round's number
  const strict = derive(r, { contract: { ...contract, censusConfirmations: 999 } });
  assert.equal(strict.entries.length, 0);
  assert.notEqual(toHex(strict.root), toHex(honest.root));
  assert.match(strict.excluded[0].why, /where this round needs 999/);

  // the height and the depth now have the same owner, which was the point
  assert.match(derive(r, { contract: { ...contract, censusConfirmations: undefined } }).why,
    /names no confirmation depth/);
});

/**
 * And it answers rather than throwing, like everything else here: a caller
 * asking whether a census can be derived gets a reason, not an exception.
 */
test('a derivation it cannot do is refused with its reason', () => {
  const r = rig();

  assert.equal(deriveCensus(undefined, {
    candidates: r.candidates, contract, resolve: r.resolve,
  }).why, 'that census cannot be scanned: a chain view is at least one block');

  // a contract with nothing on it fails at the FIRST step that needs it, and
  // says which number it was missing rather than defaulting one
  const named = { networkId: NETWORK_ID_REGTEST };
  assert.match(derive(r, { contract: {} }).why, /cannot be scanned: that round names no census height/);
  assert.match(derive(r, { contract: { ...named, censusHeight: HEIGHT } }).why,
    /cannot be scanned: that round names no confirmation depth/);
  assert.match(derive(r, { contract: { ...named, censusHeight: HEIGHT, censusConfirmations: 6 } }).why,
    /names no bond floor/);
  // AND A ROUND THAT NAMES NO NETWORK IS ONE OF THOSE MISSING NUMBERS. It used
  // to be answered with the regtest marker on every chain.
  assert.match(derive(r, { contract: { censusHeight: HEIGHT, censusConfirmations: 6 } }).why,
    /cannot be scanned: that round names no network/);
  assert.match(derive(r, { resolve: undefined }).why, /no way to retrieve/);

  // a duplicate outpoint is the commit step's refusal, and it survives the trip
  const twice = { ...r, candidates: [...r.candidates, r.candidates[0]] };
  assert.match(derive(twice).why, /cannot be committed: duplicate outpoint/);
});

/**
 * What the derivation cannot check, it still names. Both walls are the
 * standing ones and neither is worked around here.
 */
test('the derivation names what it does not check', () => {
  const out = derive(rig());
  // THREE now: the two the chain door cannot read, and the one this function
  // cannot answer without a chain view - whether the output is unspent and
  // deep enough. Named rather than taken from the entry, because "the list
  // said so" is not a check.
  // ONE, not two and not three. "Unspent and deep enough" left the list when
  // the derivation began passing down the chain it had just scanned. The BOND
  // SCRIPT TEMPLATE left it here: this caller injects the arbitration set and
  // a curve, so the output key is rebuilt rather than named as a gap - and
  // since a composed census now refuses a root without them, no derivation
  // that returns one can have the template on this list at all.
  //
  // What remains is the advertisement signature, which needs the OTHER curve
  // (ed25519, letter 23) and leaves the list the same way the moment a caller
  // injects `verifyAdvert` - which `advert.test.js` does.
  assert.equal(out.unchecked.length, 1,
    `expected only the signature to be parked, got: ${out.unchecked.join(' | ')}`);
  assert.equal(out.unchecked.some((u) => /unspent and deep enough/.test(u)), false);
  assert.equal(out.unchecked.some((u) => /bond script template/.test(u)), false,
    'a root came back with the template unchecked');
  assert.equal(out.chainChecked, true, 'the derivation resolved without the chain it had');
  assert.match(out.unchecked[0], /advertisement signature/);
});

/**
 * ONE CENSUS, WHETHER THE OUTPOINTS WERE HANDED OVER OR FOUND.
 *
 * A scan that produced a DIFFERENT set from the same chain would be a second
 * census, and the whole argument of 5A.2 is that two parties with the same
 * chain compute the same one. So the root is the test: same blocks, same root,
 * whether the list came from a caller or from the blocks themselves.
 */
test('the root from a self-found scan is the root from the same outpoints handed in', () => {
  const r = rig();

  const handed = derive(r);
  assert.equal(handed.ok, true, handed.why);

  const found = deriveCensus(view(r.at), { contract, resolve: r.resolve, bond: BOND });
  assert.equal(found.ok, true, found.why);

  assert.deepEqual(toHex(found.root), toHex(handed.root),
    'the census the chain produced is not the census the list produced');
  assert.equal(found.entries.length, handed.entries.length);
  assert.deepEqual(found.entries.map((e) => toHex(e.txid)).sort(),
    handed.entries.map((e) => toHex(e.txid)).sort());
});

/**
 * THE SCAN REPORTS THE OUTPOINT THE BODY NAMED.
 *
 * Measured with a mutant: recording output 0 whatever the advertisement said
 * left every test green, because in every fixture the bond IS output 0. It is
 * not a harmless normalisation - the marker output is 330 sats, so a body
 * pointing at it must fail the round's floor, and a scan that quietly points
 * at output 0 instead hands RESOLVE a whole bitcoin and counts the node in.
 */
test('a body naming the marker as its bond is scanned there and refused by name', () => {
  const advert = advertFor(0x45, { bondVout: 1 });
  const wrong = bondTransaction(advert, { previousTxid: b32(0x82), previousVout: 0 });
  const r = rig({ extraBlocks: { [HEIGHT - 9]: [wrong] } });

  const found = deriveCensus(view(r.at), {
    contract, bond: BOND,
    resolve: (e) => (toHex(e.pubkey) === toHex(keyFor(0x45))
      ? { transaction: wrong } : r.resolve(e)),
  });
  assert.equal(found.ok, true, found.why);

  const refused = found.excluded.find((e) => toHex(e.pubkey) === toHex(keyFor(0x45)));
  assert.ok(refused, 'the body that pointed at the marker was counted in');
  assert.equal(refused.vout, 1, 'the scan moved the outpoint to the richer output');
  // WHICH RULE REFUSES IT depends on what this caller brought. The marker
  // output IS a taproot output, so with the set and a curve the template check
  // speaks first: that key is the marker's, not this node's bond. Without them
  // it was the round's floor, since the marker holds 330 sats. Either way the
  // outpoint judged is the one the body named - output 0 would have recomputed
  // and been counted.
  assert.match(refused.why, /not the taproot tweak of the keys and maturity it declares/);

  // and the honest three still make the same root
  assert.deepEqual(toHex(found.root), toHex(derive(r).root));
});

/**
 * SPENDS, AND THE OP_RETURN THAT IS NOT A BOND - MOVED FROM
 * `arena-protocol/test/bond-recognition.test.js` BY LETTER 15 SLICE 2.
 *
 * Both go through the COMPOSED census, which refuses a root without the
 * arbitration set and a curve now, and the protocol package has neither. What
 * they measure is unchanged; only the caller is - recognition itself, which is
 * what that file is about, stayed there and needs no curve.
 */
/**
 * A BOND SPENT AFTER THE CENSUS HEIGHT IS STILL IN THAT CENSUS, at the amount
 * the output held, and its signer node stands.
 *
 * Measured rather than assumed, and it is the spec's own behaviour: 5A.4 step
 * 1 is "unspent AT census_height", so a spend later is not this census's
 * business - otherwise the census would change as the chain grows and two
 * participants asking at different tips would get different committees.
 *
 * 5A.3 says the consequence out loud: "Proven misbehaviour removes a node the
 * only objective way - by its bond being spent by a slashing transaction,
 * which makes the output no longer unspent AT THE NEXT census_height." A node
 * whose bond goes away mid-round is removed by the next census, not this one.
 *
 * Pinned here because nothing pinned the AMOUNT or the signer node, only the count.
 */
test('a bond spent after the census height keeps its place, its amount and its signer node', () => {
  const bond = bondTransaction(advertFor(0x1a), {
    previousTxid: b32(0xba), previousVout: 0, value: 60000,
    outputKey: bondFor(keyFor(0x1a)),
  });
  const tx = parseTransaction(bond);
  const spend = bondTransaction(advertFor(0x50), {
    previousTxid: tx.txid, previousVout: 0,
  });
  // A SECOND BONDED NODE, because a census of one cannot hold a round at all:
  // regtest was born needing two, and `selectCommittee` refuses to slice a
  // committee out of anything smaller. The claim under test is unchanged - a
  // bond spent AFTER the census keeps its place, its amount and its signer node - and
  // it needs a census that is a census.
  const neighbour = bondTransaction(advertFor(0x1b), {
    previousTxid: b32(0xbb), previousVout: 0, value: 60000,
    outputKey: bondFor(keyFor(0x1b)),
  });
  const nb = parseTransaction(neighbour);
  const round = {
    ...contract, bondMinSats: 50000n, committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', gameVerifySlots: 2,
  };
  const byTxid = new Map([[toHex(tx.txid), bond], [toHex(nb.txid), neighbour]]);
  const at = (place) => deriveCensus(view(place), {
    contract: round, bond: BOND,
    candidates: [
      { txid: tx.txid, vout: 0, pubkey: b32(0xEE), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] },
      { txid: nb.txid, vout: 0, pubkey: b32(0xEE), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] },
    ],
    resolve: (e) => ({ transaction: byTxid.get(toHex(e.txid)) }),
  });
  const funded = { [HEIGHT - 20]: [bond, neighbour] };

  const untouched = at(funded);
  const later = at({ ...funded, [HEIGHT + 5]: [spend] });

  assert.equal(later.entries.length, 2, 'a spend after the census removed the bond');
  const mine = later.entries.find((e) => toHex(e.txid) === toHex(tx.txid));
  assert.ok(mine, 'the spent-later bond is not in the census');
  assert.equal(mine.bondSats, 60000n, 'the amount changed with a later spend');
  assert.equal(toHex(later.root), toHex(untouched.root), 'a later spend moved the census root');
  const signerNodes = selectCommittee({
    // The seed a beacon would have produced: a contract names none, and this
    // test is about a spend keeping its signer node, not about where seeds come from.
    entries: later.entries, contract: round, role: 'game', committeeSeed: b32(0x11) });
  assert.equal(signerNodes.length, 2);
  assert.equal(signerNodes.some((e) => toHex(e.txid) === toHex(tx.txid)), true,
    'the bond spent after the census lost its signer node');

  // and the boundary is "at or before": spent IN the census block is out
  const atHeight = at({ ...funded, [HEIGHT]: [spend] });
  assert.equal(atHeight.entries.length, 1, 'the spent bond is still counted');
  assert.equal(toHex(atHeight.entries[0].txid), toHex(nb.txid));
  assert.match(atHeight.excluded[0].why, /already spent at the census height/);

  // INCLUDING A BOND FUNDED AND SPENT IN THE SAME BLOCK, which a mutant
  // survived on: every fixture funded its bond well before the census height,
  // so a rule keyed on "spent, unless it was funded here" was invisible. One
  // transaction creating an output and another spending it in the same block
  // is ordinary Bitcoin, and such a bond was never unspent at any height.
  const sameBlock = at({ [HEIGHT]: [bond, spend] });
  assert.equal(sameBlock.entries.length, 0, 'a bond created and spent in one block was counted');
  assert.match(sameBlock.excluded[0].why, /already spent at the census height/);
  assert.equal(sameBlock.excluded[0].height, HEIGHT);

  // recognition itself never looks at spends, and should not: the output's
  // shape and value are what it answers about, and SCAN owns the spend
  assert.equal(recognizeBond(tx, 0, advertFor(0x1a)).ok, true);
});

/**
 * AND THE CENSUS USES IT. The measurement that opened this letter, inverted:
 * the OP_RETURN at vout 1 was accepted by `deriveCensus` and now is not.
 */
test('a census no longer counts the OP_RETURN as somebody\'s bond', () => {
  const bond = bondOf(0x16);
  const tx = parseTransaction(bond);
  const chain = view({ [HEIGHT - 20]: [bond] });
  const at = (vout) => deriveCensus(chain, {
    contract, bond: BOND,
    candidates: [{ txid: tx.txid, vout, pubkey: b32(0xEE), bondSats: 60000n, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'] }],
    resolve: () => ({ transaction: bond }),
  });

  const real = at(0);
  assert.equal(real.entries.length, 1, real.excluded[0] && real.excluded[0].why);

  const fake = at(2);
  assert.equal(fake.entries.length, 0, 'the OP_RETURN was counted as a bond');
  assert.equal(fake.excluded.length, 1);
  assert.equal(fake.excluded[0].step, 'resolve');
  assert.match(fake.excluded[0].why, /not a taproot output/);
  assert.notEqual(toHex(fake.root), toHex(real.root));

  // scan still finds it, and that is right: step 1 answers where an outpoint
  // is and whether it is spent, not what it is for
  assert.equal(fake.excluded[0].height, HEIGHT - 20);
});
