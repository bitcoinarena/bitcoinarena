// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 sm5 market 1 (state machine audit, kanban #1489): A DRAWN ATTESTATION IS HANDED TO THE SETTLEMENT SEATS ONCE, AND NEVER AGAIN.
//
// The drawn attestor's per-round machine (drawn-attestor.js pass): no word -> word -> combined -> `hold(bytes)` true -> `held` (the round is
// never looked at again). server.js's `hold` (2570-2577) holds the attestation at this seat, POSTs it once to every settlement and drawn
// seat (8 s timeout, every answer dropped by `.catch(() => null)`), and answers true whatever those seats answered. Nothing else ever brings
// a drawn attestation to a seat: no seat pulls outcomes from another (GET /outcome is read by pages only), and drawn games have no attestor
// daemon (arena-attestor.mjs, which re-posts every 5 s to each seat until 200/201). So a settlement seat that was restarting, overloaded past
// the 8 s, or answered 404/409 during the ~20 s in which the drawn seats combine misses every copy - and stays OPEN until the deadline,
// where marketTransition makes it VOID for good: that seat refunds every stake by its return door while the others are FINAL and settle.
//
// The seven drawn seats below run the real DrawnAttestor; each one's `hold` is a copy of server.js's closure as fixed by kanban #1989 (held
// here, posted to every settlement seat that has not answered 200/201, { held, delivered }). Settlement seat S is down for the first pass only; it is up for every later pass, inside the
// 30 min the round is still due. The invariant: a seat that is up while the round is due ends up holding its attestation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DrawnAttestor } from '../src/drawn-attestor.js';
import { decodeAttestation, attestationStands } from '../../arena-protocol/src/attested.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const ROUND = new Uint8Array(32).fill(0x51);
const WINDOW = { startMs: 900000n, endMs: 1800000n };
const secretOf = (i) => { const s = new Uint8Array(32); s[31] = i + 1; return s; };
const KEYS = Array.from({ length: 7 }, (_, i) => toHex(schnorr.getPublicKey(secretOf(i))));
const MANIFEST = {
  gameName: 'up-down-drawn', gameDevPubkey: new Uint8Array(32).fill(9), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
  cores: [], runTicksMax: 0, roundPeriodMs: 900000n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
  clients: [], gameDonationSetId: new Uint8Array(32), outcomes: ['Up', 'Down'], attestors: [], attestThreshold: 0,
  attestDraw: { count: 7, threshold: 5 }, requiredProtocolVersion: 2,
};
const verify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };

test('wf1489 sm5 market 1: a settlement seat that missed the one push of a drawn attestation gets it on a later pass while the round is due', async () => {
  let clock = 0;
  // THE SETTLEMENT SEATS' INTAKE (POST /outcome -> holdOutcome): what each holds; seat S is down while `sDown`
  const SETTLEMENT = ['http://settle-0', 'http://settle-1', 'http://settle-s'];
  const intake = new Map(SETTLEMENT.map((b) => [b, null]));
  let sDown = true;
  const posts = [];
  const settlementFetch = async (url, opts) => {
    const base = new URL(url).origin;
    posts.push({ base, atMs: clock });
    if (base === 'http://settle-s' && sDown) throw new Error('connect ECONNREFUSED (restarting)');
    const st = attestationStands(decodeAttestation(opts.body), { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS });
    if (st.ok) intake.set(base, st);
    return { status: st.ok ? 201 : 409, ok: st.ok };
  };
  const list = KEYS.map((key, i) => new DrawnAttestor({
    selfKey: key, sign: (d) => schnorr.sign(d, secretOf(i)), verify, attestorsFor: () => KEYS,
    peersFor: () => KEYS.map((_, j) => `http://seat-${j}`).filter((_, j) => j !== i),
    // due as server.js says it: window ended, and within the last 30 min
    due: () => (Number(WINDOW.endMs) <= clock && Number(WINDOW.endMs) > clock - 1800000 ? [{ roundId: ROUND, window: WINDOW }] : []),
    readPrice: () => (clock < 900000 ? 8000000 : { cents: 8001234, atMs: clock }), now: () => clock,
    // server.js's hold closure (kanban #1989): held here once (holdOutcome), then a POST to each settlement seat that has not answered
    // 200/201 yet; { held: true, delivered } - DrawnAttestor hands it again each pass until every seat took it
    hold: (() => { const took = new Map(); return async (bytes) => {
      let t = took.get(toHex(ROUND));
      if (!t) {
        const here = attestationStands(decodeAttestation(bytes), { manifest: MANIFEST, roundIdBytes: ROUND, verify, drawn: KEYS });
        if (!here.ok) return false;
        took.set(toHex(ROUND), t = new Set());
      }
      const to = SETTLEMENT.filter((b) => !t.has(b));
      await Promise.all(to.map(async (base) => {
        try { const res = await settlementFetch(`${base}/outcome?round=${toHex(ROUND)}`, { method: 'POST', body: bytes }); if (res.status === 200 || res.status === 201) t.add(base); } catch { /* next pass */ }
      }));
      return { held: true, delivered: to.every((b) => t.has(b)) };
    }; })(),
    fetcher: async (url) => {
      const j = Number(new URL(url).host.split('-')[1]);
      const w = list[j].served(ROUND);
      return w ? { status: 200, json: async () => w } : { status: 404, json: async () => null };
    },
  }));
  // readings from a minute before the window up to its end
  for (let t = 780000; t <= 1810000; t += 10000) { clock = t; for (const s of list) await s.read(); }
  // PASS 1 (end + 10 s): every drawn seat signs; the ones that see 5 words combine and push - S is restarting
  clock = 1810000;
  for (const s of list) await s.pass();
  for (const s of list) await s.pass();
  const pushedWhileDown = posts.filter((p) => p.base === 'http://settle-s').length;
  // S IS BACK 30 s later; the drawn seats keep their 10 s passes for the rest of the 30 min the round is due
  sDown = false;
  const before = posts.length;
  for (let t = 1840000; t < 1800000 + 1800000; t += 10000) { clock = t; for (const s of list) { await s.read(); await s.pass(); } }
  const postsAfterBack = posts.length - before;
  // and once every seat took it, nobody posts again (each drawn seat's one re-post to S, then quiet)
  const lastPostAt = Math.max(...posts.map((p) => p.atMs));
  assert.ok(lastPostAt <= 1840000, `a drawn seat still posted at ${lastPostAt}, after every settlement seat had taken the attestation`);
  const facts = { pushesToSWhileDown: pushedWhileDown, postsOfAnySeatAfterSIsBack: postsAfterBack,
    heldAt: [...intake].map(([b, st]) => `${b.replace('http://', '')}: ${st ? 'held' : 'NOTHING'}`) };
  console.log('  FACTS (wf1489 sm5 market 1):', JSON.stringify(facts));
  assert.ok(pushedWhileDown > 0, 'the drawn seats never pushed while S was down: the scenario did not run');
  assert.ok(intake.get('http://settle-0') && intake.get('http://settle-1'), 'the seats that were up did not take it');
  // THE INVARIANT: S was up for 29 of the 30 minutes the round was due, and holds its attestation
  assert.ok(intake.get('http://settle-s'), `settlement seat S never holds the round's attestation: ${postsAfterBack} posts reached any seat after it came back - it stays OPEN and turns VOID at the deadline while the others are FINAL`);
});
