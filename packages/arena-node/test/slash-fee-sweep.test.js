// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FILER SWEEPS ITS REPAID FEE (spec 5A.3B: `filer` repays the start's fee input to its own script, a key the seat derives from its node key and the proof; kanban #972, decision
// #1083). The release is read from a seat's door, its output from the chain (gettxout without the mempool: only confirmed outputs answer). The sweep is a real script-path spend under
// that key, checked here as Bitcoin checks it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { HOLD_INTERNAL_KEY, tapLeafHash, tapTweak } from '../../arena-protocol/src/bond-script.js';
import { tapSighash } from '../../arena-protocol/src/bond-spend.js';
import { buildSlashPayoutTable, encodeSlashPayoutTable, slashPayoutTableId } from '../../arena-protocol/src/slash.js';
import { vsizeOfSpend } from '../../arena-protocol/src/slash-release.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { tweakPoint } from '../src/curve.js';
import { createSlashStarter } from '../src/slash-start-run.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const nodeSecret = taggedHash('ARENA/test/FeeSweep', Uint8Array.of(1));
const nodeKey = schnorr.getPublicKey(nodeSecret);
// AS THE SEAT DERIVES IT (server.js): the node's secret and the proof's hash
const feeSecret = (proofId) => taggedHash('ARENA/v1/SlashFeeKey', Uint8Array.from([...nodeSecret, ...proofId]));
const proofId = b32(0x61);
const leaf = Uint8Array.from([0x20, ...schnorr.getPublicKey(feeSecret(proofId)), 0xac]);
const q = tweakPoint(HOLD_INTERNAL_KEY, tapTweak(HOLD_INTERNAL_KEY, tapLeafHash(leaf)));
const feeScript = fromHex(`5120${toHex(q.outputKey)}`);
const wallet = fromHex(`0014${'77'.repeat(20)}`);
const START = 'ab'.repeat(32), RELEASE = 'cd'.repeat(32), FALLBACK = 'ce'.repeat(32), RATE = 3;

/** A release's table that repays `script` 700 sat as its first output (tx output 1, after the OP_RETURN). */
function tableOf(script) {
  const built = buildSlashPayoutTable({ networkId: NETWORK_ID_REGTEST, roundId: b32(0x51), proofId, bond: { txid: b32(0x71), vout: 1, value: 1_000_000n }, entries: [],
    filer: { script, sats: 700n }, carriers: [], federations: [], feeSats: 500n, escrowScript: fromHex(`5120${'79'.repeat(32)}`) });
  assert.ok(built.ok, built.why);
  return built.table;
}

function seat({ db = new DatabaseSync(':memory:'), served, chain, sent, clock, returns = [] }) {
  const starter = createSlashStarter({ key: nodeKey, network: 'regtest', db, store: { held: () => null }, thresholdOf: () => null, tipHeight: async () => 500, entriesAtTip: async () => [],
    heldProofs: async () => [], bytesOf: () => null, judge: Object.assign(async () => ({}), { read: () => ({ ok: false }) }), holdsFor: () => ({ holds: [] }), feeCoin: async () => ({ ok: false }),
    urlsOf: () => ['http://peer'], feeSecret, now: () => clock.ms, sweepEveryMs: 60000,
    fetchFn: async (url) => { const u = new URL(url); const body = u.pathname === '/slash-release' && u.searchParams.get('start') === START ? served() : {}; return { ok: true, json: async () => body }; },
    txOut: async (txid, vout) => { chain.reads += 1; const o = chain.outputs.get(`${txid}:${vout}`); return o ? { sats: o.sats, script: toHex(o.script), confirmations: 1 } : null; },
    returnScript: async () => { returns.push(1); return wallet; },
    send: async (hex) => {
      const txid = toHex([...parseTransaction(fromHex(hex)).txid].reverse());
      if (sent.some((s) => s.txid === txid)) throw new Error('txn-already-in-mempool');
      sent.push({ hex, txid });
      return txid;
    } });
  return { starter, db };
}

const filed = (db) => {
  db.prepare('INSERT INTO slash_starts (proof_id, bond, txid, kept_ms) VALUES (?, ?, ?, ?)').run(proofId, `${'71'.repeat(32)}:1`, START, 0);
  db.prepare('INSERT INTO slash_fee_sweeps (proof_id, rate, state) VALUES (?, ?, ?)').run(proofId, RATE, '{}');
};

test('the repaid fee is swept once the release is confirmed, to this node\'s wallet, at the start\'s rate, under the key from the node and the proof', async () => {
  const table = tableOf(feeScript), clock = { ms: 0 }, sent = [], returns = [];
  const chain = { outputs: new Map(), reads: 0 };
  const release = { release: { txid: RELEASE, tableId: toHex(slashPayoutTableId(table)), table: toHex(encodeSlashPayoutTable(table)) } };
  const s = seat({ served: () => release, chain, sent, clock, returns });
  filed(s.db);
  // NOT IN A BLOCK YET: gettxout without the mempool says nothing, and nothing is sent
  assert.deepEqual(await s.starter.sweep(), []);
  assert.equal(sent.length, 0);
  clock.ms += 30000;
  await s.starter.sweep();
  assert.equal(chain.reads, 1, 'the doors are asked again only after sweepEveryMs');
  // CONFIRMED
  chain.outputs.set(`${RELEASE}:1`, { sats: 700n, script: feeScript });
  clock.ms += 60000;
  const [r] = await s.starter.sweep();
  assert.equal(sent.length, 1);
  assert.equal(r.swept, sent[0].txid);
  const tx = parseTransaction(fromHex(sent[0].hex));
  assert.equal(toHex([...tx.inputs[0].previousTxid].reverse()), RELEASE);
  assert.equal(tx.inputs[0].previousVout, 1, 'the table\'s first output is the transaction\'s second, after the OP_RETURN');
  assert.equal(tx.outputs.length, 1);
  assert.equal(toHex(tx.outputs[0].script), toHex(wallet));
  const vsize = vsizeOfSpend({ version: 2, locktime: 0, inputs: tx.inputs.map((i) => ({ txid: i.previousTxid, vout: i.previousVout, sequence: i.sequence })), outputs: tx.outputs, witnesses: tx.witnesses });
  assert.equal(tx.outputs[0].value, 700n - BigInt(RATE * vsize), 'the start\'s rate times its own size');
  assert.equal(r.sats, tx.outputs[0].value);
  // AS BITCOIN CHECKS IT: the leaf and control block open the output key, and the signature is the leaf key's over the BIP-341 sighash
  const [sig, script, control] = tx.witnesses[0];
  assert.equal(toHex(script), toHex(leaf));
  assert.equal(toHex(control.subarray(1)), toHex(HOLD_INTERNAL_KEY));
  assert.equal(control[0] & 1, q.parity);
  const digest = tapSighash({ version: 2, locktime: 0, inputs: [{ txid: tx.inputs[0].previousTxid, vout: 1, sequence: tx.inputs[0].sequence }], outputs: tx.outputs, prevouts: [{ value: 700n, script: feeScript }], inputIndex: 0, leafHash: tapLeafHash(leaf) });
  assert.ok(schnorr.verify(sig, digest, schnorr.getPublicKey(feeSecret(proofId))));

  // IN THE MEMPOOL, NOT YET IN A BLOCK: sent again only after sweepEveryMs, the same txid, which the chain already holds
  assert.deepEqual(await s.starter.sweep(), []);
  clock.ms += 60000;
  assert.deepEqual(await s.starter.sweep(), []);
  assert.equal(sent.length, 1, 'one sweep');
  // IN A BLOCK: the output is gone, and that is the end of it, after a restart too
  chain.outputs.delete(`${RELEASE}:1`);
  const [end] = await s.starter.sweep();
  assert.deepEqual([end.done, end.swept], [true, sent[0].txid]);
  const reads = chain.reads;
  clock.ms += 600000;
  assert.deepEqual(await s.starter.sweep(), []);
  const again = seat({ db: s.db, served: () => release, chain, sent, clock, returns });
  assert.deepEqual(await again.starter.sweep(), []);
  assert.equal(chain.reads, reads, 'a swept fee is not read again');
  assert.equal(returns.length, 1, 'the wallet script is asked once and kept, so a resend is the same transaction');
});

test('a fallback repays it as well; a table that repays another script, or a chain output that is not that table\'s, sweeps nothing', async () => {
  // ANOTHER FILER'S START LANDED: its table repays its own coin
  const other = tableOf(fromHex(`5120${'88'.repeat(32)}`)), clock = { ms: 0 }, sent = [];
  const chain = { outputs: new Map([[`${RELEASE}:1`, { sats: 700n, script: feeScript }]]), reads: 0 };
  const s = seat({ served: () => ({ release: { txid: RELEASE, tableId: toHex(slashPayoutTableId(other)), table: toHex(encodeSlashPayoutTable(other)) } }), chain, sent, clock });
  filed(s.db);
  assert.deepEqual(await s.starter.sweep(), []);
  assert.equal(chain.reads, 0, 'no output of that table is this seat\'s to read');
  // THE TABLE REPAYS THIS SEAT, BUT THE CHAIN HOLDS ANOTHER VALUE THERE
  const mine = tableOf(feeScript);
  const served = { release: { txid: RELEASE, tableId: toHex(slashPayoutTableId(mine)), table: toHex(encodeSlashPayoutTable(mine)) },
    fallback: { txid: FALLBACK, tableId: toHex(slashPayoutTableId(mine)), table: toHex(encodeSlashPayoutTable(mine)) } };
  const t = seat({ served: () => served, chain: { outputs: new Map([[`${RELEASE}:1`, { sats: 699n, script: feeScript }]]), reads: 0 }, sent, clock });
  filed(t.db);
  assert.deepEqual(await t.starter.sweep(), []);
  assert.equal(sent.length, 0);
  // THE FALLBACK IS THE ONE IN A BLOCK
  const u = seat({ served: () => served, chain: { outputs: new Map([[`${FALLBACK}:1`, { sats: 700n, script: feeScript }]]), reads: 0 }, sent, clock });
  filed(u.db);
  const [r] = await u.starter.sweep();
  assert.ok(r && r.swept, r && r.why);
  assert.equal(toHex([...parseTransaction(fromHex(sent[0].hex)).inputs[0].previousTxid].reverse()), FALLBACK);
});
