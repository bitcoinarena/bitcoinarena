// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r30 entry-1 (find-only, kanban #1489): POST /refused-lock decodes EVERY handout the round holds (server.js round.handoutsOf loop)
// before it asks anything that costs the asker - no signature, no lock, only the round's public claim key. Since #2136/#2481 a round keeps
// up to HANDOUTS_LOOSE_CEILING (32 x 256 = 8192) young loose handouts a stranger posts for free. Safe behaviour: a stranger's POST
// /refused-lock with a made-up lock costs the seat about what it costs with one handout held - it never walks thousands of rows per ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

async function deal(w) {
  const key = rand(32); const e = rand(32);
  const d = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed: w.needed, curve: feldmanGroup });
  assert.equal(d.ok, true, d.why);
  return d.handout;
}

test('wf1489-r30-entry-1: a stranger\'s POST /refused-lock walks every handout of a flooded round', { timeout: 300000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const base = `http://127.0.0.1:${w.a.port}`;
    // 1. THE DOOR TAKES FAR MORE THAN 256 FREE LOOSE HANDOUTS WITHIN THE GRACE (#2481's ceiling): 400 strangers' posts, every one 201
    let took = 0;
    for (let i = 0; i < 400; i++) {
      const h = await deal(w);
      if ((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(h) })).status === 201) took++;
    }
    const fake = () => ({ outpoint: `${toHex(rand(32))}:0`, fields: lockFieldsToJson({ paymentImage: { kind: 'point', bytes: feldmanGroup.pointFromScalar(secretScalar()) },
      amountMsat: 1000n, claimPk: w.claimPk, refundPk: refundKeyOf(rand(32)), expiration: w.port.height + 200 }) });
    refusing.why = 'test: this signer node refuses the round';
    const timeAsk = async (n) => {
      const ms = [];
      for (let i = 0; i < n; i++) {
        const t = process.hrtime.bigint();
        const r = await fetch(`${base}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST', body: JSON.stringify(fake()) });
        await r.text();
        ms.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      ms.sort((a, b) => a - b); return ms[Math.floor(ms.length / 2)];
    };
    const small = await timeAsk(5);
    // 2. THE REST OF THE CEILING, AS THE FLOOD LEAVES IT (rows the door's own rememberHandout writes; copies of a dealt one's bytes)
    const one = encodeHandout(await deal(w));
    for (let i = took; i < 8192; i++) w.a.round.rememberHandout({ id: Buffer.from(rand(32)), roundId: Buffer.from(w.rid), bytes: Buffer.from(one) });
    const big = await timeAsk(5);
    console.log('  FACTS wf1489-r30-entry-1:', JSON.stringify({ took, held: w.a.round.handoutCount(w.rid), smallMs: small.toFixed(1), bigMs: big.toFixed(1), seats: w.c.nodes.length }));
    assert.equal(took, 400, 'the door did not take the free handouts - the attack needs them');
    assert.ok(big < Math.max(8, small * 4), `one unauthenticated POST /refused-lock took ${big.toFixed(1)} ms with 8192 handouts held (${small.toFixed(1)} ms with ${took}): the door walks every handout of the round per ask`);
  } finally { await w.close(); }
});
