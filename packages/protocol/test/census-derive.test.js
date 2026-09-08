// 5A.4, ALL FIVE STEPS, AND THE ONLY PLACE A CENSUS ROOT COMES FROM.
//
// "Given `census_height`, EVERY PARTICIPANT RUNS THE SAME FIVE STEPS."
//
// Measured before this file existed: the five steps never joined. `scanCensus`
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
import { toHex } from '../src/hash.js';
import { PROTOCOL_VERSION } from '../src/constants.js';
import { parseTransaction } from '../src/tx.js';
import { advertId } from '../src/advert.js';
import { chainOf as minedChain } from '../tools/chainview.js';
import { bondTransaction } from '../tools/bond.js';
import {
  deriveCensus, scanCensus, commitCensus, leafHash, censusRootMatchesRound, censusInputsId,
} from '../src/census.js';

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
/** A mined chain from HEIGHT-20 to `tip`, with `at` placing transactions. */
const view = (at, tip = TIP, from = HEIGHT - 20) => {
  const blocks = [];
  for (let h = from; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, from);
};
const contract = {
  bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION,
  censusHeight: HEIGHT, censusConfirmations: 6,
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
        txid: ids.get(n), vout: 0, pubkey: claims(n), bondSats: 60000n, roles: ['settlement'],
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
  candidates: r.candidates, contract, resolve: r.resolve, ...over,
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
  const honest = rig({ claims: (n) => b32(n) });

  const a = derive(lying);
  const b = derive(honest);

  // every entry carries the key its own advertisement declared
  for (const e of a.entries) assert.equal(e.pubkey[0], e.advert.nodePubkey[0]);
  assert.deepEqual(a.entries.map((e) => e.pubkey[0]).sort(), [0x11, 0x12, 0x13]);
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
  const r = rig({ extraCandidates: [{ txid: b32(0x77), vout: 0, pubkey: b32(0x77), bondSats: 60000n, roles: ['game'] }] });
  // 0x77 is on no chain at all -> scan drops it
  // and 0x13 resolves to a body nobody can retrieve -> resolve drops it
  const gone = toHex(r.ids.get(0x13));
  const out = deriveCensus(view(r.at), {
    candidates: r.candidates, contract,
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
      contract, candidates: r.candidates, resolve: r.resolve, ...extra,
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
  assert.match(derive(r, { contract: {} }).why, /cannot be scanned: that round names no census height/);
  assert.match(derive(r, { contract: { censusHeight: HEIGHT } }).why,
    /cannot be scanned: that round names no confirmation depth/);
  assert.match(derive(r, { contract: { censusHeight: HEIGHT, censusConfirmations: 6 } }).why,
    /names no bond floor/);
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
  assert.equal(out.unchecked.length, 3);
  assert.match(out.unchecked[0], /BOND_MARKER \(25.1: the marker is null/);
  assert.match(out.unchecked[1], /bond script template/);
  assert.match(out.unchecked[2], /no curve in this package/);
});
