// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT SIGNS ITS OWN FINAL ONCE, AND ASKS ITS PEERS LESS OFTEN WHILE NOTHING NEW ARRIVES (plan comment
// 298, Go 2026-10-05). server.js gatherFinal on the sevenSignerNodes fixture: a run made signable (five postings, its
// window passed), the finality tick every 250 ms, and the holder's peers a counting fake. Its own FINAL signature is
// written once however many ticks pass; the fake is asked at gaps of ~5 s, ~10 s, ~20 s while it adds nothing; once it
// answers a valid new signature the next gap is ~5 s again. And finalSignatureNow: null for a run that is neither
// signable nor FINAL; a fresh signature at the seat's clock otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sevenSignerNodes } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { resultFinality, finalSignatureNow } from '../src/finality.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { signFinalSig, splitSignedFinalSig, decodeFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

async function countingPeer() {
  const asks = [];                               // GET /final-sig for the one run under test
  const seen = [];                               // every request, for the record
  const only = { entry: null };
  let answer = null;
  const srv = createServer((req, res) => {
    seen.push({ at: Date.now(), url: req.url });
    if (req.url.startsWith('/final-sig') && req.url.includes(`entry=${only.entry}`)) asks.push(Date.now());
    if (req.url.startsWith('/final-sig') && req.url.includes(`entry=${only.entry}`) && answer) { const a = answer(); answer = null; res.writeHead(200); return res.end(Buffer.from(a)); }
    res.writeHead(404); res.end('no new signature');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, asks, seen, only, answerOnce: (bytes) => { answer = bytes; }, close: () => new Promise((r) => srv.close(r)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('own FINAL signed once; the peers asked at ~5, ~10, ~20 s while nothing new comes, and at ~5 s again after a new signature', { timeout: 110000 }, async () => {
  const peer = await countingPeer();
  const w = await sevenSignerNodes(1000, undefined, { endMs: testNow() + 4000, finality: { everyMs: 250 }, peers: [peer.url] });
  try {
    w.sign('agrees', () => ({}), { posted: false });
    w.post('agrees', 5);
    const eid = w.runs.agrees.eid;
    peer.only.entry = toHex(eid);
    // before its window: neither signable nor FINAL - no signature
    assert.equal(finalSignatureNow(w.holder.round, w.rid, eid, (d) => d), null, 'not signable yet: null');
    skipTo(Number(windowsOf(w.contract).finalAfterMs) + 100);
    const f = resultFinality(w.holder.round, w.rid, eid);
    assert.ok(f.signable, f.why);
    const runId = fromHex(typeof f.signable.runId === 'string' ? f.signable.runId : toHex(f.signable.runId));
    // signable: a fresh signature at the seat's clock
    const at = w.holder.round.now();
    const fresh = finalSignatureNow(w.holder.round, w.rid, eid, (d) => schnorr.sign(d, new Uint8Array(32).fill(7)), { now: at });
    const body = decodeFinalSig(splitSignedFinalSig(fresh).body);
    assert.deepEqual([toHex(body.runId), toHex(body.signerPubkey), body.signedAtMs], [toHex(runId), toHex(w.holder.round.pubkey), BigInt(at)], 'signed at the clock it was given');

    // the ticks run; the first three asks bring nothing
    await (async () => { for (let i = 0; i < 160 && peer.asks.length < 3; i++) await sleep(250); })();
    assert.ok(peer.asks.length >= 3, `three asks: ${peer.asks.length}`);
    // the next ask (the fourth, ~20 s on) answers a new signature (another seat's), so the gap after it resets
    // signed when it is served: a FINAL signature counts only within 5 s of the receiver's clock
    peer.answerOnce(() => signFinalSig({ roundId: w.rid, entryId: eid, runId, signerPubkey: schnorr.getPublicKey(w.others[0]), signedAtMs: BigInt(w.holder.round.now()) },
      (d) => schnorr.sign(d, w.others[0])));
    await (async () => { for (let i = 0; i < 200 && peer.asks.length < 5; i++) await sleep(250); })();
    const gaps = peer.asks.slice(1).map((t, i) => Math.round((t - peer.asks[i]) / 100) / 10);
    // asks: 0, ~5, ~15, ~35 (answered), ~40
    assert.ok(gaps.length >= 4, `gaps ${gaps.join(', ')}`);
    if (gaps[0] < 4.9) console.log('  requests seen:', JSON.stringify(peer.seen.slice(0, 8).map((x) => [x.at - peer.seen[0].at, x.url.slice(0, 60)])));
    assert.ok(gaps[0] >= 4.9 && gaps[0] <= 6.5, `first gap ~5 s: ${gaps[0]}`);
    assert.ok(gaps[1] >= 9.9 && gaps[1] <= 11.5, `second gap ~10 s (doubled): ${gaps[1]}`);
    assert.ok(gaps[2] >= 19.9 && gaps[2] <= 21.5, `third gap ~20 s (doubled again): ${gaps[2]}`);
    assert.ok(gaps[3] >= 4.9 && gaps[3] <= 6.5, `after the new signature, ~5 s again: ${gaps[3]}`);
    // its own FINAL: written once over every tick
    const own = w.holder.round.finalSigs(w.rid, eid, runId).filter((r) => toHex(r.signerPubkey) === toHex(w.holder.round.pubkey));
    assert.equal(own.length, 1, 'one own FINAL signature');
    const theirs = w.holder.round.finalSigs(w.rid, eid, runId).filter((r) => toHex(r.signerPubkey) === toHex(schnorr.getPublicKey(w.others[0])));
    assert.equal(theirs.length, 1, 'the peer\'s new signature taken');
    console.log(`  gaps between asks (s): ${gaps.join(', ')}; asks ${peer.asks.length}`);
  } finally { await w.close(); await peer.close(); }
});
