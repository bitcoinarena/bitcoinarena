// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FALSE TABLE, READ BY THE ARBITRATION SERVICE RUN WHOLE (§5A.3 table row, kanban #1040, #1043): the service against a seat of a real round and the chain under it, with its own client of the federation
// standing in for the stock tool. A false pair is judged, posted and published as TABLE_IS_NOT_F; an honest pair a lying seat lists is refused and costs nothing; with no client of the federation the
// proof waits, since no read was made. What the seat files and how: protocol22-paid.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes, b32, WINDOW_MS } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { stubBitcoind } from './stub-bitcoind.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { arbitrationCommitmentIn } from '../../arena-protocol/src/arbitration-tx.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { bondSetFor } from '../src/curve.js';
import { decodeRoundContract, decodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { encodeSlashProof, joinTableSlashEvidence } from '../../arena-protocol/src/slash.js';
import { signSettlementAck, settlementAckId, encodeSettlementTable, settlementTableId } from '../../arena-protocol/src/settlement-ack.js';
import { settlementNonce } from '../../arena-protocol/src/lock-settlement.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

// THE STOCK TOOL'S TWO ANSWERS A JUDGEMENT ASKS: the guardians' fee rule, and the hash of what it is told to rebuild
const TOOL = `#!/usr/bin/env node
const { createHash } = require('node:crypto');
const a = process.argv.slice(2), at = (k) => a[a.indexOf('--' + k) + 1];
if (at('mode') === 'fees') console.log(JSON.stringify({ fee_ppm: 0, fee_base_msat: 0 }));
else console.log(JSON.stringify({ txid: createHash('sha256').update([at('locks'), at('payouts'), at('nonce')].join('|')).digest('hex'), message_hex: '00', accepted: false }));
`;
const toolTxid = async (build) => {
  const { createHash } = await import('node:crypto');
  const locks = build.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${toHex(c.preimage)}:${c.amountMsat}`).join(',');
  const payouts = build.payouts.map((p) => `${toHex(p.payoutPk)}:${p.msat}`).join(',');
  return new Uint8Array(createHash('sha256').update([locks, payouts, toHex(build.nonce)].join('|')).digest());
};

test('the service, run whole: a transaction that does not rebuild is posted as TABLE_IS_NOT_F, the honest pair a lying seat lists is refused, and with no client the proof waits', { timeout: 170000 }, async () => {
  const peer = { events: [] };
  const stub = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/liquidations/events') { let b = ''; req.on('data', (d) => { b += d; }); return req.on('end', () => { peer.events.push(JSON.parse(b)); res.writeHead(201); res.end('kept'); }); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const peerUrl = `http://127.0.0.1:${stub.address().port}`;
  const w = await sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000, storedBeforeTheRule: true, peers: [peerUrl], finality: { everyMs: 100, rerunMs: 30000, doubleFileMs: 100 } });
  const dir = mkdtempSync(join(tmpdir(), 'arbiter-1040-'));
  try {
    w.sign('agrees', () => ({}));
    const base = `http://127.0.0.1:${w.holder.port}`;
    const contract = decodeRoundContract(new Uint8Array(w.holder.round.get(w.rid).contract));
    const view = w.slot.chainWith(contract);
    const byTxid = new Map();
    for (const b of view.blocks) for (const raw of b.transactions) byTxid.set(toHex(parseTransaction(raw).txid), raw);
    const census = deriveCensus(view, { contract, bond: bondSetFor('regtest'), resolve: (e) => { const raw = byTxid.get(toHex(e.txid)); return raw ? { transaction: raw } : null; } });
    assert.equal(census.ok, true, census.why);
    const bondOf = new Map(census.entries.map((e) => [toHex(e.pubkey), { bondTxid: e.txid, bondVout: e.vout }]));

    // A TABLE OF THIS ROUND: its one fee lock in, one payout out, F of its own row. No P is needed, so a stranger holds all of it
    const eid = w.runs.agrees.eid;
    const entry = decodeEntryContract(new Uint8Array(w.holder.round.entry(eid)));
    const table = { roundId: w.rid, rows: [{ entryId: entryId(entry), pubkey: entry.playerPubkey, amountMsat: netStakeMsat(entry), outcome: 'DELIVERED', score: contract.minScore }], claimPk: refundKeyOf(b32(0xcc)), nonce: settlementNonce(w.rid),
      claims: [{ entryId: entryId(entry), outpoint: entry.feeLockOutpoint, amountMsat: entry.feeMsat, kind: 'fee' }], payouts: [{ payoutPk: refundKeyOf(b32(0xdd)), msat: entry.feeMsat }] };
    const honestTxid = await toolTxid({ claims: [{ outpoint: entry.feeLockOutpoint, amountMsat: entry.feeMsat, preimage: entry.feePreimage }], payouts: table.payouts, nonce: table.nonce });
    const signers = [w.others[0], w.others[1], w.others[2], w.others[3], w.others[4]];
    const filed = (txid) => {
      const acks = signers.map((secret) => signSettlementAck({ roundId: w.rid, payoutTableId: settlementTableId(table), settlementTxid: txid }, schnorr.getPublicKey(secret), (m) => schnorr.sign(m, secret)));
      const accused = schnorr.getPublicKey(signers[toHex(txid) === toHex(honestTxid) ? 1 : 0]);
      const signedAck = acks[toHex(txid) === toHex(honestTxid) ? 1 : 0];
      const ack = { roundId: w.rid, payoutTableId: settlementTableId(table), settlementTxid: txid };
      const bond = bondOf.get(toHex(accused));
      const proof = { roundId: w.rid, playerPubkey: new Uint8Array(32), nodePubkey: accused, transcriptHash: settlementTableId(table), signedResultId: settlementAckId(ack), bondTxid: bond.bondTxid, bondVout: bond.bondVout };
      const record = joinTableSlashEvidence(encodeSlashProof(proof), { signedAck, acks, table: encodeSettlementTable(table), entries: [entry] });
      const { id } = w.holder.round.fraudProof(w.rid, null, record);
      assert.equal(w.holder.round.fileTableProof(w.rid, accused, id, record), 1);
      return { id: toHex(id), accused };
    };
    const guilty = filed(b32(0xfa));
    const clean = filed(honestTxid);

    // WHAT IT OWES, AT THE SEAT'S DOOR: the whole paying field is named, so it reads under any entry of the round
    w.holder.roster.censusAtHeight = () => ({ ok: true, tipHeight: contract.censusHeight + 5, entries: census.entries.map((e) => ({ pubkey: e.pubkey, bondSats: 2_000_000n })) });
    const owed = await (await fetch(`${base}/slash-owing?round=${toHex(w.rid)}&entry=${toHex(eid)}&height=${contract.censusHeight}`)).json();
    assert.deepEqual(owed.owing.filter((o) => o.node === toHex(guilty.accused)).map((o) => o.offence), ['TABLE_IS_NOT_F'], JSON.stringify(owed));

    const chain = await stubBitcoind(view, view.firstHeight + 20, Math.floor(Number(contract.committeeTimeMs) / 1000));
    writeFileSync(join(dir, 'cookie'), 'u:p');
    const bin = join(dir, 'arena-stake-lock');
    writeFileSync(bin, TOOL); chmodSync(bin, 0o755);
    const run = (state, extra = {}) => new Promise((done) => execFile(process.execPath, [new URL('../tools/arbiter.mjs', import.meta.url).pathname, '--once'],
      { timeout: 90000, env: { ...process.env, ARENA_ARBITER_NETWORK: 'regtest', ARENA_ARBITER_SEATS: base, ARENA_BITCOIND_URL: chain.url, ARENA_BITCOIND_COOKIE: join(dir, 'cookie'), ARENA_ARBITER_PORT: '0', ARENA_ARBITER_STATE: state,
        ARENA_ARBITER_LOOKBACK: '20', ARENA_ARBITER_PUBLISH: peerUrl, ARENA_APPS: new URL('../../nextblock/plugin/nextblock.js', import.meta.url).href, ...extra } },
      (err, out, errOut) => done({ err, out: String(out), errOut: String(errOut) })));
    try {
      // NO CLIENT OF THE FEDERATION: nothing was read, so nothing is decided
      const waiting = join(dir, 'waiting.json');
      const first = await run(waiting);
      assert.equal(first.err, null, `${first.out}\n${first.errOut}`);
      assert.match(first.out, /holds no client of federation/);
      assert.equal(existsSync(waiting) ? Object.keys(JSON.parse(readFileSync(waiting, 'utf8')).handled).length : 0, 0, 'a proof no client could read is not closed');
      assert.equal(chain.sent.length, 0);

      const state = join(dir, 'state.json');
      const ran = await run(state, { ARENA_STAKE_LOCK_BIN: bin, ARENA_ARBITER_CLIENT_DIR: dir });
      assert.equal(ran.err, null, `${ran.out}\n${ran.errOut}`);
      const handled = JSON.parse(readFileSync(state, 'utf8')).handled;
      assert.ok(handled[guilty.id], ran.out);
      assert.equal(handled[guilty.id].offence, 'TABLE_IS_NOT_F', ran.out);
      assert.equal(handled[guilty.id].posted, 'cd'.repeat(32), ran.out);
      assert.equal(handled[guilty.id].node, toHex(guilty.accused));
      assert.ok(handled[clean.id], ran.out);
      assert.equal(handled[clean.id].posted, undefined, 'a bond was taken on an honest pair');
      assert.match(handled[clean.id].why, /not false on anything shown/);

      assert.equal(chain.sent.length, 1, ran.out);
      const tx = parseTransaction(fromHex(chain.sent[0]));
      const bond = bondOf.get(toHex(guilty.accused));
      assert.equal(toHex(tx.inputs[0].previousTxid), toHex(bond.bondTxid));
      assert.equal(toHex(arbitrationCommitmentIn(tx.outputs).proofId), guilty.id, 'OP_RETURN = H(fraud_proof) ...');
      assert.deepEqual(peer.events.map((e) => [e.event.kind, e.event.proof, e.event.offence]), [['slash', guilty.id, 'TABLE_IS_NOT_F']], ran.out);
    } finally { await chain.close(); }
  } finally { await w.close(); await new Promise((r) => stub.close(r)); rmSync(dir, { recursive: true, force: true }); }
});
