// wf1489 r21 census-1: GET /census (roster.censusEvidenceFor) rebuilds every entry's merkle branch - a whole merkle tree of the
// bond's block per entry - on EVERY request; a stranger repeating GET /census?round=<held round> holds the seat's event loop.
// Safe behaviour: the evidence of a round's census is built once per view; a repeat ask costs (almost) nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../src/roster.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';

const rawTx = (n) => {
  const b = new Uint8Array(4 + 1 + 36 + 1 + 4 + 1 + 8 + 1 + 4);
  b[0] = 2; b[4] = 1;
  b[5] = n & 255; b[6] = (n >> 8) & 255; b[7] = (n >> 16) & 255; b[8] = 0xab;   // unique outpoint
  b[46] = 1;                                                                     // one output, value 0, empty script
  return b;
};

test('a repeated GET /census for one round does not rebuild every merkle branch', () => {
  const TXS = 6000, ENTRIES = 40;
  const transactions = Array.from({ length: TXS }, (_, i) => rawTx(i));
  const view = { firstHeight: 100, blocks: [{ header: new Uint8Array(80), transactions }] };
  const contract = { censusHeight: 100, networkId: new Uint8Array(32) };
  const round = { contractOf: () => contract, get: () => null, db: null };
  const roster = new Roster(round, { chainFor: () => view });
  const entries = Array.from({ length: ENTRIES }, (_, i) => ({ txid: parseTransaction(transactions[i * 100]).txid, pubkey: new Uint8Array(32) }));
  roster.censusFor = () => ({ ok: true, entries, root: new Uint8Array(32), excluded: [] });
  const rid = new Uint8Array(32).fill(7);
  const first = roster.censusEvidenceFor(rid);
  assert.equal(first.ok, true, first.why);
  assert.equal(first.entries.length, ENTRIES);
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) roster.censusEvidenceFor(rid);
  const ms = (performance.now() - t0) / 5;
  console.log(`GET /census evidence: ${ms.toFixed(1)} ms per repeated ask (${ENTRIES} entries, block of ${TXS} txs)`);
  assert.ok(ms < 20, `each repeated GET /census costs ${ms.toFixed(1)} ms of the event loop - a stranger's loop of asks stalls the seat`);
});
