// THE CLIENT COMPUTES THE COMMITTEE ITSELF, AND A SEAT THAT SAYS OTHERWISE REFUSES THE ROUND (multiplayer_p2p.md, "The client computes
// the committee itself", RULED the owner 2026-09-28: "a node's committee answer, a contract's node list or a seating certificate that
// differs from the client's own computation -> the round is refused, the lobby says which node answered what, and no share is sealed,
// no stake locked, no entry signed"). Kanban #32 slice 2, measured 2026-10-16 on live testnet4: guardian-3 forging its /committee was
// named and the join still dealt to the client's seven, on 12 of 12 rounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementSignerNodesFrom } from '../src/committee.js';

const k = (n) => new Uint8Array(32).fill(n);
const SEVEN = [1, 2, 3, 4, 5, 6, 7].map(k);
const derived = (over = {}) => ({ ok: true, committees: { game: SEVEN, settlement: SEVEN }, beacon: { height: 156663 },
  seating: { game: { seated: SEVEN, from: 'https://g1' }, settlement: { seated: SEVEN, from: 'https://g1' } },
  seats: [{ node: 'https://g1', agrees: true, why: null }, { node: 'https://g2', agrees: true, why: null }], censusRefused: [], ...over });

test('every seat agrees: the client\'s settlement committee is dealt to', () => {
  const got = settlementSignerNodesFrom(derived());
  assert.equal(got.signerNodes.length, 7);
  assert.equal(got.agreed, 2);
});

test('one seat names another committee: the round is refused and the seat named with what it answered', () => {
  const liar = { node: 'https://g3', agrees: false, why: 'names another settlement committee (66666666) than the one this client derived (01010101, 02020202)' };
  assert.throws(() => settlementSignerNodesFrom(derived({ seats: [...derived().seats, liar] })),
    /^Error: the round is refused: https:\/\/g3 names another settlement committee \(66666666\) than the one this client derived .* - nothing is sealed, locked or signed$/);
});

test('a seating certificate that does not match the draw refuses the round, naming the seat', () => {
  const seating = { ...derived().seating, settlement: { seated: SEVEN, from: 'https://g2', refused: ['https://g1: the certificate\'s signatures do not verify'] } };
  assert.throws(() => settlementSignerNodesFrom(derived({ seating })), /the round is refused: a settlement seating certificate that does not match this client's draw - https:\/\/g1:/);
});

test('a seat that does not hold the round (no answer) is not a liar: the round stands', () => {
  const quiet = { node: 'https://g7', agrees: null, why: 'answered 409' };
  assert.equal(settlementSignerNodesFrom(derived({ seats: [...derived().seats, quiet] })).signerNodes.length, 7);
});

test('a seat whose census did not hash to the root is named; the census of the next seat stood, so the round stands', () => {
  const got = settlementSignerNodesFrom(derived({ censusRefused: [{ node: 'https://g1', why: 'its census hashes to cea6027a..., not the contract\'s root' }] }));
  assert.deepEqual(got.refused, ['https://g1: its census hashes to cea6027a..., not the contract\'s root']);
});

test('a derivation that failed, or no seating yet, refuses as before', () => {
  assert.throws(() => settlementSignerNodesFrom({ ok: false, why: 'no agreed headers: only 1 of 4 providers gave a chain' }), /could not build the round's committee itself: no agreed headers/);
  assert.throws(() => settlementSignerNodesFrom(derived({ seating: { game: { missing: true, refused: [] }, settlement: null } })), /no signer nodes yet/);
});
