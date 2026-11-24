// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// AUDIT h2h a7 r3 #1 (gap in #3307, the #3210 trick on the lock-set poll): #3307 made lockSetOfSeats count answers and voids per HOSTNAME
// (seatsByHost / h2hHostKey), so nine junk PATHS of one box are one voice. But a hostname costs nothing: one stranger's box under nine DNS
// names (evil0.example .. evil8.example, wildcard DNS or nip.io) is nine "hosts". The node list is the join link's, so a link naming the
// round's seven seats plus those nine names makes the box's instant answers a majority of hosts by themselves: every poll ends
// H2H_STRAGGLER_MS (500 ms) after them, an honest seat answering in 600 ms is never heard, and
//   (a) the box's nine unsigned `void: true` reach voidsNeeded (n - threshold + 1 = 3) past close + 6 s: the page gives up as VOID, or
//   (b) the box's `required: false` makes the page reveal ONCE without the #3015/#3204 ask-again loop: the honest seats, not yet certified,
//       answer 409 "not certified yet - ask again shortly" and are never asked again.
// Either way the honest player never reveals at the seats that decide: FORFEIT, the opponent (the link's author) wins the pot.
// SAFE: names of one box cannot outvote the round's seats - the page reveals to the honest seats that hold the certificate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { revealWhenCertified } from '../src/head-to-head.js';
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
  const at = BigInt(CLOSE + 900);
  const sigs = secrets.slice(0, 5).map((sec) => ({ key: schnorr.getPublicKey(sec), atMs: at, sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: at }), sec) }))
    .sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  return toHex(encodeLockSetCertificate({ set, sigs }));
})();
const honest = Array.from({ length: 7 }, (_, i) => `https://seat${i}.example`);
const names = Array.from({ length: 9 }, (_, i) => `https://evil${i}.example`);   // ONE box, nine DNS names
const isEvil = (u) => /^https:\/\/evil\d\.example/.test(u);

// `boxSays`: what the box answers GET /lock-set; an honest seat's first POST /reveal still meets a certificate forming there (their POST /reveal says
// "not certified yet" until then, as a seat whose certificate is still forming does)
function run(nodes, boxSays) {
  let t = CLOSE + 200;
  const postsTo = new Map();
  const posts = [];
  const fetcher = async (u, o = {}) => {
    if ((o.method || 'GET') === 'POST') {
      posts.push(u);
      if (isEvil(u)) return { ok: true, status: 201, body: null, text: async () => '' };
      const k = u.slice(0, u.indexOf('/', 8)); postsTo.set(k, (postsTo.get(k) || 0) + 1);
      if (postsTo.get(k) === 1) return { ok: false, status: 409, body: null, text: async () => 'that round\'s lock set is not certified yet: no reveal is taken before it (kanban #2561) - ask again shortly' };
      return { ok: true, status: 201, body: null, text: async () => '' };
    }
    if (isEvil(u)) return { ok: true, status: 200, body: null, text: async () => JSON.stringify(boxSays) };
    // an honest seat: answers in 600 ms, with the standing certificate
    await new Promise((ok) => setTimeout(ok, 600));
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort(), void: false }) };
  };
  return revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now: () => (t += 1000), sleep: async () => {} }).then((got) => ({ got, posts, t }));
}
const heldAtHonest = (posts) => new Set(posts.filter((u) => !isEvil(u)).map((u) => u.slice(0, u.indexOf('/', 8)))).size;

test('control: seven honest seats answering in 600 ms are heard and the move is revealed to them', async () => {
  const { got, posts } = await run(honest, null);
  assert.ok(got.certified, 'the certificate is seen');
  assert.ok(heldAtHonest(posts) >= 7);
});

test('(a) one box under nine DNS names in the join link does not make the page give up as VOID', async () => {
  const { got, posts, t } = await run([...honest, ...names], { required: true, certificate: null, void: true });
  assert.notEqual(got.void, true, `the page gave up as VOID at close + ${t - CLOSE} ms ("${got.why}") while all 7 seats served a standing certificate`);
  assert.ok(heldAtHonest(posts) >= 7, `the move was posted to ${heldAtHonest(posts)} honest seats`);
});

test('(b) one box under nine DNS names saying required:false does not make the page reveal once and stop', async () => {
  const { got, posts } = await run([...honest, ...names], { required: false });
  const honestPosts = posts.filter((u) => !isEvil(u)).length;
  assert.ok(got.certified, `the page never saw the honest seats' certificate (required:false path taken); honest seats were posted ${honestPosts} times`);
  assert.ok(honestPosts > 7, `every honest seat answered "not certified yet - ask again" and was never asked again (${honestPosts} posts)`);
});
