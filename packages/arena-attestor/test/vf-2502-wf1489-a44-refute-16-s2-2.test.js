// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2502 (#2536): the card's test as 1.9 reads it - the same adaptation as sup-2465-liar-close-2 (that file).
// Adapted to 1.9 by #2536 (kanban #2465): the round id was made up, so no seat could serve its contract; 1.9's attestor decides a split
// listing by the round's own bytes (GET /round, roundCloseOf). Here the round is a real contract's id, served by the honest seats only.
// kanban #1489 refute 2 of #1613 (982e0a3b2): A WORD SIGNED WHILE THE HONEST SEATS RESTART FIXES THE LIAR'S CLOSE FOR GOOD.
// Retry/resume path: "a word already signed fixes the round's close". The honest seats (three of four, a clear majority) are
// restarting for one tick (their /rounds answers 503); the liar alone names the round, one window earlier: the word is signed on
// that window and roundMeta keeps it. When the honest seats are back, kept beats their majority - every post is refused, VOID.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { attestorKey } from '../src/attestor.js';
import { encodeManifest, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { decodeAttestation } from '../../arena-protocol/src/attested.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = generateKeyPairSync('ed25519').privateKey;
const SEED = b32(0x41);
const ME = attestorKey(SEED);
const market = () => {
  const body = {
    gameName: 'btc-updown-15m', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [ME.pubkey], attestThreshold: 1,
  };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV)) };
  return { id: toHex(gameIdOf(m)), name: 'btc-updown-15m', manifest: toHex(encodeManifest(m)) };
};
// a real round contract: 1.9's attestor settles a disagreement between seats' listings by the round's own bytes (GET /round, roundCloseOf)
const contractOf = (gameId, closeMs) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId, simCoreHash: b32(1),
  startTimeMs: closeMs - 900000n, entryCloseMs: closeMs, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: closeMs - 1500000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
});
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

function setup(tag) {
  const dir = mkdtempSync(join(tmpdir(), `wf1489-a44-refute-16-s2-${tag}-`));
  const closeMs = BigInt(Date.now()) - 20000n;
  const samples = [];
  for (let t = closeMs - 1800000n - 120000n; t <= closeMs; t += 10000n) samples.push({ atMs: String(t), price: String(t < closeMs - 120000n ? (t < closeMs - 1020000n ? 5900000 : 6000000) : 6100000), big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  return { dir, closeMs };
}
const daemon = (dir, seats, port) => {
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m',
    '--seats', seats.join(','), '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', String(port),
    '--samples-file', join(dir, 'samples'), '--markets-every-ms', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  return { child, lines };
};

const serve = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });


// an honest seat as server.js answers POST /outcome: the attestation's observedAtMs must be this round's window end (else 409)
const honestSeat = (v1, ROUND, closeMs, accepted, refused, listing = () => true) => serve((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/round') { if (!listing()) { res.writeHead(503); return res.end('restarting'); } res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from(encodeRoundContract(contractOf(fromHex(v1.id), closeMs)))); }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/games') return json(res, { games: [v1] });
  if (url.pathname === '/rounds') {
    if (!listing()) { res.writeHead(503); return res.end('restarting'); }
    return json(res, { rounds: [{ id: ROUND, game: { id: v1.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs) }] });
  }
  if (url.pathname === '/outcome' && req.method === 'POST') {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      let a; try { a = decodeAttestation(new Uint8Array(Buffer.concat(chunks))); } catch { res.writeHead(400); return res.end('bad'); }
      if (a.observedAtMs === closeMs) { accepted.push(url.searchParams.get('round')); res.writeHead(201); return res.end('held'); }
      refused.push(String(a.observedAtMs)); res.writeHead(409); res.end('that attestation says it was observed at another time, and this round\'s window ends earlier or later: it is the outcome of another window');   // server.js / attested.js text
    });
  }
  res.writeHead(404); res.end();
});
// the liar: lists the honest series round's id (a series round: no contract binds its close) one window EARLIER
const liarSeat = (v1, ROUND, closeMs) => serve((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/games') return json(res, { games: [v1] });
  if (url.pathname === '/rounds') return json(res, { rounds: [{ id: ROUND, game: { id: v1.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs - 900000n) }] });
  if (url.pathname === '/outcome' && req.method === 'POST') { req.resume(); return req.on('end', () => { res.writeHead(404); res.end('this node holds no such round'); }); }
  res.writeHead(404); res.end();
});

test('#2465 (1.9): a word signed while the honest seats restart is not fixed on the liar\'s close once they are back', { timeout: 60000 }, async () => {
  const { dir, closeMs } = setup('restart');
  const v1 = market();
  const ROUND = toHex(roundId(contractOf(fromHex(v1.id), closeMs)));
  const accepted = []; const refused = [];
  const t0 = Date.now();
  const up = () => Date.now() - t0 > 7000;          // the first tick (about 5 s) finds them restarting
  const honest = [];
  for (let i = 0; i < 3; i++) honest.push(await honestSeat(v1, ROUND, closeMs, accepted, refused, up));
  const liar = await liarSeat(v1, ROUND, closeMs);
  const seats = [...honest.map((s) => `http://127.0.0.1:${s.address().port}`), `http://127.0.0.1:${liar.address().port}`];
  const { child, lines } = daemon(dir, seats, await freePort());
  try {
    for (let i = 0; i < 300 && !accepted.length; i++) await new Promise((r) => setTimeout(r, 100));
    console.log('  accepted:', JSON.stringify(accepted), 'refused:', refused.length, 'on', refused[0], 'true close:', String(closeMs));
    assert.ok(accepted.includes(ROUND), `three honest seats back for 20 s never got the round's own window - ${refused.length} posts refused on ${refused[0]} (the liar's close). The daemon said:\n${lines.filter((l) => /signed|another entry close/.test(l)).join('\n')}`);
  } finally { child.kill(); liar.close(); for (const s of honest) s.close(); }
});
