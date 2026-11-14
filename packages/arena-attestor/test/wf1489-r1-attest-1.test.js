// kanban #1489 audit r1-find-attest, finding 1: THE ATTESTOR DAEMON TAKES A ROUND'S TIMES FROM THE FIRST SEAT THAT ANSWERS.
// roundsOfGame() returns the /rounds listing of the first seat in --seats that answers 200, and the daemon signs the window
// [entryCloseMs - period, entryCloseMs] that this ONE seat states - once (words memo), never re-checked. One seat out of 7:
//  (a) names a close shifted inside the market's deadline (resolveAfterCloseMs 0, deadline 10 min): every attestor signs the
//      outcome of a window the seat picked while watching the price, with observed_at = that close, and every seat takes it
//      (attestationTimely only asks observed_at >= resolution time) - the seat chooses Up or Down for a round it bet on;
//  (b) leaves the round out of its listing: no attestor signs it, the round is VOID at its deadline and every stake goes back -
//      a free option for whoever lost.
// SAFE: the daemon signs only the close the seats agree on (or one on the market's grid that a majority states), and a round
// one seat hides is still attested from the others.
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
import { decodeAttestation } from '../../arena-protocol/src/attested.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const DEV = generateKeyPairSync('ed25519').privateKey;
const SEED = b32(0x51);
const ME = attestorKey(SEED);
const PERIOD = 900000n;
const market = () => {
  const body = {
    gameName: 'btc-updown-15m', gameDevPubkey: b32(0xde), version: 14, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED,
    cores: [], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0,
    clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Up', 'Down'], attestors: [ME.pubkey], attestThreshold: 1,
  };
  const m = { ...body, signature: new Uint8Array(sign(null, Buffer.from(manifestBodyId(body)), DEV)) };
  return { id: toHex(gameIdOf(m)), name: 'btc-updown-15m', manifest: toHex(encodeManifest(m)) };
};

// a seat: lists `rows()` and takes every POST /outcome
const seatOf = (games, rows, posts) => http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/games') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ games })); }
  if (url.pathname === '/rounds') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ rounds: rows() })); }
  if (url.pathname === '/outcome' && req.method === 'POST') {
    const parts = []; req.on('data', (c) => parts.push(c));
    return req.on('end', () => { posts.push({ round: url.searchParams.get('round'), bytes: Buffer.concat(parts) }); res.writeHead(201); res.end('held'); });
  }
  res.writeHead(404); res.end();
});

async function run({ liarRows, honestRows, C, samples, waitMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-attest-1-'));
  writeFileSync(join(dir, 'key'), SEED);
  writeFileSync(join(dir, 'samples'), JSON.stringify(samples));
  const g = market();
  const posts = [];
  const seats = [seatOf([g], () => liarRows(g), posts), seatOf([g], () => honestRows(g), posts), seatOf([g], () => honestRows(g), posts)];
  await Promise.all(seats.map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  const child = spawn(process.execPath, [new URL('../bin/arena-attestor.mjs', import.meta.url).pathname,
    '--name', 'T', '--key', join(dir, 'key'), '--sources', 'none,none', '--game', 'btc-updown-15m',
    '--seats', seats.map((s) => `http://127.0.0.1:${s.address().port}`).join(','), '--attestors', toHex(ME.pubkey), '--threshold', '1',
    '--port', '0', '--samples-file', join(dir, 'samples')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  try {
    for (let i = 0; i < waitMs / 100 && !posts.length; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 1500));
    return { posts, lines };
  } finally {
    child.kill();
    seats.forEach((s) => s.close());
  }
}

// the real round closes on the 15-minute grid at C (window [C - 15 min, C], Up); afterwards the price falls, so the window a
// lying seat picks 5 minutes later ends Down
function setup() {
  const now = BigInt(Date.now());
  const C = ((now - 320000n) / PERIOD) * PERIOD;      // a grid close at least 5 min 20 s ago
  const samples = [];
  for (let t = C - PERIOD - 180000n; t <= now; t += 10000n)
    samples.push({ atMs: String(t), price: String(t < C - 120000n ? 6000000 : t < C + 30000n ? 6100000 : 5000000), big: true });
  return { C, samples };
}

test('one seat (listed first) shifts a round\'s close: the attestor must still sign the real window [C - 15 min, C]', { timeout: 90000 }, async () => {
  const { C, samples } = setup();
  const ROUND = 'e1'.repeat(32);
  const LIE = C + 300000n;                             // inside the 10-minute deadline, and its window ends Down
  const { posts, lines } = await run({ C, samples, waitMs: 30000,
    liarRows: (g) => [{ id: ROUND, game: { id: g.id, name: g.name }, entryCloseMs: String(LIE) }],
    honestRows: (g) => [{ id: ROUND, game: { id: g.id, name: g.name }, entryCloseMs: String(C) }] });
  assert.equal(posts.length >= 1, true, `nothing posted:\n${lines.join('\n')}`);
  for (const p of posts) {
    const a = decodeAttestation(new Uint8Array(p.bytes));
    assert.deepEqual({ observedAtMs: a.observedAtMs, outcome: a.outcome }, { observedAtMs: C, outcome: 0 },
      `the attestor signed the window one seat named (close ${LIE}), not the round's (close ${C})`);
  }
});

test('one seat (listed first) hides a round from its listing: the attestor must still attest it from the other seats', { timeout: 90000 }, async () => {
  const { C, samples } = setup();
  const ROUND = 'e2'.repeat(32);
  const { posts, lines } = await run({ C, samples, waitMs: 25000,
    liarRows: () => [],
    honestRows: (g) => [{ id: ROUND, game: { id: g.id, name: g.name }, entryCloseMs: String(C) }] });
  assert.equal(posts.some((p) => p.round === ROUND), true,
    `one seat's empty listing kept the round from being attested at all (it goes VOID at its deadline, every stake back):\n${lines.slice(-5).join('\n')}`);
});
