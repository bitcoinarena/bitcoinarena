// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Refute of #3015 / #3154 (audit h2h r1-1), skeptic 2 variant 1: THE LIVE SEATS ALL SIT ON ONE HOST, SO "A THRESHOLD OF HOSTS" IS ONE SEAT.
//
// 7935b601b counts holders per hostname and caps the threshold at the number of hosts: need = min(hosts.length, lockSetThreshold(committee)).
// The live seats are https://tn4.bitcoin-arena.io/guardian-1 .. guardian-7 (daily.json, docs): ONE hostname, so need = 1 and the first seat that
// takes the reveal ends the loop. The audit's attack word for word, by one seat (guardian-1 one signature ahead, the first to serve its
// certificate): every other seat answers 409 "not certified yet - ask again shortly", and none is ever asked again. Only guardian-1 holds the
// move - the forfeit #3015 closed (b44acc9c5 counted per address and asked them again) is open again. Without any attacker, the same happens
// whenever one honest seat certifies a moment before the others.
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

test('wf1489-r1120b-refute-19-s2-1: seats on one tunnel host (tn4/guardian-1..7) - the honest seats that said "not certified yet" are asked again', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => `https://tn4.bitcoin-arena.io/guardian-${i + 1}`);
  let t = CLOSE + 200;
  const now = () => t;
  const honestCertified = () => t >= CLOSE + 1600;
  const held = new Set(); const refused = [];
  const fetcher = async (u, o = {}) => {
    const seat = new URL(u).pathname.split('/')[1];
    const ahead = seat === 'guardian-1';
    if ((o.method || 'GET') === 'POST') {
      if (ahead || honestCertified()) { held.add(seat); return { ok: true, status: 201, body: null, text: async () => '' }; }
      refused.push(seat);
      return { ok: false, status: 409, body: null, text: async () => 'that round\'s lock set is not certified yet: no reveal is taken before it (kanban #2561) - ask again shortly' };
    }
    const j = ahead || honestCertified()
      ? { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort() }
      : { required: true, certificate: null, void: false };
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now, sleep: async () => { t += 150; } });
  const pageOk = Array.isArray(got.seats) && got.seats.some((x) => x.status === 201 || x.status === 200);
  assert.ok(refused.length >= 6, `precondition: the other seats refused the first post as not certified yet (${refused.length})`);
  assert.ok(!pageOk || held.size >= lockSetThreshold(7),
    `the page counts its reveal done while only ${held.size} seat(s) hold the move (${[...held].join(', ')}): seven seats on one host are one "holder", the threshold became 1`);
});
