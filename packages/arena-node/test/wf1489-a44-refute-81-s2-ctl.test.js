// kanban #1489 refute (skeptic 2) of #1787/#2179: the hand-on is one best-effort post, at the instant the seat takes it.
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SM-4 (MARKET_STATE): each seat decides OPEN -> ATTESTED or OPEN -> VOID on ITS OWN arrival time against the deadline D. The #1787
// fix posts a fresh attestation on to the settlement seats once, at the moment it is taken, 3 s bounded, never again: (1) a stranger
// who times his post to land at seat a just before D wins the race against the seat-to-seat link - the hand-on lands at b after D,
// b refuses it and is VOID; (2) a seat b that is restarting (unreachable) for the one moment a hands it on never gets it - the
// daemon's retry to a is "held already" (200, not handed on again), and the daemon reaches b after D. FINAL at a, VOID at b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signAddressAnnouncement } from '../../arena-protocol/src/address-announcement.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { marketExpiryBlocks } from '../../arena-protocol/src/lock-expiry.js';
import { LOSER } from './window-fixture.js';
import { skipTo, skipBy, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const STAKE = 1_000_000n;
const TERMS = { nodeFeeBps: 50, donationBps: 50, question: 'Where does BTC/USD close?', resolveAfterCloseMs: 60000n, deadlineAfterResolveMs: 60000n, sourceRule: 'median of three test feeds' };
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0x58 + n), worldSecret: b32(0) });

// a link from seat a to seat b: `mode` 'latency' lets `ms` of the shared clock pass in transit, 'down' drops the connection (b restarting)
function link(bPort, mode, ms = 0) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split('?')[0]}`);
    if (mode.now === 'down') { req.socket.destroy(); return; }
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
      if (mode.now === 'latency' && req.method === 'POST' && req.url.startsWith('/outcome')) skipBy(ms);
      try {
        const r = await fetch(`http://127.0.0.1:${bPort}${req.url}`, { method: req.method, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks), headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' } });
        const body = Buffer.from(await r.arrayBuffer());
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' }); res.end(body);
      } catch { res.writeHead(502); res.end(); }
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((d) => { srv.closeAllConnections?.(); srv.close(() => d()); }) })));
}

async function run(tag, mode, ms) {
  const M = testAttestedGame({ name: `btc-close-s2-${tag}`, outcomes: ['above 100k', 'between', 'below 90k'], marketTerms: TERMS });
  const ROUND = { gameId: M.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 60000n };
  const [A0, , A2] = M.attestors;
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, stakeExpiryFor: (c) => marketExpiryBlocks(c, TERMS).blocks,
    serveOpts: { plugins: [NEXTBLOCK, M.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const state = { now: 'pass' };
  const l = await link(w.b.port, state, ms);
  try {
    const played = [];
    for (const [i, pick] of [0, 1].entries()) played.push(await lockAndPlay(w, player(i), { noMarks: true, pick }));
    await closeRound(w, { window: false });
    const deadlineMs = Number(w.c.entryCloseMs) + 120000;
    const body = { roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 60000n };
    const bytes = encodeAttestation({ ...body, signatures: [A0, A2].map((a) => attestorSign(a, body)) });
    const post = (d) => fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`, { method: 'POST', body: bytes }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 90)}`);
    // seat a reaches seat b through the link (the seat-to-seat path; the attestor and the stranger reach b directly)
    // (seat b's own signed address announcement, as a seat behind a tunnel or a new host posts it: a reaches b at the link)
    const ann = signAddressAnnouncement({ node: toHex(w.b.round.pubkey), endpoint: l.url, atMs: Date.now() }, (d) => schnorr.sign(d, w.b.round.identity.secret));
    const took = await fetch(`http://127.0.0.1:${w.a.port}/address-announcement`, { method: 'POST', body: JSON.stringify(ann) }).then(async (r) => `${r.status} ${(await r.text()).slice(0, 80)}`);
    const keep = w.a.dkg.peers; w.a.dkg.peers = [l.url];
    state.now = mode;
    let atA, atA2 = null, atB = null;
    if (mode === 'latency') {
      // THE STRANGER times his post to land at seat a 20 ms before D; the seat-to-seat link takes longer than that
      skipTo(deadlineMs - 20);
      atA = await post(w.a);
    } else {
      // THE DAEMON reaches seat a a second before D, while seat b is restarting; a's one hand-on is lost
      skipTo(deadlineMs - 1000);
      atA = await post(w.a);
      state.now = 'pass';
      // b is back; the daemon tries a again (held already, 200: not handed on again), then reaches b after D
      atA2 = await post(w.a);
      skipTo(deadlineMs + 1000);
      atB = await post(w.b);
    }
    w.a.dkg.peers = keep; state.now = 'pass';
    skipTo(deadlineMs + 600000 + 1000);
    const stateOf = async (d) => { const o = await (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`)).json(); return o.market || o.state; };
    const states = [await stateOf(w.a), await stateOf(w.b)];
    const settled = await w.a.settlements.settle(w.rid);
    console.log(`  #1489 a44-refute-81-s2-1 ${tag}:`, JSON.stringify({ took, atA, atA2, atB, link: l.seen, states, settle: [settled.state, String(settled.why || '').slice(0, 120)] }));
    assert.match(atA, /^20[01]/, 'seat a took the attestation before the deadline');
    assert.ok(l.seen.some((s) => s.startsWith('POST /outcome')), 'seat a handed it on to seat b through the link');
    assert.equal(states[0], states[1], `the two seats of one market decide it differently: seat a ${states[0]}, seat b ${states[1]}`);
  } finally { await l.close(); await w.close(); }
}

test('#1489 a44-refute-81-s2-CONTROL zero latency: a stranger times his post to land at seat a just before the deadline; the hand-on reaches seat b after it - FINAL at a, VOID at b', { timeout: 170000 }, () => run('ctl', 'latency', 0));

