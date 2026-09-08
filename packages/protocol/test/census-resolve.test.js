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
import { parseTransaction } from '../src/tx.js';
import { bondTransaction } from '../tools/bond.js';
import { resolveCensus } from '../src/census.js';
import { fromHex } from '../src/hash.js';

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
  roles: ['game'], endpoint: `ws://node${n}`, region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), timestamp: 1788700000000n, ...over,
});
const bondOf = (n, over = {}) =>
  bondTransaction(advertFor(n, over), { previousTxid: b32(0xa0 + n), previousVout: 0 });

const contract = { bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION };
const entryFor = (n, over = {}) => ({
  txid: parseTransaction(bondOf(n, over.advert || {})).txid, vout: 0,
  pubkey: b32(n), bondSats: 60000n, height: 900000, roles: ['game'], spent: false,
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
  const { entries, map } = rig();
  entries[1] = { ...entries[1], bondSats: 49999n };

  const strict = resolveCensus(entries, { contract, resolve: resolverFor(map) });
  assert.equal(strict.eligible.length, 2);
  assert.match(strict.excluded[0].why, /that bond is 49999 where this round's floor is 50000/);

  const smaller = resolveCensus(entries, {
    contract: { bondMinSats: 10000n, protocolVersion: PROTOCOL_VERSION }, resolve: resolverFor(map),
  });
  assert.equal(smaller.eligible.length, 3,
    'the network stratifies; it does not evict');

  // exactly the floor is in: 5A.3 says >=
  const exact = resolveCensus([{ ...entries[1], bondSats: 50000n }], {
    contract, resolve: resolverFor(map),
  });
  assert.equal(exact.eligible.length, 1);
});

test('an advertisement that declares no role, or no version we speak, is out', () => {
  const { entries, map } = rig();

  const noRole = { transaction: bondOf(0x21, { roles: [] }) };
  const seen = resolveCensus([entryFor(0x21, { advert: { roles: [] } })], {
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
    contract: { bondMinSats: 50000n }, resolve: () => tx,
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
  assert.match(seen.unchecked[0], /BOND_MARKER/);
  assert.match(seen.unchecked[1], /bond script template/);
  assert.match(seen.unchecked[2], /advertisement signature/);
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
    bondSats: 60000n, height: 900000, roles: ['game'], spent: false,
  };
  const seen = resolveCensus([entry], { contract, resolve: () => ({ transaction: wrong }) });
  assert.equal(seen.eligible.length, 0, 'a body nothing committed to was taken');
  assert.match(seen.excluded[0].why, /commits to a different advertisement/);
});

test('a transaction that commits to nothing at all resolves nothing', () => {
  const entry = {
    txid: parseTransaction(LEGACY_100000).txid, vout: 0, pubkey: b32(0x41),
    bondSats: 60000n, height: 900000, roles: ['game'], spent: false,
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
    bondSats: 60000n, height: 900000, roles: ['settlement'], spent: false,
  };
  const seen = resolveCensus([entry], { contract, resolve: () => ({ transaction: tx }) });

  assert.equal(seen.eligible.length, 1);
  assert.deepEqual(seen.eligible[0].roles, ['game'],
    'the census believed a role the advertisement never declared');
  assert.deepEqual(seen.eligible[0].advert.roles, ['game']);
});
