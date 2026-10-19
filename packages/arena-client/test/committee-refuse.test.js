// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT COMPUTES THE COMMITTEE ITSELF, AND A SEAT THAT SAYS OTHERWISE REFUSES THE ROUND (multiplayer_p2p.md, "The client computes
// the committee itself", RULED 2026-09-28: "a node's committee answer, a contract's node list or a seating certificate that
// differs from the client's own computation -> the round is refused, the lobby says which node answered what, and no share is sealed,
// no stake locked, no entry signed")., measured 2026-10-16 on live testnet4: guardian-3 forging its /committee was
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

test('the page: a round refused for a seat\'s committee or seating is kept out of the lobby, as a closed round is', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const at = html.indexOf('          const refuse = (why) => {');
  const body = html.slice(at, html.indexOf('\n          };\n', at));
  assert.match(body, /if \(\/the round is refused: \/\.test\(join\.why\)\) \(window\.ARENA_CLOSED_ROUNDS = window\.ARENA_CLOSED_ROUNDS \|\| new Set\(\)\)\.add\(id\);/);
});

// GENESIS-BOUND PARAMETERS AT JOIN TIME (2026-10-16: "On a test genesis that binds, a deviating contract is
// refused by the seat and by the client, by parameter name"). The binding genesis here is mainnet's shape built from stand-in launch
// inputs inside the test - no mainnet genesis exists in this build. testnet4's own genesis does not bind: its contracts keep their values.
test('a binding genesis: the join refuses a contract by the parameter it names otherwise, before asking any seat', async () => {
  const { mainnetGenesis, genesisFor } = await import('../../arena-protocol/src/genesis.js');
  const { NETWORK_ID_TESTNET4 } = await import('../../arena-protocol/src/genesis-ids.js');
  const { pageCurve } = await import('../src/page-curve.js');
  const { clientCommittee, clientSettlementSignerNodes } = await import('../src/committee.js');
  const b = (n) => new Uint8Array(32).fill(n);
  const { genesis } = mainnetGenesis({ bondMarker: b(1), arbitrationKeys: [2, 3, 4, 5, 6, 7, 8].map(b), authorityPubkey: b(9), recoveryPubkey: b(10),
    genesisSeriesStartMs: 1800000000000n, bondMinGuardianSats: 1_000_000n });
  const asked = [];
  const fetcher = async (u) => { asked.push(u); throw new Error('no seat should be asked'); };
  const contract = { networkId: NETWORK_ID_TESTNET4, gameVerifySlots: 7, settlementSlots: 7, censusConfirmations: 2, censusRoot: b(4) };
  const got = await clientCommittee('ab'.repeat(32), contract, ['https://s1'], { curve: pageCurve, fetcher, genesis });
  assert.equal(got.ok, false);
  assert.equal(got.why, 'the round is refused: this network\'s genesis binds the contract, and it names census_confirmations 2, the genesis binds 6');
  await assert.rejects(clientSettlementSignerNodes('ab'.repeat(32), { ...contract, gameVerifySlots: 3, censusConfirmations: 6 }, ['https://s1'], { curve: pageCurve, fetcher, genesis }),
    /could not build the round's committee itself: the round is refused: .* game_verify_slots 3, the genesis binds 7/);
  assert.deepEqual(asked, [], 'refused before any seat was asked');
  // testnet4's own genesis does not bind: the same deviating contract is not refused for it (it goes on to ask the seats)
  assert.equal(!!genesisFor('testnet4').committeesBind, false, 'testnet4 does not bind');
  const live = await clientCommittee('ab'.repeat(32), contract, ['https://s1'], { curve: pageCurve, fetcher });
  assert.doesNotMatch(String(live.why), /genesis binds/);
});
