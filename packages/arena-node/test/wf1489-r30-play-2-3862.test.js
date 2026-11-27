// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
//
// wf1489 r30 play-2 (gap in #2151 / #1274): #2151 made a peer's GET /receipts answer file a receipt for a mark this seat has not got
// only when its signer is on the round's committee ("a stranger's key is no divergence signal") - but the /play door's
// TYPE_CHECKPOINT_RECEIPT frame still goes to Round#takeReceipt, which files a receipt for an unknown mark under ANY key that signs
// it. FOREIGN_RECEIPTS_KEPT (4096) evicts the oldest, so a stranger with no key of the round sends 4096 self-signed receipts on one
// socket and every real committee receipt this seat held of a mark it missed is gone - the receipts receiptsKnownOf counts before
// it records an ENTRY_VOID (#2838). Safe: a stranger's receipts do not push a committee member's receipt out.
import { test } from 'node:test';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { assert, joinAndBuild, say, signerNodes, toHex, rand, wait } from './first-mark-fixture.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';

const flood = (port, frames) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/play`);
  let got = 0; const answers = new Map();
  ws.on('open', () => { for (const f of frames) ws.send(f); });
  ws.on('message', (d) => { const s = d.toString().slice(0, 60); answers.set(s, (answers.get(s) || 0) + 1); if (++got === frames.length) { ws.close(); resolve(answers); } });
  ws.on('error', reject);
});

test('a stranger\'s self-signed receipts on /play do not evict a committee member\'s receipt of a mark this seat missed', async () => {
  const w = await signerNodes();
  try {
    const run = await joinAndBuild(w);
    // the first mark (and its batch) reach B only, while A is down: A misses it (B's forward goes unanswered)
    await w.downA();
    await say(w.b.port, run.messages[0]);
    const bReceipt = await say(w.b.port, run.messages[1]);
    assert.ok(bReceipt instanceof Uint8Array, `B did not receipt the first mark: ${bReceipt}`);
    await wait(3500);
    await w.upA();
    assert.ok(!w.a.round.holdsMark(run.firstId), 'A holds the first mark after all');
    // B's receipt reaches A (gossip on /play): A files it as a foreign receipt - the divergence signal / #2838 evidence
    const filed = await say(w.a.port, bReceipt);
    const holds = () => w.a.round.foreignReceipts().some((r) => toHex(r.nodePubkey) === toHex(w.b.round.pubkey) && toHex(r.checkpointId) === toHex(run.firstId));
    assert.ok(holds(), `A did not file B's receipt as foreign (${String(filed).slice(0, 80)})`);

    // the stranger: 4100 receipts over random 32-byte ids, each under a fresh key nobody bonded
    const frames = [];
    for (let i = 0; i < 4100; i++) {
      const sk = schnorr.utils.randomSecretKey();
      const r = { checkpointId: rand(32), receivedAtMs: 1n, nodePubkey: schnorr.getPublicKey(sk) };
      frames.push(joinSignedReceipt(encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), sk)));
    }
    await wait(5);                       // B's row is strictly older than the flood's
    const answers = await flood(w.a.port, frames);
    const rows = w.a.round.foreignReceipts().length;
    const strangers = w.a.round.foreignReceipts().filter((r) => !w.c.nodes.some((n) => toHex(n) === toHex(r.nodePubkey))).length;
    console.log('  FACTS:', JSON.stringify({ rows, strangers, kept: holds(), answers: [...answers.entries()] }));
    assert.ok(holds(), `after ${frames.length} self-signed receipts from keys of no committee, A no longer holds B's receipt of the first mark it missed `
      + `(foreign_receipts: ${rows} rows, ${strangers} from strangers)`);
  } finally {
    await w.close();
  }
});
