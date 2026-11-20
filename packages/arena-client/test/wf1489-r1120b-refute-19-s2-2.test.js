// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Refute of #3015 / #3154 (audit h2h r1-1), skeptic 2 variant 2: A STRANGER, NOT A SEAT, FILLS THE THRESHOLD WITH HOSTNAMES OF ONE BOX.
//
// The node list is the link's (?node=, join.js lobbyQuery; #2709). 7935b601b counts a holder per hostname, but nothing ties a hostname to a
// committee seat: a stranger's link names the 7 honest seats (s1..s7) plus one box of its own under 5 hostnames (a.evil .. e.evil - five DNS
// names, or an IP and its names). The box holds no key; it serves a copy of a certificate the honest seats already published (one of them,
// one signature ahead) and answers every POST /reveal 201. need = lockSetThreshold(7) = 5 hosts, filled by the box on the first post; the
// honest seats answered 409 "not certified yet" and are never asked again; s1 (ahead) is the one honest holder - the honest player FORFEITS.
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

test('wf1489-r1120b-refute-19-s2-2: five hostnames of a stranger\'s box are not five seats holding the reveal', async () => {
  const fake = ['a', 'b', 'c', 'd', 'e'].map((x) => `https://${x}.evil.example`);
  const honest = Array.from({ length: 7 }, (_, i) => `https://s${i + 1}.example`);
  const nodes = [...honest, ...fake];
  let t = CLOSE + 200;
  const now = () => t;
  const honestCertified = () => t >= CLOSE + 1600;
  const held = new Set(); const refused = [];
  const fetcher = async (u, o = {}) => {
    const host = new URL(u).hostname;
    const isFake = host.endsWith('.evil.example'), ahead = host === 's1.example';
    if ((o.method || 'GET') === 'POST') {
      if (isFake) return { ok: true, status: 201, body: null, text: async () => '' };
      if (ahead || honestCertified()) { held.add(host); return { ok: true, status: 201, body: null, text: async () => '' }; }
      refused.push(host);
      return { ok: false, status: 409, body: null, text: async () => 'that round\'s lock set is not certified yet: no reveal is taken before it (kanban #2561) - ask again shortly' };
    }
    const j = isFake || ahead || honestCertified()
      ? { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort() }
      : { required: true, certificate: null, void: false };
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now, sleep: async () => { t += 150; } });
  const pageOk = Array.isArray(got.seats) && got.seats.some((x) => x.status === 201 || x.status === 200);
  assert.ok(refused.length >= 6, `precondition: the honest seats refused the first post as not certified yet (${refused.length})`);
  assert.ok(!pageOk || held.size >= lockSetThreshold(7),
    `the page counts its reveal done while only ${held.size} honest seat(s) hold the move (${[...held].join(', ')}): 5 hostnames of one stranger's box filled the threshold`);
});
