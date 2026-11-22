// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit 2026-11-19 h2h r1 #1: ONE SEAT THAT HOLDS THE LOCK-SET CERTIFICATE FIRST ENDS UP THE ONLY SEAT HOLDING THE HONEST PLAYER'S REVEAL.
//
// Seven seats, threshold 5. The honest seats sign the set and push their signatures to every peer. The attacker's seat s0 adds its own
// signature to the first 4 honest ones, so it holds a valid certificate one honest signature before any honest seat can. It serves that
// certificate to the player's page and keeps it from its peers (it can tell a seat's pull from a page's GET). The page checks the certificate
// (it stands: 5 committee signatures) and posts its reveal to every seat once. Every honest seat answers POST /reveal with 409 "that round's
// lock set is not certified yet ... ask again shortly" (server.js:11813-11815), and s0 answers 201.
// revealWhenCertified returns at once (head-to-head.js:206-208). The page's reveal() reads one 201 as ok (index.html:8265), the RPS client
// stops retrying when ok is true (index-v5.html:829), and nothing posts the move again to the seats that refused it.
// A moment later the honest seats certify among themselves. At the decide (verify.js #headToHeadClose / carryReveals) they find the honest
// entry's reveal nowhere except at s0, which answers GET /reveals without it. Every peer has answered, so nothing waits (#1589/#2708): the
// honest player is FORFEIT, and the opponent is the lone revealer and WINS the pot.
//
// SAFE BEHAVIOUR: a reveal is not finished while the seats that answered "not certified yet" have not taken it. They are asked again until
// at least a threshold of seats hold the move, so no single seat can be the only holder.
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
// s0 (the attacker, secrets[0]) + the first four honest signers (secrets[1..4]): a certificate that stands at threshold 5
const cert = (() => {
  const set = lockSetOf({ roundId: ROUND, entries: [MINE, THEIRS] });
  const sigs = secrets.slice(0, 5).map((sec) => ({ key: schnorr.getPublicKey(sec), atMs: BigInt(CLOSE + 900), sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: BigInt(CLOSE + 900) }), sec) }))
    .sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  return toHex(encodeLockSetCertificate({ set, sigs }));
})();
const nodes = Array.from({ length: 7 }, (_, i) => `http://s${i}`);

test('audit-h2h-r1-1: a seat first to hold the certificate is not left the only holder of the honest reveal', async () => {
  let t = CLOSE + 200;
  const now = () => t;
  // the honest seats certify among themselves at close + 1.6 s (the fifth honest signature reaches them); s0 has its certificate from the start
  const honestCertified = () => t >= CLOSE + 1600;
  const held = new Set();          // seats that took the reveal (201)
  const refused = [];              // seats that answered 409 'not certified yet'
  const fetcher = async (u, o = {}) => {
    const node = u.slice(0, u.indexOf('/', 7));
    if ((o.method || 'GET') === 'POST') {
      if (node === 'http://s0' || honestCertified()) { held.add(node); return { ok: true, status: 201, body: null, text: async () => '' }; }
      refused.push(node);
      return { ok: false, status: 409, body: null, text: async () => 'that round\'s lock set is not certified yet: no reveal is taken before it (kanban #2561) - ask again shortly' };
    }
    const j = node === 'http://s0' || honestCertified()
      ? { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort() }
      : { required: true, certificate: null, void: false };
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  // each poll moves the clock 150 ms on (H2H_LOCK_SET_POLL_MS)
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now, sleep: async () => { t += 150; } });
  // the page's reveal() (src/arena-ui/index.html:8265) reads this as done
  const pageOk = Array.isArray(got.seats) && got.seats.some((x) => x.status === 201 || x.status === 200);
  assert.ok(refused.length >= 6, `precondition: the honest seats refused the first post as not certified yet (${refused.length})`);
  assert.ok(!pageOk || held.size >= lockSetThreshold(7),
    `the page counts its reveal done while only ${held.size} seat(s) hold the move (${[...held].join(', ')}): the honest seats answered "ask again shortly" and were never asked again - the one seat that holds it can withhold it and the honest player FORFEITS`);
});

