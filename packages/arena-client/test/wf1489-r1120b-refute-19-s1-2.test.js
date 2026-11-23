// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Refute of #3015 (audit h2h r1-1), variant 2: A SEAT THAT SAYS "TRY AGAIN" WITH 503 IS NEVER ASKED AGAIN.
//
// askAgain re-posts only to status 0 and 409 "not certified yet / ask again". A seat whose body budget is full answers 503 "this node holds
// as many unfinished bodies as it takes; try again" (body-budget.js busy, server.js door catch) - a stranger with two addresses fills main
// budget and reserve (perAddress = total/2, reserve per address half). As in the audit, s0 holds the certificate first and the honest seats
// answer 409 on the first post; on the re-post, right after they certified, they are briefly busy (503 "try again"). The loop sees no
// seat to ask again and returns: only s0 holds the move, the page reads ok, the honest player FORFEITS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { revealWhenCertified, lockSetThreshold } from '../src/head-to-head.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockSetOf, lockSetId, lockSetSignatureId, encodeLockSetCertificate } from '../../arena-protocol/src/lock-set.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x51 + i));
const committee = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const CLOSE = 1_800_000_000_000;
const ROUND = b32(0x61), MINE = b32(0x62), THEIRS = b32(0x63);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const cert = (() => {
  const set = lockSetOf({ roundId: ROUND, entries: [MINE, THEIRS] });
  const sigs = secrets.slice(0, 5).map((sec) => ({ key: schnorr.getPublicKey(sec), atMs: BigInt(CLOSE + 900), sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: BigInt(CLOSE + 900) }), sec) }))
    .sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  return toHex(encodeLockSetCertificate({ set, sigs }));
})();
const nodes = Array.from({ length: 7 }, (_, i) => `http://s${i}`);

test('wf1489-r1120b-refute-19-2: an honest seat briefly busy (503 try again) is asked again before the reveal counts as done', async () => {
  let t = CLOSE + 200;
  const now = () => t;
  const honestCertified = () => t >= CLOSE + 300;
  const busyUntil = CLOSE + 1500;   // the stranger's jam lasts ~1.2 s
  const held = new Set(); const refused = []; const busy = [];
  const fetcher = async (u, o = {}) => {
    const node = u.slice(0, u.indexOf('/', 7));
    if ((o.method || 'GET') === 'POST') {
      if (node === 'http://s0') { held.add(node); return { ok: true, status: 201, body: null, text: async () => '' }; }
      if (!honestCertified()) { refused.push(node); return { ok: false, status: 409, body: null, text: async () => 'that round\'s lock set is not certified yet: no reveal is taken before it (kanban #2561) - ask again shortly' }; }
      if (t < busyUntil) { busy.push(node); return { ok: false, status: 503, body: null, text: async () => 'this node holds as many unfinished bodies as it takes; try again' }; }
      held.add(node); return { ok: true, status: 201, body: null, text: async () => '' };
    }
    const j = node === 'http://s0' || honestCertified()
      ? { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort() }
      : { required: true, certificate: null, void: false };
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now, sleep: async () => { t += 150; } });
  const pageOk = Array.isArray(got.seats) && got.seats.some((x) => x.status === 201 || x.status === 200);
  assert.ok(refused.length >= 6 && busy.length >= 6, `precondition: honest seats said not certified, then busy (${refused.length}, ${busy.length})`);
  assert.ok(!pageOk || held.size >= lockSetThreshold(7),
    `the page counts its reveal done while only ${held.size} seat(s) hold the move (${[...held].join(', ')}): the honest seats answered 503 "try again" and were never asked again`);
});
