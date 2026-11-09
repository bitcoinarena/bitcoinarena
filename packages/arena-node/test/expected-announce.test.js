// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GRID ANNOUNCED TO ANY SEAT (kanban #560, 2026-10-20: "it will work on future testnet and mainnet with nodes not operated by us"):
// POST /expected takes the grid's signed series line and its publication transaction; the seat keeps it, and GET /expected and GET /pending
// name it, only when the line is a grid its creator signed and the transaction carries that series' publication output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { joinedWithLock } from './lock-fixture.js';
import { HOSTED } from './plugins/hosted.js';
import { parseSeriesLine, seriesLineOf } from '../src/series-line.js';
import { seriesId, seriesPublicationOutput } from '../../arena-protocol/src/series.js';
import { seriesCreatorMessage } from '../../arena-protocol/src/creator.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { announceGrid } from '../src/grid-build.js';

// the line of Up/Down grid 8f8cb429 (testnet4, 2026-10-20), moved a day past now and signed again by a test creator
const LIVE = '0100031060078b1d4458b32c47aa68279f2260ad8e731ae365ce3f22260dbdc92d7a15fa9a348f9ac4441a05e8ee134d4f3615c758e907626539ef453107e306aaef7200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a15a416e80000001a15a416e8000000000000927c001337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e0000020f0000001400a5dc55c1ffef31fae9b7450fb687334675089bb33aea54c667e233c9b3c23779000265c100000006a12c0737cfc2bceb017bd214211880bc3c952e5604cc9753ccd82f9a66985c5f000001a15a0db25c0012626974636f696e2d626c6f636b2d6861736800070016687474703a2f2f3132372e302e302e313a33313232310016687474703a2f2f3132372e302e302e313a33313233310016687474703a2f2f3132372e302e302e313a33313234310016687474703a2f2f3132372e302e302e313a33313235310016687474703a2f2f3132372e302e302e313a33313236310016687474703a2f2f3132372e302e302e313a33313237310016687474703a2f2f3132372e302e302e313a3331323831070700000000000186a0000000000000c3501338000003e800000028000000140000001e000000960000000003040000c2583bce50d8c799bb9cb271ebc27e1224b5e1a579a2a138136b9faff7651ba87855492db3b8219967393eb93547d8a79a0deb2938f18059d7915231c146f758ab01debbf0fd2b0dea38523c3158251779b6bd8de0395f2e380cd2f03f8042cd7d53fc29005a2ff8fa0281a276f2604e6f086e80038c31936e693f891d6e21a45b010001000000000000c350000000000000c350c14326d2016d234f867dc5ddd7e52012c20978467b2b9a378b04df660899c22e89 grid period=900000 count=29 creator=575418c15f250d023ec459309e45f054d15996c478300d80001ca868b6ab5765894a4069a15432524e85ac944fbaed1c58dc9d8b0c9bb5e89512f6c171e50376';
function aGrid(secret, over = {}) {
  const t = parseSeriesLine(LIVE);
  const shift = BigInt(Date.now() + 86400000) - t.startTimeMs;
  // a game the test seat hosts (kanban #1378: a seat keeps only grids of games it hosts)
  const u = { ...t, gameId: [...HOSTED.values()][0].gameId, startTimeMs: t.startTimeMs + shift, entryCloseMs: t.entryCloseMs + shift, committeeTimeMs: t.committeeTimeMs + shift, creatorPubkey: schnorr.getPublicKey(secret), ...over };
  delete u.creatorSignature;
  const sid = seriesId(u);
  u.creatorSignature = schnorr.sign(seriesCreatorMessage(sid), secret);
  return { line: seriesLineOf(u, encodeRoundContract), sid, t: u };
}
// a one-input transaction whose outputs are `scripts` (each 0 sat)
function txWith(scripts) {
  const le = (n, k) => { const b = Buffer.alloc(k); b.writeUIntLE(n, 0, k); return b; };
  const outs = scripts.map((s) => Buffer.concat([Buffer.alloc(8), Buffer.from([s.length]), Buffer.from(s)]));
  return Buffer.concat([le(2, 4), Buffer.from([1]), Buffer.alloc(32, 7), le(0, 4), Buffer.from([0]), Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from([outs.length]), ...outs, le(0, 4)]).toString('hex');
}

test('POST /expected: a signed grid and its publication kept and named; a forged signature or a transaction without its output refused', async () => {
  const s = await joinedWithLock({});
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const post = async (body) => { const r = await fetch(base + '/expected', { method: 'POST', body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const { line, sid, t } = aGrid(new Uint8Array(32).fill(9));
    const tx = txWith([seriesPublicationOutput(sid).script, Uint8Array.from([0x51])]);
    const [st, got] = await post({ line, tx });
    assert.equal(st, 200, JSON.stringify(got));
    assert.deepEqual([got.series, got.slots, got.firstCloseMs], [toHex(sid), t.seriesCount, String(t.entryCloseMs)]);
    const ex = await (await fetch(base + '/expected')).json();
    assert.equal(ex.expected.length, 1);
    assert.deepEqual([ex.expected[0].firstCloseMs, ex.expected[0].slots, ex.expected[0].publication.txid], [String(t.entryCloseMs), t.seriesCount, got.publication]);
    // a line whose signature is another key's, and a transaction that publishes nothing for it
    const forged = parseSeriesLine(line); forged.creatorSignature = schnorr.sign(seriesCreatorMessage(sid), new Uint8Array(32).fill(8));
    const [fs, fb] = await post({ line: seriesLineOf(forged, encodeRoundContract), tx });
    assert.equal(fs, 403); assert.match(fb.why, /creator/);
    const [ns, nb] = await post({ line, tx: txWith([Uint8Array.from([0x51])]) });
    assert.equal(ns, 422); assert.match(nb.why, /does not publish series/);
    const [bs] = await post({ line: 'no line', tx });
    assert.equal(bs, 400);
  } finally { await s.d.close(); }
});

test('kanban #1126: a fee raise announced again replaces the publication the seat names for that grid - one entry, the new txid', async () => {
  const s = await joinedWithLock({});
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const { line, sid } = aGrid(new Uint8Array(32).fill(9));
    const first = txWith([seriesPublicationOutput(sid).script, Uint8Array.from([0x51])]);
    // the fee raise: the same publication output, less change - another txid
    const raised = txWith([seriesPublicationOutput(sid).script]);
    const a = await announceGrid({ lines: [line], tx: first, targets: [base] });
    assert.deepEqual(a, { took: 1, of: 1 });
    const was = (await (await fetch(base + '/expected')).json()).expected[0].publication.txid;
    const b = await announceGrid({ lines: [line], tx: raised, targets: [base] });
    assert.deepEqual(b, { took: 1, of: 1 });
    const ex = (await (await fetch(base + '/expected')).json()).expected;
    assert.equal(ex.length, 1, 'one entry per grid, not two');
    assert.notEqual(ex[0].publication.txid, was);
    assert.equal(ex[0].publication.txid, Buffer.from(parseTransaction(Buffer.from(raised, 'hex')).txid).reverse().toString('hex'));
    const pend = await (await fetch(base + '/pending')).json();
    const pubs = (pend.txs || []).filter((x) => x.kind === 'grid publication').map((x) => x.txid);
    if (pend.ok !== false) assert.ok(!pubs.includes(was), '/pending no longer names the replaced tx');
  } finally { await s.d.close(); }
});

// kanban #1378 (audit 2 #1204 INSTALLER-DOORS-13): an open door keeps only grids of games this seat hosts, closing within 96 h
test('#1378 POST /expected: a grid of a game this seat does not host, or one closing days ahead, is not kept', async () => {
  const s = await joinedWithLock({});
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const post = async (body) => { const r = await fetch(base + '/expected', { method: 'POST', body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const foreign = aGrid(new Uint8Array(32).fill(9), { gameId: new Uint8Array(32).fill(0xee) });
    const [fs, fb] = await post({ line: foreign.line, tx: txWith([seriesPublicationOutput(foreign.sid).script]) });
    const far = (() => { const g = aGrid(new Uint8Array(32).fill(9)); const d = 30n * 86400000n; return aGrid(new Uint8Array(32).fill(9), { startTimeMs: g.t.startTimeMs + d, entryCloseMs: g.t.entryCloseMs + d, committeeTimeMs: g.t.committeeTimeMs + d }); })();
    const [ds, db] = await post({ line: far.line, tx: txWith([seriesPublicationOutput(far.sid).script]) });
    console.log(`#1378 unhosted game: ${fs} ${fb.why}; 30 days ahead: ${ds} ${db.why}`);
    assert.equal(fs, 404); assert.match(fb.why, /does not host/);
    assert.equal(ds, 409); assert.match(db.why, /closes more than 96 h/);
    assert.equal((await (await fetch(base + '/expected')).json()).expected.length, 0, 'nothing kept');
  } finally { await s.d.close(); }
});
