// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// AUDIT h2h a5 r2 #1 (gap in #3025 / #2984, the #3154 / #3204 class): lockSetOfSeats ends each poll H2H_STRAGGLER_MS (500 ms) after a MAJORITY OF
// THE LISTED ADDRESSES answered, and revealWhenCertified gives up on VOID once `voids` (counted per ADDRESS) reach n - threshold + 1. The
// node list is the join link's (joinFromQuery, carried on to every round of the page by lobbyJoinSearch), so a link that names the round's
// seven seats plus nine paths of one stranger's box (http://evil/a .. /i) makes the box's instant answers a majority by themselves: every poll
// ends 500 ms after them, an honest seat that answers in 600 ms (a phone over the tunnel, a loaded seat) is never heard, and the box's nine
// unsigned `void: true` end the wait past close + 6 s. The honest seats certified the set at close + 0.9 s, but the page never reveals: its
// entry FORFEITS and the opponent (the link's author) wins the pot.
// SAFE: answers from addresses of one host (or the voids of one host) are one voice, so junk paths neither cut the honest seats' answers short
// nor make a VOID; the page reveals to the honest seats that hold the certificate.
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
const junk = 'abcdefghi'.split('').map((p) => `https://evil.example/${p}`);

function run(nodes) {
  let t = CLOSE + 200;
  const reveals = [];
  const fetcher = async (u, o = {}) => {
    const node = u.slice(0, u.indexOf('/', 8));
    const isJunk = u.startsWith('https://evil.example/');
    if ((o.method || 'GET') === 'POST') { reveals.push(u); return { ok: true, status: 201, body: null, text: async () => '' }; }
    if (isJunk) return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ required: true, certificate: null, void: true }) };
    // an honest seat: holds the standing certificate, answers in 600 ms
    await new Promise((ok) => setTimeout(ok, 600));
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort(), void: false }) };
  };
  return revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE,
    fetcher, now: () => (t += 1000), sleep: async () => {} }).then((got) => ({ got, reveals, t }));
}

test('control: seven honest seats answering in 600 ms are heard and the move is revealed', async () => {
  const { got, reveals } = await run(honest);
  assert.ok(got.certified && reveals.length >= 7);
});

test('nine junk paths of one box in the join link do not keep the honest seats\' certificate from the page', async () => {
  const { got, reveals, t } = await run([...honest, ...junk]);
  assert.notEqual(got.void, true, `the page gave up as VOID at close + ${t - CLOSE} ms ("${got.why}") while all 7 seats served a standing certificate`);
  assert.ok(reveals.filter((u) => !u.startsWith('https://evil.example/')).length >= 7, `the move was revealed to ${reveals.length} honest seats`);
});
