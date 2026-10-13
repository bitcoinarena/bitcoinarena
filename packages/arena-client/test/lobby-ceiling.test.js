// THE STAKE CEILING ON A PAID LOBBY ROW (§5A.10, kanban #306): computed from the census the page checked; on a test network shown
// and never a refusal, on mainnet a refusal by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lobbyLine, ceilingWords } from '../src/lobby.js';
import { stakeWithinCeiling } from '../../arena-protocol/src/census-health.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
// no mainnet genesis yet: any network that is not a test network refuses
const NETWORK_ID_MAINNET = new Uint8Array(32).fill(0xee);

const node = (n, bond) => ({ pubkey: new Uint8Array(32).fill(n), roles: ['game', 'settlement'], bondSats: bond });
const row = (census, networkId) => ({ free: false, stakeMsat: 100000n, phase: 'open', entryCloseMs: 2_000_000, signerNodesAgree: 7, needed: 5, joinable: true,
  said: [], names: [], seating: null, disagrees: [], contract: { networkId } });

test('seven nodes on testnet4: play money only, a 100 sat stake over it, shown and not enforced', () => {
  const census = [1, 2, 3, 4, 5, 6, 7].map((n) => node(n, 1_000_000));
  const line = lobbyLine(row(census, NETWORK_ID_TESTNET4), 1_000_000, { census });
  assert.match(line, /stake ceiling: play money only - this stake is over it \(a test network: shown, not enforced\)/);
});

test('fifteen well-bonded nodes on a network that is not a test network: up to 100 sat, a 100 sat stake within it; over it on mainnet is refused by name', () => {
  const census = Array.from({ length: 15 }, (_, i) => node(i + 1, 1_000_000));
  assert.match(lobbyLine(row(census, NETWORK_ID_MAINNET), 1_000_000, { census }), /stake ceiling: up to 100 sat a stake - this stake is within it/);
  assert.equal(ceilingWords(stakeWithinCeiling({ entries: census, stakeSats: 1000n }), { networkId: NETWORK_ID_MAINNET }), ' · stake ceiling: up to 100 sat a stake - this stake is over it: refused');
  assert.equal(lobbyLine(row(null, NETWORK_ID_MAINNET), 1_000_000, {}).includes('stake ceiling'), false, 'no census read, no claim about it');
});
