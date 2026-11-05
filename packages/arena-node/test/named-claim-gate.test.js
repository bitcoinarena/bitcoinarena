// PROTOCOL 27'S GATE, CACHED PER FEDERATION (kanban #1044 B1, ruling #1134 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { namedClaims } from '../../arena-protocol/src/arena-lock.js';
import { NamedClaimGate } from '../src/named-claim-gate.js';

const round = (over = {}) => ({ protocolVersion: 27, networkId: NETWORK_ID_REGTEST, censusHeight: 5, ...over });
const settle = () => new Promise((r) => setImmediate(r));

test('a protocol-27 round at the height locks to an Arena lock; a protocol-26 round or testnet4 (null) does not', () => {
  assert.equal(namedClaims(round()), true);
  assert.equal(namedClaims(round({ protocolVersion: 26 })), false);
  assert.equal(namedClaims(round({ networkId: NETWORK_ID_TESTNET4 })), false);
  assert.equal(namedClaims(round({ censusHeight: 99 }), () => 100), false);
});

test('refused until a threshold reports 1.100; a yes is kept for good, a no asked again after a minute', async () => {
  let t = 0, asked = 0, answer = { major: 1, minor: 0 };
  const gate = new NamedClaimGate({ versionOf: async () => { asked++; return answer; }, now: () => t });
  assert.match(gate.refusal(round(), 'aa'), /asked now/);
  await settle();
  assert.equal(asked, 1);
  assert.match(gate.refusal(round(), 'aa'), /LNv2 module version 1.0, needs 1.100/);
  assert.equal(asked, 1);
  answer = { major: 1, minor: 100 };
  t = 60001;
  gate.refusal(round(), 'aa');
  await settle();
  assert.equal(asked, 2);
  assert.equal(gate.refusal(round(), 'aa'), null);
  t = 10_000_000;
  assert.equal(gate.refusal(round(), 'aa'), null);
  assert.equal(asked, 2);
  // a protocol-26 round is never gated and never asks
  assert.equal(gate.refusal(round({ protocolVersion: 26 }), 'bb'), null);
  assert.equal(asked, 2);
});

test('a lock taken now waits for the answer; a federation that cannot answer (stock LNv2) is refused', async () => {
  const gate = new NamedClaimGate({ versionOf: async (fid) => { if (fid === 'stock') throw new Error('no such endpoint'); return { major: 1, minor: 100 }; } });
  assert.equal(await gate.refusalNow(round(), 'fork'), null);
  assert.match(await gate.refusalNow(round(), 'stock'), /no threshold answer/);
  assert.equal(await gate.refusalNow(round({ protocolVersion: 26 }), 'stock'), null);
});
