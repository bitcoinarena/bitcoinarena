// 5A.4 STEP 2 (RESOLVE) AND THE 5A.3 FILTERS THAT NEED NOTHING PARKED.
//
// "RESOLVE: for each, read the committed H(advertisement) and retrieve the
// body... Hash must match. UNRETRIEVABLE BODY -> EXCLUDED (identically for
// everyone: the hash is public, the content is missing for all)."
//
// That parenthesis is why it can be a rule: a missing body is missing for
// every participant, so excluding it keeps the census canonical instead of
// making it depend on who could reach what.
//
// Three of 5A.3's six criteria are applied here - the retrievable and
// hash-matching body, `bond_amount >= bond_min(role)`, and the declared role
// and version. The other three are NOT worked around: the bond script template
// cannot be read off a taproot output, and the advertisement signature needs a
// curve this package does not carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '../src/constants.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { parseTransaction } from '../src/tx.js';
import { bondTransaction } from '../tools/bond.js';
import { resolveCensus } from '../src/census.js';
import { fromHex } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

// A REAL MAINNET TRANSACTION THAT COMMITS TO NOTHING: block 100000, index 1,
// pre-segwit, two P2PKH outputs and no OP_RETURN. Copied from `tx.test.js`
// rather than fabricated, because a hand-rolled "transaction with no
// commitment" proves only that the hand rolled it.
const LEGACY_100000 = fromHex(
  '0100000001032e38e9c0a84c6046d687d10556dcacc41d275ec55fc00779ac88fdf3'
  + '57a187000000008c493046022100c352d3dd993a981beba4a63ad15c209275ca9470'
  + 'abfcd57da93b58e4eb5dce82022100840792bc1f456062819f15d33ee7055cf7b5ee'
  + '1af1ebcc6028d9cdb1c3af7748014104f46db5e9d61a9dc27b8d64ad23e7383a4e6c'
  + 'a164593c2527c038c0857eb67ee8e825dca65046b82c9331586c82e0fd1f633f25f8'
  + '7c161bc6f8a630121df2b3d3ffffffff0200e32321000000001976a914c398efa9c3'
  + '92ba6013c5e04ee729755ef7f58b3288ac000fe208010000001976a914948c765a69'
  + '14d43f2a7ac177da2c2f6b52de3d7c88ac00000000');

const b32 = (n) => new Uint8Array(32).fill(n);
const advertFor = (n, over = {}) => ({
  nodePubkey: b32(n), operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n, ...over,
});
const bondOf = (n, over = {}, value) =>
  bondTransaction(advertFor(n, over), {
    previousTxid: b32(0xa0 + n), previousVout: 0, ...(value === undefined ? {} : { value }),
  });

/** A bond FUNDED at a given number of sats, entry and transaction together. */
const funded = (n, sats) => {
  const transaction = bondOf(n, {}, sats);
  return {
    seen: { transaction },
    entry: {
      txid: parseTransaction(transaction).txid, vout: 0, pubkey: b32(n),
      bondSats: 60000n, height: 900000, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false,
    },
  };
};

const contract = { bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION, networkId: NETWORK_ID_REGTEST };
const entryFor = (n, over = {}) => ({
  txid: parseTransaction(bondOf(n, over.advert || {})).txid, vout: 0,
  pubkey: b32(n), bondSats: 60000n, height: 900000, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false,
  ...(over.entry || {}),
});

/** A resolver that hands back the funding transaction, the way a peer would. */
const resolverFor = (map) => (e) => map.get(e.pubkey && e.pubkey[0]);

function rig(over = {}) {
  const entries = [entryFor(0x11), entryFor(0x12), entryFor(0x13)];
  const map = new Map([
    [0x11, { transaction: bondOf(0x11) }],
    [0x12, { transaction: bondOf(0x12) }],
    [0x13, { transaction: bondOf(0x13) }],
  ]);
  return { entries, map, ...over };
}

test('a census whose bodies all resolve keeps every entry', () => {
  const { entries, map } = rig();
  const seen = resolveCensus(entries, { contract, resolve: resolverFor(map) });

  assert.equal(seen.ok, true);
  assert.equal(seen.eligible.length, 3);
  assert.equal(seen.excluded.length, 0);
  // the resolved body replaces the entry's summary
  assert.equal(seen.eligible[0].advert.endpoint, 'ws://node17');
  assert.deepEqual(seen.eligible[0].roles, ['game']);
});

/**
 * AN UNRETRIEVABLE BODY IS EXCLUDED, AND EXCLUDED THE SAME WAY EVERYWHERE.
 * "the hash is public, the content is missing for all."
 */
test('a body nobody can retrieve is excluded, and named', () => {
  const { entries, map } = rig();
  map.delete(0x12);
  const seen = resolveCensus(entries, { contract, resolve: resolverFor(map) });

  assert.equal(seen.eligible.length, 2);
  assert.equal(seen.excluded.length, 1);
  assert.match(seen.excluded[0].why, /could not be retrieved/);

  // a resolver that THROWS is a resolver that failed, not a broken census
  const seen2 = resolveCensus(entries, {
    contract,
    resolve: (e) => { if (e.pubkey[0] === 0x12) throw new Error('unreachable'); return map.get(e.pubkey[0]); },
  });
  assert.equal(seen2.ok, true, 'a failing peer broke the census');
  assert.equal(seen2.excluded.length, 1);
});

test('a body that is not the one the bond committed to is excluded', () => {
  const { entries, map } = rig();
  // node 0x12's entry resolved with node 0x13's transaction: the commitment in
  // that transaction is for a different advertisement
  map.set(0x12, { transaction: bondOf(0x13) });
  const seen = resolveCensus(entries, { contract, resolve: resolverFor(map) });

  assert.equal(seen.eligible.length, 2);
  assert.equal(seen.excluded.length, 1,
    'a body the bond did not commit to was counted');
});

/**
 * THE FLOOR IS THE ROUND'S. 5A.3: "bond_min(role) is NAMED IN THE ROUND
 * CONTRACT, not global... a node is eligible for THAT ROUND or not." A bond
 * below the large rounds' floor is still eligible for the small ones.
 */
test('a bond under this round\'s floor is out, and the same bond is in a smaller round', () => {
  // FUNDED at 49999, not merely claimed to be: the amount is read off the
  // output now, so a fixture that only asserts one measures nothing.
  const small = funded(0x12, 49999);

  const strict = resolveCensus([small.entry], { contract, resolve: () => small.seen });
  assert.equal(strict.eligible.length, 0);
  assert.match(strict.excluded[0].why, /that bond is 49999 where this round's floor is 50000/);

  const smaller = resolveCensus([small.entry], {
    contract: { ...contract, bondMinSats: 10000n },
    resolve: () => small.seen,
  });
  assert.equal(smaller.eligible.length, 1, 'the network stratifies; it does not evict');

  // exactly the floor is in: 5A.3 says >=
  const exact = funded(0x12, 50000);
  assert.equal(resolveCensus([exact.entry], { contract, resolve: () => exact.seen }).eligible.length, 1);
});

/**
 * AND THE AMOUNT IS THE CHAIN'S, NOT THE ENTRY'S.
 *
 * Measured before this was true: an output worth 60000 sats, an entry claiming
 * 100000000000, ACCEPTED - and carrying weight 2000000 into `selectCommittee`
 * instead of weight 1. 5A.3 says why that is not a detail: "The bond is what
 * makes identity expensive. Without it, a Sybil attacker creates arbitrarily
 * many nodes for free and buys arbitrarily many selection chances - the flaw
 * that made v4.4 unsafe." A bond that is asserted rather than observed costs
 * nothing. The leaf hashes this number, so the lie reached the census root.
 */
test('the bond amount is the output\'s, not the number the entry claims', () => {
  const real = funded(0x14, 60000);

  for (const claim of [60000n, 1n, 100000000000n, undefined]) {
    const out = resolveCensus([{ ...real.entry, bondSats: claim }], {
      contract: { ...contract },
      resolve: () => real.seen,
    });
    assert.equal(out.eligible.length, 1, `a claim of ${claim} changed eligibility`);
    assert.equal(out.eligible[0].bondSats, 60000n, `a claim of ${claim} reached the census`);
  }

  // a claim cannot buy a way over the floor either: the output is 49999
  const under = funded(0x15, 49999);
  const lying = resolveCensus([{ ...under.entry, bondSats: 100000000000n }], {
    contract, resolve: () => under.seen,
  });
  assert.equal(lying.eligible.length, 0, 'a claimed amount bought a place in the census');
  assert.match(lying.excluded[0].why, /that bond is 49999 /);
  assert.equal(lying.excluded[0].bondSats, 49999n, 'the refusal repeated the claim back');
});

test('an advertisement that declares no role, or no version we speak, is out', () => {
  const { entries, map } = rig();

  const noRole = { transaction: bondOf(0x21, { hostedGames: [NEXTBLOCK_GAME_ID], roles: [] }) };
  const seen = resolveCensus([entryFor(0x21, { advert: { hostedGames: [NEXTBLOCK_GAME_ID], roles: [] } })], {
    contract, resolve: () => noRole,
  });
  assert.equal(seen.eligible.length, 0);
  assert.match(seen.excluded[0].why, /declares no role/);

  const oldVersion = { transaction: bondOf(0x22, { protocolVersions: [99] }) };
  const old = resolveCensus([entryFor(0x22, { advert: { protocolVersions: [99] } })], {
    contract, resolve: () => oldVersion,
  });
  assert.equal(old.eligible.length, 0);
  assert.match(old.excluded[0].why, /speaks 99 and this round runs 1/);

  // and one that speaks ours among others is in
  const both = { transaction: bondOf(0x23, { protocolVersions: [99, PROTOCOL_VERSION] }) };
  const ok = resolveCensus([entryFor(0x23, { advert: { protocolVersions: [99, PROTOCOL_VERSION] } })], {
    contract, resolve: () => both,
  });
  assert.equal(ok.eligible.length, 1);
});

/**
 * AND THE VERSION IS THE ROUND'S, NOT THE CALLER'S.
 *
 * It was an argument with a default - `supportedVersions = [PROTOCOL_VERSION]`
 * - so whoever called this decided which nodes were selectable. A version the
 * caller picks is a version the OPERATOR picks, the same fault that moved the
 * objection window and the minimum service into the contract, and 27A.7.5 puts
 * it on the round: a node "simply stops being selectable for rounds naming the
 * new hash, exactly as with protocol versions".
 *
 * The measurement: ONE advertisement, unchanged, in or out depending only on
 * which round is asking.
 */
test('which nodes are selectable is the round\'s decision, not the caller\'s', () => {
  const advert = { protocolVersions: [99] };
  const tx = { transaction: bondOf(0x24, advert) };
  const entry = entryFor(0x24, { advert });

  const ours = resolveCensus([entry], { contract, resolve: () => tx });
  assert.equal(ours.eligible.length, 0, 'a round running 1 took a node that speaks only 99');

  const theirs = resolveCensus([entry], {
    contract: { ...contract, protocolVersion: 99 }, resolve: () => tx,
  });
  assert.equal(theirs.eligible.length, 1, 'a round running 99 refused a node that speaks 99');
  assert.match(ours.excluded[0].why, /speaks 99 and this round runs 1/);

  // and a round that names no version is answered, not guessed at: there is no
  // default to fall back on any more, which is the point.
  const none = resolveCensus([entry], {
    contract: { bondMinSats: 50000n, networkId: NETWORK_ID_REGTEST }, resolve: () => tx,
  });
  assert.equal(none.ok, false);
  assert.match(none.why, /names no protocol version/);
});

/**
 * THE THREE CRITERIA THIS CANNOT APPLY ARE SAID OUT LOUD rather than passed
 * over in silence. 5A.3B: taproot's unused paths are never revealed, so a
 * bond's script template is not readable from the output; and no curve lives
 * in this package, so a signature is somebody else's to verify.
 */
test('what it does not check, it names', () => {
  const { entries, map } = rig();
  const seen = resolveCensus(entries, { contract, resolve: resolverFor(map) });

  assert.equal(seen.unchecked.length, 3);
  assert.equal(seen.unchecked.some((u) => /unspent and deep enough/.test(u)), true);
  assert.equal(seen.chainChecked, false);
  assert.match(seen.unchecked[0], /bond script template/);
  assert.match(seen.unchecked[1], /advertisement signature/);
});

test('a round with no floor, or no resolver, is answered rather than guessed at', () => {
  const { entries, map } = rig();
  for (const bad of [undefined, {}, { bondMinSats: 50000 }])
    assert.match(resolveCensus(entries, { contract: bad, resolve: resolverFor(map) }).why,
      /names no bond floor/);
  assert.match(resolveCensus(entries, { contract, resolve: undefined }).why,
    /no way to retrieve an advertisement body/);
});

/**
 * A BODY THE OUTPUT DOES NOT COMMIT TO IS NOT THAT BOND'S BODY.
 *
 * Found by a mutant that survived: taking the first offered body when none
 * matched left every test green, because every transaction this repo builds
 * commits to its own body. A bond whose OP_RETURN names something else is
 * exactly the case that check exists for.
 */
test('a witness body the commitment does not name is refused', () => {
  const wrong = bondTransaction(advertFor(0x31), {
    commitment: b32(0x99), previousTxid: b32(0xd1), previousVout: 0,
  });
  const entry = {
    txid: parseTransaction(wrong).txid, vout: 0, pubkey: b32(0x31),
    bondSats: 60000n, height: 900000, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false,
  };
  const seen = resolveCensus([entry], { contract, resolve: () => ({ transaction: wrong }) });
  assert.equal(seen.eligible.length, 0, 'a body nothing committed to was taken');
  assert.match(seen.excluded[0].why, /commits to a different advertisement/);
});

test('a transaction that commits to nothing at all resolves nothing', () => {
  const entry = {
    txid: parseTransaction(LEGACY_100000).txid, vout: 0, pubkey: b32(0x41),
    bondSats: 60000n, height: 900000, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false,
  };
  const seen = resolveCensus([entry], {
    contract, resolve: () => ({ transaction: LEGACY_100000 }),
  });
  assert.equal(seen.eligible.length, 0);
  assert.match(seen.excluded[0].why, /commits to anything/);
});

/**
 * AND THE RESOLVED BODY WINS OVER THE ENTRY'S SUMMARY. The body is what the
 * bond committed to; the roles beside it in a census row are somebody's
 * transcription of it, and a census that believed the transcription would let
 * a publisher put a node in a role its own advertisement never claimed.
 */
test('the roles come from the resolved advertisement, not from the entry', () => {
  const tx = bondOf(0x51);
  const entry = {
    txid: parseTransaction(tx).txid, vout: 0, pubkey: b32(0x51),
    bondSats: 60000n, height: 900000, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['settlement'], spent: false,
  };
  const seen = resolveCensus([entry], { contract, resolve: () => ({ transaction: tx }) });

  assert.equal(seen.eligible.length, 1);
  assert.deepEqual(seen.eligible[0].roles, ['game'],
    'the census believed a role the advertisement never declared');
  assert.deepEqual(seen.eligible[0].advert.roles, ['game']);
});

/**
 * THE CENSUS NO LONGER TAKES A BODY NOBODY SIGNED - once its caller brings a
 * curve.
 *
 * RESOLVE used to split the signed advertisement and throw the signature away,
 * so eligibility rested on a body that had only been COMMITTED to, never
 * authored. The commitment is the heavier half and it stands: an attacker
 * cannot swap the endpoint of a bond that is not theirs without spending it.
 * But 5A.1 lists the signature, and a census that skipped it was letting a
 * body into the set that nobody had shown belonged to the key it names.
 *
 * This package still carries no curve, and must not: it is the one every other
 * package reads. So the caller brings one, the way `provesEquivocation` takes
 * one - and when nobody brings it the gap is named in `unchecked` exactly as
 * before, rather than a body being called signed because nobody looked.
 */
test('RESOLVE checks the advertisement signature when its caller brings a curve', async () => {
  const { advertId } = await import('../src/advert.js');

  // A STUB CURVE, because this package has none and must not: it is the one
  // every other package reads. What is measured here is the INJECTION - that
  // the signature reaches a verifier, that a refusal excludes the entry, and
  // that the unchecked list shrinks. The real ed25519 does the same thing one
  // package over, where the dependency already lives.
  const MINE = new Uint8Array(64).fill(0x11);
  const verifyAdvert = (sig, id, pub) =>
    sig.every((b) => b === 0x11) && id.length === 32 && pub.length === 32;

  const advert = advertFor(0x11);
  const signedWith = (signature) => bondTransaction(advert, {
    previousTxid: b32(0xa1), previousVout: 0, signature,
  });
  const entryOf = (transaction) => ({
    txid: parseTransaction(transaction).txid, vout: 0, pubkey: b32(0x11),
    bondSats: 60000n, height: 900000, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false,
  });

  const mine = signedWith(MINE);
  const ok = resolveCensus([entryOf(mine)], {
    contract, resolve: () => ({ transaction: mine }), verifyAdvert,
  });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.eligible.length, 1, `the signed node was excluded: ${JSON.stringify(ok.excluded)}`);

  // AND THE LIST OF WHAT IS STILL UNCHECKED SHRINKS, because reporting the
  // signature as unchecked after checking it would be as wrong as not
  // checking it.
  assert.equal(ok.unchecked.some((u) => /advertisement signature/.test(u)), false);
  assert.equal(ok.unchecked.some((u) => /script template/.test(u)), true,
    'the taproot script template is still hidden until the output is spent');

  // A BODY THE VERIFIER REFUSES IS NOT IN THE CENSUS.
  const theirs = signedWith(new Uint8Array(64).fill(0x22));
  const forged = resolveCensus([entryOf(theirs)], {
    contract, resolve: () => ({ transaction: theirs }), verifyAdvert,
  });
  assert.equal(forged.eligible.length, 0, 'a body the verifier refused was counted');
  assert.match(forged.excluded[0].why, /not signed by the node it names/);

  // WITHOUT A CURVE IT IS COUNTED AND THE GAP IS NAMED - unchanged behaviour
  // for a caller that has none, which is what keeps this package curve-free.
  const blind = resolveCensus([entryOf(theirs)], {
    contract, resolve: () => ({ transaction: theirs }),
  });
  assert.equal(blind.eligible.length, 1);
  assert.equal(blind.unchecked.some((u) => /advertisement signature/.test(u)), true);

  // ZEROS VERIFY EACH OTHER ON ED25519, and a bond builder's default signature
  // is 64 of them, so both halves are refused before any curve is consulted.
  // EACH CASE ISOLATES ONE CHECK: a fixture where both are zero would pass
  // with either check missing, and prove neither.
  const always = () => true;

  // the zero KEY, carrying a signature that is not empty at all
  const nobody = advertFor(0x11, { nodePubkey: new Uint8Array(32) });
  const keyed = bondTransaction(nobody, {
    previousTxid: b32(0xa2), previousVout: 0, signature: new Uint8Array(64).fill(0x33),
  });
  const keyOnly = resolveCensus([{ ...entryOf(keyed), pubkey: new Uint8Array(32) }], {
    contract, resolve: () => ({ transaction: keyed }), verifyAdvert: always,
  });
  assert.equal(keyOnly.eligible.length, 0, 'the zero key was made eligible');
  assert.match(keyOnly.excluded[0].why, /zero key, which nobody holds/);

  // the empty SIGNATURE, under a key that is real
  const unsigned = bondTransaction(advert, { previousTxid: b32(0xa3), previousVout: 0 });
  const sigOnly = resolveCensus([entryOf(unsigned)], {
    contract, resolve: () => ({ transaction: unsigned }), verifyAdvert: always,
  });
  assert.equal(sigOnly.eligible.length, 0, 'an unsigned body was made eligible');
  assert.match(sigOnly.excluded[0].why, /carries an empty signature/);
});

/**
 * WHAT THE CHAIN SAYS, NOT WHAT THE LIST CLAIMS.
 *
 * 5A.2 makes a node eligible "if and only if it has a bond output on Bitcoin,
 * CONFIRMED AND UNSPENT at census_height". RESOLVE used to re-apply that rule
 * to the entry's own `height` and `spent` - so whoever composed the list
 * decided whether a bond was live, on the single criterion the whole of
 * eligibility rests on. Re-applying a rule to a claimed fact is not
 * verification.
 */
test('RESOLVE reads spentness and depth off the chain rather than off the entry', async () => {
  const { chainOf } = await import('../tools/chainview.js');

  // A BOND FUNDED SHORTLY BEFORE THE CENSUS IS GENUINELY SHALLOW. Depth is measured AT THE CENSUS HEIGHT (5A.4 step 1;
  // the 2026-10-04 audit: this read the TIP, so the answer moved as the chain grew) - two blocks under it is three deep
  // there, whatever the tip.
  const HEIGHT = 900000;
  const TIP = 900002;
  const round = (over = {}) => ({
    bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION,
    censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST, ...over,
  });

  const live = bondOf(0x11);
  const doomed = bondOf(0x12);
  const shallow = bondOf(0x13);
  const spend = bondTransaction(advertFor(0x50), {
    previousTxid: parseTransaction(doomed).txid, previousVout: 0,
  });

  // A chain that funds three bonds and spends one of them, all at or before
  // the census height.
  const at = {
    [HEIGHT - 20]: [live, doomed],
    [HEIGHT - 8]: [spend],
    [HEIGHT - 2]: [shallow],          // 899998: three deep at the census height 900000
  };
  const blocks = [];
  for (let h = HEIGHT - 20; h <= TIP; h++) blocks.push({ transactions: at[h] || [] });
  const view = chainOf(blocks, HEIGHT - 20);

  const entryFor = (tx, n, over = {}) => ({
    txid: parseTransaction(tx).txid, vout: 0, pubkey: b32(n),
    bondSats: 60000n, height: HEIGHT - 20, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false, ...over,
  });
  const byKey = new Map([[0x11, live], [0x12, doomed], [0x13, shallow]]);
  const resolve = (e) => ({ transaction: byKey.get(e.pubkey[0]) });

  // ONE: a spent bond, whose entry says it is not.
  const entries = [entryFor(live, 0x11), entryFor(doomed, 0x12)];
  const seen = resolveCensus(entries, { contract: round(), resolve, view });
  assert.equal(seen.ok, true, seen.why);
  assert.equal(seen.eligible.length, 1,
    `expected one live bond, got ${seen.eligible.length}: ${seen.excluded.map((e) => e.why).join(' | ')}`);
  assert.deepEqual(seen.eligible[0].pubkey, b32(0x11));
  assert.match(seen.excluded[0].why, new RegExp(`spent at height ${HEIGHT - 8}, so nothing is at stake`));

  // TWO: a bond too shallow, whose entry claims an older height.
  const lying = entryFor(shallow, 0x13, { height: HEIGHT - 20 });
  const tooNew = resolveCensus([lying], { contract: round(), resolve, view });
  assert.equal(tooNew.eligible.length, 0, 'a three-deep bond was counted for a six-deep round');
  assert.match(tooNew.excluded[0].why, /claims height 899980 and the chain says 899998/);

  // THREE: the claim is not quietly corrected either - a list that lies about
  // the chain is a list to distrust, not to fix.
  const honestHeight = entryFor(shallow, 0x13, { height: HEIGHT - 2 });
  const stillShallow = resolveCensus([honestHeight], { contract: round(), resolve, view });
  assert.equal(stillShallow.eligible.length, 0);
  assert.match(stillShallow.excluded[0].why, /3 block\(s\) deep and this round asks for 6/);

  // FOUR: an honest set is unchanged, and the height that reaches the root is
  // the chain's.
  const honest = resolveCensus([entryFor(live, 0x11)], { contract: round(), resolve, view });
  assert.equal(honest.eligible.length, 1);
  assert.equal(honest.eligible[0].height, HEIGHT - 20);
  assert.equal(honest.eligible[0].spent, false);
  assert.equal(honest.chainChecked, true);
  assert.equal(honest.unchecked.some((u) => /unspent and deep enough/.test(u)), false);

  // THE SCRIPT NEEDS NO SEPARATE CHECK, and that is worth stating rather than
  // testing: a resolved transaction is pinned to the entry's TXID, and a
  // transaction with that txid cannot carry different outputs, because the
  // txid is the hash of them. A peer swapping the output has to change the
  // txid, and then it is refused as a different transaction.
  const swapped = bondTransaction(advertFor(0x11), {
    previousTxid: b32(0xa0 + 0x11), previousVout: 0, value: 70000,
  });
  const lied = resolveCensus([entryFor(live, 0x11)], {
    contract: round(), resolve: () => ({ transaction: swapped }), view,
  });
  assert.equal(lied.eligible.length, 0, "a peer's own output was counted in place of the chain's");
  assert.match(lied.excluded[0].why, /different transaction than the entry names/);

  // FIVE: with no view, exactly today's behaviour, and the gap is named.
  const blind = resolveCensus(entries, { contract: round(), resolve });
  assert.equal(blind.eligible.length, 2, 'without a chain view the spent bond was counted, as before');
  assert.equal(blind.chainChecked, false);
  assert.equal(blind.unchecked.some((u) => /unspent and deep enough/.test(u)), true);
});

/**
 * THE MARKER IS THE ONE THE ROUND'S OWN NETWORK USES.
 *
 * 5A.2: "every bond funding transaction MUST also pay a dust output to
 * BOND_MARKER... Without it the census is unfindable in practice." One address
 * per network, and they differ. The census held the round's `networkId` and
 * passed nothing, so `recognizeBond` fell back to regtest - and a testnet4
 * census would have accepted a bond posted on regtest, because it was looking
 * for the wrong dust output.
 */
test('a census checks the marker of its own network, not the default', async () => {
  const { NETWORK_ID_TESTNET4 } = await import('../src/genesis-ids.js');
  const { bondMarker } = await import('../src/constants.js');

  // The two markers really are different addresses.
  assert.notDeepEqual(bondMarker('regtest'), bondMarker('testnet'));

  const onRegtest = bondTransaction(advertFor(0x11), {
    previousTxid: b32(0xa1), previousVout: 0, network: 'regtest',
  });
  const onTestnet = bondTransaction(advertFor(0x11), {
    previousTxid: b32(0xa2), previousVout: 0, network: 'testnet',
  });
  const entryFor = (tx) => ({
    txid: parseTransaction(tx).txid, vout: 0, pubkey: b32(0x11),
    bondSats: 60000n, height: 900000, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false,
  });
  const round = (networkId) => ({
    bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION, networkId,
  });

  // A TESTNET4 ROUND REFUSES THE REGTEST MARKER and takes its own.
  const wrongChain = resolveCensus([entryFor(onRegtest)], {
    contract: round(NETWORK_ID_TESTNET4), resolve: () => ({ transaction: onRegtest }),
  });
  assert.equal(wrongChain.eligible.length, 0, 'a testnet4 census counted a regtest bond');
  assert.match(wrongChain.excluded[0].why, /no dust output to BOND_MARKER/);

  const rightChain = resolveCensus([entryFor(onTestnet)], {
    contract: round(NETWORK_ID_TESTNET4), resolve: () => ({ transaction: onTestnet }),
  });
  assert.equal(rightChain.eligible.length, 1,
    `a testnet4 census refused a testnet4 bond: ${rightChain.excluded.map((e) => e.why).join(' | ')}`);

  // AND THE MIRROR: a regtest round takes the regtest marker and not the other.
  assert.equal(resolveCensus([entryFor(onRegtest)], {
    contract: round(NETWORK_ID_REGTEST), resolve: () => ({ transaction: onRegtest }),
  }).eligible.length, 1);
  assert.equal(resolveCensus([entryFor(onTestnet)], {
    contract: round(NETWORK_ID_REGTEST), resolve: () => ({ transaction: onTestnet }),
  }).eligible.length, 0, 'a regtest census counted a testnet4 bond');

  // A NETWORK THIS BUILD HAS NO GENESIS FOR IS REFUSED, not guessed at.
  const nowhere = resolveCensus([entryFor(onRegtest)], {
    contract: round(b32(0x77)), resolve: () => ({ transaction: onRegtest }),
  });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.why, /no genesis for/);

  // AND A CONTRACT WITH NO NETWORK AT ALL IS REFUSED. This used to read "no
  // networkId behaves as before, so nothing that used to work stopped
  // working" - and what it did before was answer with the REGTEST marker on
  // every chain, silently. A census that cannot say which marker to look for
  // cannot say a bond is findable, so it says so instead of guessing.
  const unsaid = resolveCensus([entryFor(onRegtest)], {
    contract: { bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION },
    resolve: () => ({ transaction: onRegtest }),
  });
  assert.equal(unsaid.ok, false, 'a round naming no network was still answered with regtest');
  assert.match(unsaid.why, /names no network/);
});
