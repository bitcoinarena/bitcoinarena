// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit round 4 (attestations / markets): THE ATTESTOR DAEMON READS A SEAT'S GET /round ANSWER UP TO A CAP.
// #2457 capped GET /games, /rounds and the peers' /attestation - but contractFrom() still reads GET /round?id= with
// `x.arrayBuffer()` (and GET /series-template with `y.text()`) whole. One seat of --seats lists a made-up round of the market
// (due, inside its UNVERIFIED_PER_SEAT share) and answers its /round with an endless body: the daemon buffers all of it - one
// such fetch per listed round, all at once (handleRound is not awaited) - until the attestor runs out of memory and dies: no
// attestation for any round, every market round VOID at its deadline. A contract is under 1 kB; the safe reader stops early.
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
import { toHex } from '../../arena-protocol/src/hash.js';

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
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

test('one seat answering GET /round with an endless body: the attestor stops reading it early (no unbounded buffer)', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r4-attest-11-'));
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), '[]');
  const closeMs = BigInt(Date.now()) - 20000n;
  const v1 = market();
  const ROUND = 'ab'.repeat(32);
  const LIMIT = 256 * 1024 * 1024;           // what the liar is ready to send
  let sent = 0, asked = 0, ended = false;
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  const liar = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') return json(res, { games: [v1] });
    if (url.pathname === '/rounds') return json(res, { rounds: [{ id: ROUND, game: { id: v1.id, name: 'btc-updown-15m' }, entryCloseMs: String(closeMs) }] });
    if (url.pathname === '/round') {
      asked++;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let open = true;
      res.on('close', () => { open = false; });
      const pump = () => {
        while (open && sent < LIMIT) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        if (open) { ended = true; res.end(); }
      };
      return pump();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => liar.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m',
    '--seats', `http://127.0.0.1:${liar.address().port}`, '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', String(await freePort()),
    '--samples-file', join(dir, 'samples'), '--markets-every-ms', '1000'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  try {
    for (let i = 0; i < 300 && !(asked && (ended || sent > 0)); i++) await new Promise((r) => setTimeout(r, 100));
    // let the transfer run its course (8 s fetch timeout at most)
    for (let i = 0; i < 120 && !ended; i++) { const was = sent; await new Promise((r) => setTimeout(r, 100)); if (was === sent && i > 20) break; }
    console.log(`  GET /round asked ${asked} time(s); the daemon took ${(sent / 1048576).toFixed(0)} MiB of the liar's body (ended: ${ended})`);
    assert.ok(asked > 0, `the daemon never asked for the round's contract:\n${lines.slice(-5).join('\n')}`);
    // SAFE: a contract is under 1 kB - the daemon stops reading a /round answer long before 16 MiB
    assert.ok(sent < 16 * 1024 * 1024, `the attestor daemon read ${(sent / 1048576).toFixed(0)} MiB of one seat's GET /round answer for a made-up round (no cap)`);
  } finally { child.kill(); liar.close(); }
});
