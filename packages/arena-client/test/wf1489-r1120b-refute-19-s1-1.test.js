// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Refute of #3015 (audit h2h r1-1), variant 1: THE THRESHOLD OF HOLDERS IS COUNTED PER ADDRESS, NOT PER SEAT.
//
// revealWhenCertified stops re-posting once `took` >= lockSetThreshold(seats.length), both counted over the raw node list. The node list
// is the join link's (join.js joinQuery: no dedup), and #2709 already ruled that one seat named under several spellings is ONE vote.
// The attacker seat s0 (first to hold the certificate, as in the audit) names itself 8 times ('http://s0', 'http://s0/', 'http://S0',
// 'http://s0.', 'http://s0/a', ...) beside the 6 honest seats: 14 addresses, threshold 8, and s0's 8 spellings all answer 201 at once.
// The loop never runs; the six honest seats answered 409 "not certified yet - ask again shortly" and are never asked again. Only s0 holds the
// move - the exact forfeit #3015 was meant to close.
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
const hostOf = (u) => new URL(u).hostname.toLowerCase().replace(/\.+$/, '');

test('wf1489-r1120b-refute-19-1: one seat named under 8 spellings is not 8 holders of the honest reveal', async () => {
  const evil = ['http://s0', 'http://s0/', 'http://S0', 'http://s0.', 'http://s0/a', 'http://s0/b', 'http://s0/c', 'http://s0/d'];
  const nodes = [...evil, ...Array.from({ length: 6 }, (_, i) => `http://s${i + 1}`)];
  let t = CLOSE + 200;
  const now = () => t;
  const honestCertified = () => t >= CLOSE + 1600;
  const held = new Set(); const refused = [];
  const fetcher = async (u, o = {}) => {
    const host = hostOf(u);
    if ((o.method || 'GET') === 'POST') {
      if (host === 's0' || honestCertified()) { held.add(host); return { ok: true, status: 201, body: null, text: async () => '' }; }
      refused.push(host);
      return { ok: false, status: 409, body: null, text: async () => 'that round\'s lock set is not certified yet: no reveal is taken before it (kanban #2561) - ask again shortly' };
    }
    const j = host === 's0' || honestCertified()
      ? { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort() }
      : { required: true, certificate: null, void: false };
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now, sleep: async () => { t += 150; } });
  const pageOk = Array.isArray(got.seats) && got.seats.some((x) => x.status === 201 || x.status === 200);
  assert.ok(refused.length >= 6, `precondition: the honest seats refused the first post as not certified yet (${refused.length})`);
  assert.ok(!pageOk || held.size >= lockSetThreshold(7),
    `the page counts its reveal done while only ${held.size} seat(s) hold the move (${[...held].join(', ')}): s0 named 8 times filled the threshold of ${lockSetThreshold(nodes.length)} on its own and the honest seats were never asked again`);
});
