// BEFORE APPROVAL (spec §22A Transparency, §5A.13; kanban #317): the selected node identities (or pending), the committee
// overlap and whether a selected operator is playing - on the paying row's lobby line, from its seating, the checked census
// (operator_id per node) and the round's checked players.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalFacts, approvalWords, lobbyLine } from '../src/lobby.js';

const k = (n) => n.repeat(64).slice(0, 64);
const nodes = ['1', '2', '3', '4', '5', '6', '7'].map(k);
const census = nodes.map((n, i) => ({ pubkey: Uint8Array.from(Buffer.from(n, 'hex')), advert: { operatorId: i < 4 ? k('a') : k('b') } }));
const row = (over = {}) => ({ free: false, phase: 'open', joinable: true, stakeMsat: 100000n, committeeTimeMs: 0, entryCloseMs: 60000,
  signerNodesAgree: 7, needed: 5, said: [], names: [], disagrees: [], contract: {},
  seating: { state: 'named', game: nodes.slice(0, 7), settlement: [...nodes.slice(2, 7), nodes[0], nodes[1]] }, ...over });

test('the facts: identities with their operators, the overlap, an operator playing - and pending before a certificate', () => {
  const f = approvalFacts(row(), census);
  assert.deepEqual([f.pending, f.of, f.both, f.operators.length, f.operatorsPlaying.length], [false, 7, 7, 2, 0]);
  assert.equal(f.settlement[0].operator, k('a'));
  assert.equal(approvalWords(f), ` · 2 operators (aaaaaaaa, bbbbbbbb) · in both committees: 7 of 7 · no selected operator is playing`);
  const playing = approvalFacts(row({ names: [{ player: k('b'), name: 'op-b' }, { player: k('9'), name: 'x' }] }), census);
  assert.deepEqual(playing.operatorsPlaying, [k('b')]);
  assert.match(approvalWords(playing), /a selected operator is playing: bbbbbbbb$/);
  assert.equal(approvalWords(approvalFacts(row({ seating: { state: 'pending' } }), census)), ' · selected nodes: pending (§5A.5)');
  assert.match(approvalWords(approvalFacts(row(), null)), /operators not read yet · in both committees: 7 of 7/);
  // split committees: only 2 of the game's sit in the settlement
  assert.equal(approvalFacts(row({ seating: { state: 'named', game: nodes.slice(0, 3), settlement: nodes.slice(1, 3) } }), census).both, 2);
});

test('the paying row\'s lobby line says them; a free row does not', () => {
  // and, since kanban #306, the stake ceiling the page computes from that census, last
  assert.match(lobbyLine(row(), 0, { census: () => census }), /· 2 operators \(aaaaaaaa, bbbbbbbb\) · in both committees: 7 of 7 · no selected operator is playing · stake ceiling: [^·]+$/);
  assert.doesNotMatch(lobbyLine(row({ free: true }), 0, { census: () => census }), /operator/);
});
