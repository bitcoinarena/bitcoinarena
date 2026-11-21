// kanban #3025: the card's test (audit h2h r2-1 of 2026-11-19)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// AUDIT h2h r2 #1: ONE SLOW SEAT MUST NOT HOLD THE PLAYER'S REVEAL BEHIND A CERTIFICATE THE PAGE ALREADY HOLDS.
// Seven seats; six honest seats certify the round's lock set shortly after the close (pending on the page's first ask, certified from the
// next). One seat answers every GET /lock-set with { required: true, certificate: null } just under H2H_SEAT_MS (4.5 s). lockSetOfSeats awaits
// every seat (Promise.all) before it looks at any certificate, so each poll of revealWhenCertified takes as long as the slowest seat: the page,
// and the house bot (tools/h2h-reveal.mjs), post the move only ~9 s after the honest seats served a standing certificate.
// SAFE: once a certificate that stands against the committee is in hand, the reveal goes out without waiting for the slowest seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { revealWhenCertified } from '../src/head-to-head.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockSetOf, lockSetId, lockSetSignatureId, encodeLockSetCertificate } from '../../arena-protocol/src/lock-set.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x51 + i));
const committee = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const CLOSE = Date.now() - 200;
const ROUND = b32(0x61), MINE = b32(0x62), THEIRS = b32(0x63);
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const cert = (() => {
  const set = lockSetOf({ roundId: ROUND, entries: [MINE, THEIRS] });
  const sigs = secrets.slice(1, 6).map((sec) => ({ key: schnorr.getPublicKey(sec), atMs: BigInt(CLOSE + 900), sig: schnorr.sign(lockSetSignatureId({ setId: lockSetId(set), atMs: BigInt(CLOSE + 900) }), sec) }))
    .sort((a, b) => (toHex(a.key) < toHex(b.key) ? -1 : 1));
  return toHex(encodeLockSetCertificate({ set, sigs }));
})();
const nodes = Array.from({ length: 7 }, (_, i) => `http://s${i}`);

test('a seat answering GET /lock-set just under the deadline does not delay the reveal once the certificate stands', async () => {
  const asked = new Map();
  let firstPostAt = null, certServedAt = null;
  const t0 = Date.now();
  const fetcher = async (u, o = {}) => {
    const node = u.slice(0, u.indexOf('/', 7));
    if ((o.method || 'GET') === 'POST') { if (firstPostAt === null) firstPostAt = Date.now(); return { ok: true, status: 201, body: null, text: async () => '' }; }
    const i = asked.get(node) || 0; asked.set(node, i + 1);
    if (node === 'http://s0') {   // the slow seat: a valid, honest-looking answer, just under the page's 5 s deadline
      await new Promise((ok) => setTimeout(ok, 4500));
      return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ required: true, certificate: null }) };
    }
    // the six honest seats: pending on the first ask (still signing), certified from the second
    const j = i === 0 ? { required: true, certificate: null } : { required: true, certificate: cert, entries: [toHex(MINE), toHex(THEIRS)].sort() };
    if (i > 0 && certServedAt === null) certServedAt = Date.now();
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(j) };
  };
  const got = await revealWhenCertified({ roundIdHex: toHex(ROUND), entryIdHex: toHex(MINE), move: 1, salt: b32(9), nodes, committee, verify, entryCloseMs: CLOSE, fetcher });
  assert.ok(got.certified, 'the round was certified');
  const after = firstPostAt - t0;
  assert.ok(after < 2500, `the move was posted ${after} ms after the page started waiting, ${firstPostAt - certServedAt} ms after the honest seats served a standing certificate`);
});

