// 5A.3B: A FRAUD PROOF, AND THE BOND IT NAMES.
//
// 13C's fourth clause and the last of them: "nodes whose signature contradicts
// a replay of the canonical transcript are slashed". 5A.3 gives the offence
// and its proof - transcript + receipts + replay - and 5A.3B gives the five
// steps from proof to transaction. Steps 3 and 5 are an arbitration set with
// MuSig2 keys and a broadcast, which is a daemon and is not here. Steps 1, 2
// and 4 are a portable object, a mechanical check and a hash, which are.
//
// No curve in this file for the same reason there is none in the package: what
// is checked is that the evidence IS the result the proof accuses, and whose
// signature it carries is the caller's to verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  encodePlayerResult, resultId, joinSignedResult,
} from '../src/result.js';
import {
  encodeSlashProof, decodeSlashProof, slashProofId, slashCommitment,
  slashHolds, OFFENCES, TWO_RESULTS, REPLAY_CONTRADICTS, TABLE_IS_NOT_F,
  SETTLED_WITHOUT_AUTHORITY, OPERATOR_PLAYED,
} from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);          // the accused
const HONEST = b32(0x22);        // another seat
const CANON = b32(0x44);         // the canonical transcript
const BOND = b32(0x55);
const committee = [NODE, HONEST, b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];

const resultBy = (node, over = {}) => ({
  roundId: b32(1), playerPubkey: b32(2), outcome: 'DELIVERED', score: 4200,
  transcriptHash: CANON, simCoreHash: b32(3), nodePubkey: node, ...over,
});
const signed = (r) => joinSignedResult(encodePlayerResult(r), new Uint8Array(64).fill(7));

const proofFor = (r, over = {}) => ({
  roundId: r.roundId, playerPubkey: r.playerPubkey, nodePubkey: r.nodePubkey,
  transcriptHash: r.transcriptHash, signedResultId: resultId(r),
  bondTxid: BOND, bondVout: 3, ...over,
});
const advertFor = (node, over = {}) =>
  ({ nodePubkey: node, bondTxid: BOND, bondVout: 3, ...over });

const ask = (over = {}) => {
  const r = resultBy(NODE);
  return slashHolds({
    proof: proofFor(r), signedResult: signed(r), advert: advertFor(NODE),
    committee, canonicalTranscriptHash: CANON, replayDiffers: true, ...over,
  });
};

/**
 * WHICH OF 5A.3'S SIX ROWS ARE IMPLEMENTED, in one place and this one.
 *
 * It has moved twice now - it lived in whichever file added a row last, so
 * every new row broke the previous file's count. Here it is a claim about the
 * MODULE rather than about a row, which is what it always was, and adding the
 * fourth row touches this line and no other.
 *
 * The names are not pretended: 5A.3 lists six offences and a name in this
 * array that answers nothing reads as coverage of one.
 */
test('five of 5A.3\'s six rows are implemented, and the last is not pretended', () => {
  assert.deepEqual(OFFENCES,
    [TWO_RESULTS, REPLAY_CONTRADICTS, TABLE_IS_NOT_F, SETTLED_WITHOUT_AUTHORITY,
     OPERATOR_PLAYED],
    'and in 5A.3\'s own document order, which is the order they were written in');
});

/**
 * THE ONE THIS SLICE EXISTS FOR, before and after.
 *
 * The same proof, the same evidence, the same bond - and the only thing that
 * moves is the replay verdict, which is injected because neither this package
 * nor the daemon steps a simulation.
 */
test('a result the canonical transcript does not replay to slashes the named bond', () => {
  const before = ask({ replayDiffers: false });
  assert.equal(before.slashed, false, 'a bond was taken with no replay behind it');
  assert.equal(before.bond, undefined, 'and no bond may even be NAMED without one');
  assert.match(before.why, /no replay has contradicted/);

  const after = ask({ replayDiffers: true });
  assert.equal(after.slashed, true, after.why);
  assert.equal(after.offence, REPLAY_CONTRADICTS);
  assert.equal(toHex(after.bond.txid), toHex(BOND), 'the bond the node itself advertised');
  assert.equal(after.bond.vout, 3);

  // 5A.3B step 4: the transaction has to commit to the proof, so the proof
  // has to have one hash and this is it.
  const r = resultBy(NODE);
  assert.equal(toHex(after.commitment), toHex(slashProofId(proofFor(r))));
});

test('an accusation nobody has replayed is a claim, whatever it is dressed as', () => {
  for (const verdict of [undefined, null, false, 'yes', 1, {}])
    assert.equal(ask({ replayDiffers: verdict }).slashed, false,
      `a bond was taken on ${JSON.stringify(verdict)}`);
});

test('the accuser cannot name a bond the node never advertised', () => {
  const r = resultBy(NODE);
  const someoneElses = slashHolds({
    proof: proofFor(r, { bondTxid: b32(0x99) }), signedResult: signed(r),
    advert: advertFor(NODE), committee, canonicalTranscriptHash: CANON, replayDiffers: true,
  });
  assert.equal(someoneElses.slashed, false);
  assert.match(someoneElses.why, /the proof names bond 9999/);

  const wrongVout = slashHolds({
    proof: proofFor(r, { bondVout: 4 }), signedResult: signed(r),
    advert: advertFor(NODE), committee, canonicalTranscriptHash: CANON, replayDiffers: true,
  });
  assert.equal(wrongVout.slashed, false, 'a different output of the right transaction is a different bond');

  assert.equal(ask({ advert: undefined }).slashed, false);
  assert.match(ask({ advert: advertFor(HONEST) }).why, /no advertisement from the accused node/);
});

test('the evidence has to be the result the proof accuses', () => {
  const r = resultBy(NODE);
  const other = resultBy(NODE, { score: 9 });

  const swapped = slashHolds({
    proof: proofFor(r), signedResult: signed(other), advert: advertFor(NODE),
    committee, canonicalTranscriptHash: CANON, replayDiffers: true,
  });
  assert.equal(swapped.slashed, false);
  assert.match(swapped.why, /not the one this proof names/);

  // and a proof that renames its target to match still names another node's
  const borrowed = slashHolds({
    proof: proofFor(resultBy(HONEST), { nodePubkey: NODE }),
    signedResult: signed(resultBy(HONEST)), advert: advertFor(NODE),
    committee, canonicalTranscriptHash: CANON, replayDiffers: true,
  });
  assert.equal(borrowed.slashed, false);
  assert.match(borrowed.why, /signed by a different node/);
});

/**
 * A NODE THAT ANSWERED A DIFFERENT QUESTION DID NOT LIE ABOUT THIS ONE.
 *
 * A result signed about another transcript is 13C's no-quorum case - the
 * committee did not agree - and that path is VOID or FORFEIT, not a slash. A
 * replay of the canonical object contradicts only a result that named it.
 */
test('a result about another transcript is not contradicted by this replay', () => {
  const r = resultBy(NODE, { transcriptHash: b32(0x77) });
  const no = slashHolds({
    proof: proofFor(r, { transcriptHash: CANON, signedResultId: resultId(r) }),
    signedResult: signed(r), advert: advertFor(NODE),
    committee, canonicalTranscriptHash: CANON, replayDiffers: true,
  });
  assert.equal(no.slashed, false);
  assert.match(no.why, /signed about a different transcript/);

  // nor is a proof that points at a transcript nobody made canonical
  assert.match(ask({ canonicalTranscriptHash: b32(0x78) }).why, /not the canonical one/);
  assert.match(ask({ canonicalTranscriptHash: undefined }).why, /no canonical transcript/);
});

test('a stranger cannot be slashed for a round they were not serving', () => {
  const r = resultBy(b32(0x66));
  const stranger = slashHolds({
    proof: proofFor(r), signedResult: signed(r), advert: advertFor(b32(0x66)),
    committee, canonicalTranscriptHash: CANON, replayDiffers: true,
  });
  assert.equal(stranger.slashed, false);
  assert.match(stranger.why, /is not on this round's committee/);
  assert.equal(ask({ committee: [] }).slashed, false);
});

test('a result for another round or another player is not this offence', () => {
  const r = resultBy(NODE);
  for (const [field, why] of [['roundId', /different round/], ['playerPubkey', /different player/]]) {
    const p = proofFor(r);
    p[field] = b32(0x8a);
    const no = slashHolds({
      proof: p, signedResult: signed(r), advert: advertFor(NODE),
      committee, canonicalTranscriptHash: CANON, replayDiffers: true,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, why);
  }
});

test('the proof survives the round trip and keeps its commitment', () => {
  const p = proofFor(resultBy(NODE));
  const back = decodeSlashProof(encodeSlashProof(p));
  assert.deepEqual(back, p);
  assert.equal(toHex(slashCommitment(back)), toHex(slashCommitment(p)));

  const longer = new Uint8Array(encodeSlashProof(p).length + 1);
  longer.set(encodeSlashProof(p));
  assert.throws(() => decodeSlashProof(longer), /trailing bytes/);
});

test('changing anything in the proof changes what a transaction commits to', () => {
  const p = proofFor(resultBy(NODE));
  const was = toHex(slashCommitment(p));
  for (const field of ['roundId', 'playerPubkey', 'nodePubkey', 'transcriptHash',
                       'signedResultId', 'bondTxid'])
    assert.notEqual(toHex(slashCommitment({ ...p, [field]: b32(0x9c) })), was, field);
  assert.notEqual(toHex(slashCommitment({ ...p, bondVout: 4 })), was, 'bondVout');
});

test('rubbish is refused as evidence rather than decoded into an offence', () => {
  const r = resultBy(NODE);
  for (const bad of [new Uint8Array(0), new Uint8Array(232), new Uint8Array(10)]) {
    const no = slashHolds({
      proof: proofFor(r), signedResult: bad, advert: advertFor(NODE),
      committee, canonicalTranscriptHash: CANON, replayDiffers: true,
    });
    assert.equal(no.slashed, false);
    assert.match(no.why, /not a signed result|not the one this proof names/);
  }
});
