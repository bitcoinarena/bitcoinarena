// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of fix:attest:3 (9a2c0df4c): the seat door now refuses an Up/Down attestation whose observed_at is not the round's
// window end - but the fixed-key attestor daemon still takes the round's window from the FIRST seat's unsigned GET /rounds entryCloseMs,
// signs it ONCE per round id (words cache) and never signs the round's real window afterwards. So the seat listed first still decides,
// after watching the price, whether a round settles on its real outcome or goes VOID (every stake back): a free option for a seat that
// bets (or a bettor it colludes with). Safe: the daemon's word for a round is the outcome of the round's own window, whatever one seat lists.
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
import { decodeAttestation, attestationTimely, marketVoided } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = generateKeyPairSync('ed25519').privateKey;
const SEED = b32(0x41);
const ME = attestorKey(SEED);
const P = 900000n;
const TERMS = { resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n };

test('wf1489-v1-refute-15-s1-1: one seat listing a shifted close makes the daemon sign another window once, and the round can only VOID', { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-refute-15-'));
  const body = { gameName: 'btc-updown-15m', gameDevPubkey: b32(0xde), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [ME.pubkey], attestThreshold: 1 };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV)) };
  const game = { id: toHex(gameIdOf(m)), name: 'btc-updown-15m', manifest: toHex(encodeManifest(m)) };
  const now = BigInt(Date.now());
  const CLOSE = now - 400000n;                 // the round's real window [CLOSE - 15 min, CLOSE] ended 400 s ago
  const SHIFT = 300000n;                       // one seat lists it as closing 5 min later (ended 100 s ago, inside the 600 s deadline)
  // the price: flat through the real window (a tie: Up), falling a minute after its close - the shifted window reads Down
  const samples = [];
  for (let t = CLOSE - P - 120000n; t <= now; t += 10000n) samples.push({ atMs: String(t), price: String(t < CLOSE + 60000n ? 6000000 : 5900000), big: true });
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const ROUND = 'c3'.repeat(32);
  let lie = true;                              // the first listing lies; once the daemon posted, every listing is honest
  const posts = [];
  const seat = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/games') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ games: [game] })); }
    if (url.pathname === '/rounds') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ rounds: [{ id: ROUND, game: { id: game.id, name: 'btc-updown-15m' }, entryCloseMs: String(lie ? CLOSE + SHIFT : CLOSE) }] }));
    }
    if (url.pathname === '/outcome' && req.method === 'POST') {
      const parts = []; req.on('data', (c) => parts.push(c));
      return req.on('end', () => {
        const att = decodeAttestation(new Uint8Array(Buffer.concat(parts)));
        lie = false;
        // the seat's door (server.js holdOutcome, merged): taken only when observed at the round's own window end
        const t = attestationTimely(att, { entryCloseMs: CLOSE, nowMs: BigInt(Date.now()), terms: TERMS, window: { startMs: CLOSE - P, endMs: CLOSE } });
        posts.push({ observedAtMs: att.observedAtMs, outcome: att.outcome, taken: t.ok, why: t.why });
        res.writeHead(t.ok ? 201 : 409); res.end(t.ok ? 'held' : t.why);
      });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => seat.listen(0, '127.0.0.1', r));
  const SEAT = `http://127.0.0.1:${seat.address().port}`;
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m', '--game-id', game.id,
    '--seats', SEAT, '--attestors', toHex(ME.pubkey), '--threshold', '1', '--port', '0', '--samples-file', join(dir, 'samples'), '--log', join(dir, 'log.jsonl')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  try {
    // the daemon ticks every 5 s: 30 s is six chances to sign the round's real window once the listing is honest
    for (let i = 0; i < 300 && !posts.some((p) => p.taken); i++) await new Promise((r) => setTimeout(r, 100));
    const held = posts.filter((p) => p.taken);
    const voided = marketVoided([], { entryCloseMs: CLOSE, terms: TERMS, nowMs: CLOSE + TERMS.deadlineAfterResolveMs });
    console.log('  wf1489-v1-refute-15-s1-1:', JSON.stringify({ close: String(CLOSE), listed: String(CLOSE + SHIFT), posts: posts.map((p) => ({ ...p, observedAtMs: String(p.observedAtMs) })),
      held: held.length, atDeadline: voided, signed: lines.filter((l) => /"step":"(signed|post refused)"/.test(l)).slice(0, 4) }));
    assert.ok(posts.length >= 1, `the daemon posted nothing:\n${lines.join('\n')}`);
    // SAFE: the round's own outcome (Up, observed at its window end) reaches the seat; a seat listing a shifted close cannot turn it VOID
    assert.equal(held.length >= 1, true, `the daemon signed only the window one seat listed (observed_at ${posts[0].observedAtMs}, ${Number(posts[0].observedAtMs - CLOSE) / 1000} s after the round's window end), the seat refused it, and the daemon never signed the round's real window: the round goes VOID (${voided.why})`);
  } finally {
    child.kill();
    seat.close();
  }
});
