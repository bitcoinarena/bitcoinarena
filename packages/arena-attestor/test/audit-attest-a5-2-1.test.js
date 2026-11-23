// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-22 a5, module attest, round 2, finding 1: THE FIXED ATTESTOR DAEMON KEEPS ITS READINGS 2 H (arena-attestor.mjs KEEP_MS),
// SO IT NEVER SIGNS A MARKET WHOSE WINDOW IS LONGER THAN ABOUT 2 H (gap in the #2406 / #1948 fix, which widened only the drawn seat's KEEP_MS).
// manifest.js seriesPeriodFits takes any attested period a day divides (2.4 h, 3 h, 4 h, 6 h, 12 h, 24 h), and the daemon runs each
// market on its manifest's own grid (periods / --period-ms). Up/Down's price to beat is the 60 s average ending at the window's START, so
// it needs the reading in force a minute before the start - which sample() (and the start-up read of --samples-file) drops once it is
// over 2 h old. For a 3 h market every word is 'signs nothing', no attestation is posted, and every round goes VOID at its deadline.
// SAFE: a daemon that read the whole window signs it, whatever period the market legally names (as the drawn seat since #2406).
// The daemon runs as in production, with its clock moved to one minute after a grid close (a --import preload), its readings in
// --samples-file every 10 s since before the window's start (as a daemon that ran the whole time keeps them), no exchange reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from 'node:crypto';
import { attestorKey } from '../src/attestor.js';
import { encodeManifest, manifestBodyId, gameIdOf, RESULT_TYPE, PAYOUT_RULE, NO_PARENT } from '../../arena-protocol/src/manifest.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { decodeAttestation } from '../../arena-protocol/src/attested.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const SEED = b32(0x41);
const ME = attestorKey(SEED);
const DEV = attestorKey(b32(0x42));
const market = (periodMs) => {
  const body = {
    gameName: 'btc-updown-15m', gameDevPubkey: DEV.pubkey, version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: periodMs, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [ME.pubkey], attestThreshold: 1,
  };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV.key)) };
  return { id: toHex(gameIdOf(m)), name: 'btc-updown-15m', manifest: toHex(encodeManifest(m)) };
};
const contractOf = (gameId, closeMs, periodMs) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId, simCoreHash: b32(1),
  startTimeMs: closeMs - periodMs, entryCloseMs: closeMs, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: closeMs - periodMs - 600000n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
});
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
const serve = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });

// an honest seat as server.js answers: the market, its round, the round's contract, and POST /outcome held when observed at the window's end
const seat = (v, ROUND, contract, closeMs, accepted) => serve((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/games') return json(res, { games: [v] });
  if (url.pathname === '/rounds') return json(res, { rounds: [{ id: ROUND, game: { id: v.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs) }] });
  if (url.pathname === '/round') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from(encodeRoundContract(contract))); }
  if (url.pathname === '/outcome' && req.method === 'POST') {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    return req.on('end', () => {
      let a; try { a = decodeAttestation(new Uint8Array(Buffer.concat(chunks))); } catch { res.writeHead(400); return res.end('bad'); }
      if (a.observedAtMs === closeMs) { accepted.push(a); res.writeHead(201); return res.end('held'); }
      res.writeHead(409); res.end('another window');
    });
  }
  res.writeHead(404); res.end();
});

async function run(periodMs, tag) {
  // the clock one minute after the last close on this period's grid (a day divides it, so 00:00 UTC is always on it)
  const real = BigInt(Date.now());
  const closeMs = real - (real % periodMs) - 86400000n;   // a close on the grid, a day back: the same instant on every run's grid
  const shift = Number(closeMs + 60000n - real);
  const dir = mkdtempSync(join(tmpdir(), `audit-attest-a5-2-1-${tag}-`));
  // readings every 10 s from 3 minutes before the window's start to its end: up 80,000.00 -> 81,000.00 (Up)
  const samples = [];
  for (let t = closeMs - periodMs - 180000n; t <= closeMs + 50000n; t += 10000n) samples.push({ atMs: String(t), price: String(t < closeMs - periodMs ? 8000000n : 8100000n), big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const v = market(periodMs);
  const contract = contractOf(fromHex(v.id), closeMs, periodMs);
  const ROUND = toHex(roundId(contract));
  const accepted = [];
  const s = await seat(v, ROUND, contract, closeMs, accepted);
  const preload = `data:text/javascript,${encodeURIComponent(`const o=${shift};const d=Date.now.bind(Date);Date.now=()=>d()+o;`)}`;
  const child = spawn(process.execPath, ['--import', preload, new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m', '--period-ms', String(periodMs),
    '--seats', `http://127.0.0.1:${s.address().port}`, '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', String(await freePort()),
    '--samples-file', join(dir, 'samples'), '--markets-every-ms', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  child.stderr.on('data', (d) => lines.push(String(d)));
  try {
    for (let i = 0; i < 150 && !accepted.length; i++) await new Promise((r) => setTimeout(r, 100));
  } finally { child.kill(); s.close(); }
  return { accepted, lines, ROUND };
}

test('control: a 1 h market (window inside the 2 h the daemon keeps) is signed and posted', { timeout: 60000 }, async () => {
  const { accepted, lines } = await run(3600000n, 'h1');
  assert.ok(accepted.length >= 1, `no attestation for the 1 h round; the daemon said:\n${lines.slice(-12).join('\n')}`);
  assert.equal(accepted[0].outcome, 0);
});

test('a legal 3 h market (a day divides it) is signed by a daemon that read its whole window', { timeout: 60000 }, async () => {
  const { accepted, lines } = await run(3n * 3600000n, 'h3');
  const said = lines.filter((l) => /signs nothing|signed/.test(l)).map((l) => { try { const j = JSON.parse(l); return `${j.step}: ${j.why || j.outcome || ''}`; } catch { return l; } });
  console.log(`  daemon: ${said.join(' | ')}`);
  assert.ok(accepted.length >= 1, `the daemon read every 10 s from before the 3 h window's start to its end and posted no attestation - ${said.join(' | ') || lines.slice(-6).join('\n')}`);
});
