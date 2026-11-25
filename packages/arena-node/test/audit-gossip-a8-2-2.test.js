// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit gossip r2-2: A STRANGER REPLACES AN ANNOUNCED GRID'S PUBLICATION. POST /expected is open to anyone; the series line must be signed
// by its creator, but the transaction is only parsed and looked at for the publication output - no input, no signature, no mempool or chain
// read. Since #1126 a later announcement of the same grid replaces the publication the seat names. The creator's signed line is public (every
// seat serves it), so a stranger re-posts it with made-up transaction bytes that carry the publication output, and every seat's GET /expected
// and GET /pending name a txid that never reaches the chain: the honest grid reads "publication unconfirmed" until its last close.
// Safe behaviour: a publication that is not in this node's mempool or chain does not replace one the seat names.
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


test('a stranger\'s made-up transaction for a public grid line does not replace the publication the seat names', async () => {
  const s = await joinedWithLock({});
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const post = async (body) => { const r = await fetch(base + '/expected', { method: 'POST', body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const { line, sid } = aGrid(new Uint8Array(32).fill(9));
    // the publisher's real publication, announced by the publisher
    const real = txWith([seriesPublicationOutput(sid).script, Uint8Array.from([0x51])]);
    const [st1, got1] = await post({ line, tx: real });
    assert.equal(st1, 200, JSON.stringify(got1));
    const realTxid = got1.publication;
    // a stranger: the same public line, a transaction he made up (another input, no signature, never broadcast)
    const fake = (() => { const b = Buffer.from(txWith([seriesPublicationOutput(sid).script]), 'hex'); b.fill(0x42, 6, 38); return b.toString('hex'); })();
    const [st2, got2] = await post({ line, tx: fake });
    console.log(`stranger's post: ${st2} ${JSON.stringify(got2).slice(0, 200)}`);
    const ex = (await (await fetch(base + '/expected')).json()).expected;
    assert.equal(ex.length, 1);
    assert.equal(ex[0].publication.txid, realTxid, `the seat now names the stranger's made-up publication ${ex[0].publication.txid.slice(0, 16)} for the grid, not ${realTxid.slice(0, 16)}`);
  } finally { await s.d.close(); }
});

// THE FIX'S OTHER SIDE (kanban #3740): a seat that reads its chain replaces the publication only with one in its mempool or blocks, and
// only when the kept one is in neither or the new one spends a coin the kept one spends (a fee raise, #1126); a made-up first one gives way.
const txidOf = (hex) => Buffer.from(parseTransaction(Buffer.from(hex, 'hex')).txid).reverse().toString('hex');
const otherInput = (hex) => { const b = Buffer.from(hex, 'hex'); b.fill(0x42, 6, 38); return b.toString('hex'); };
test('#3740 a seat reading its chain: a fee raise in its mempool replaces the publication, a tx in no mempool or a real unrelated one does not, a made-up first one gives way', async () => {
  const mempool = new Set();
  const s = await joinedWithLock({ chainInMempool: async (txid) => mempool.has(txid) });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const post = async (body) => { const r = await fetch(base + '/expected', { method: 'POST', body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const named = async () => (await (await fetch(base + '/expected')).json()).expected.map((e) => e.publication.txid);
    const { line, sid } = aGrid(new Uint8Array(32).fill(9));
    const pub = seriesPublicationOutput(sid).script;
    // the publisher's announcement, taken before its tx reaches this mempool (#1378)
    const real = txWith([pub, Uint8Array.from([0x51])]);
    assert.equal((await post({ line, tx: real }))[0], 200);
    // a stranger's made-up one, in no mempool: refused, the real one still named
    const [fs, fb] = await post({ line, tx: otherInput(txWith([pub])) });
    console.log(`#3740 made-up replacement: ${fs} ${fb.why}`);
    assert.equal(fs, 409); assert.deepEqual(await named(), [txidOf(real)]);
    // the real one reaches the mempool; another tx there that carries the output but spends none of its coins does not replace it
    mempool.add(txidOf(real));
    const unrelated = otherInput(txWith([pub, Uint8Array.from([0x52])])); mempool.add(txidOf(unrelated));
    assert.equal((await post({ line, tx: unrelated }))[0], 409); assert.deepEqual(await named(), [txidOf(real)]);
    // the fee raise (same coin, another txid), not yet in this mempool: refused until it is, then it replaces the real one (#1126)
    const raised = txWith([pub]);
    assert.equal((await post({ line, tx: raised }))[0], 409);
    mempool.delete(txidOf(real)); mempool.add(txidOf(raised));
    assert.equal((await post({ line, tx: raised }))[0], 200); assert.deepEqual(await named(), [txidOf(raised)]);
    // another grid whose first announcement is a stranger's made-up one: the publisher's real one, in the mempool, takes its place
    const g2 = aGrid(new Uint8Array(32).fill(9), { seriesCount: 28 });
    const p2 = seriesPublicationOutput(g2.sid).script;
    assert.equal((await post({ line: g2.line, tx: otherInput(txWith([p2])) }))[0], 200);
    const real2 = txWith([p2, Uint8Array.from([0x53])]); mempool.add(txidOf(real2));
    assert.equal((await post({ line: g2.line, tx: real2 }))[0], 200);
    assert.ok((await named()).includes(txidOf(real2)));
  } finally { await s.d.close(); }
});
