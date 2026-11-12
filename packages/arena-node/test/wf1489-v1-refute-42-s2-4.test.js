// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489, #1912 + #1954 + #1991: the fix's own check of refute-42-s2-1 with four IPv4 addresses in four DIFFERENT /24s (no /24 grouping helps),
// read by tools/rps-opponent.mjs pass() as it now stands: a round that is over is skipped without counting.
// (Original note:) Variant: REAL rounds that are over, from four IPv4 addresses (four Tor exits, four VPS).
// a816b48a0 makes the test opponent skip a made-up round "without counting", but a round whose contract a seat still serves and whose entry
// has closed is counted (real++) and then skipped (left <= 0). Every IPv4 address is its own network, so four of them each hold a rank-0 row,
// newer than the real page's row because they re-post faster: the opponent counts its 4 and never reaches the real table.
// Real faucet.mjs over its POST door with the Worker's key, a stub seat serving real round contracts, and the pass loop of tools/rps-opponent.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeRoundContract, decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const KEY = 'k'.repeat(64);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = (closeMs) => encodeRoundContract({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
  startTimeMs: BigInt(closeMs - 8000), entryCloseMs: BigInt(closeMs), objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 100000n, blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656,
  spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(4), b32(7), b32(9)],
});

test('#1489 refute-42-s2-4: four IPv4 /24s posting real, closed rounds keep the real table out of the opponent\'s reading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489rf42s2-'));
  const port = 20000 + Math.floor(Math.random() * 10000);
  const real = 'ab'.repeat(32), stale = [1, 2, 3, 4].map((n) => String(n).repeat(64));
  const bytes = new Map([[real, contract(Date.now() + 60000)], ...stale.map((r) => [r, contract(Date.now() - 30000)])]);   // the stale ones: over, as any past round
  const seat = createServer((req, res) => { const id = new URL(req.url, 'http://x').searchParams.get('id'); const b = bytes.get(id); if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200); res.end(Buffer.from(b)); });
  await new Promise((ok) => seat.listen(0, '127.0.0.1', ok));
  const SEAT = `http://127.0.0.1:${seat.address().port}`;
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_WORKER_KEY: KEY }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await sleep(100); } }
    const want = async (round, ip) => (await (await fetch(`http://127.0.0.1:${port}/opponent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': ip, 'x-arena-worker': KEY }, body: JSON.stringify({ round, tapped: true }) })).json());
    assert.ok((await want(real, '198.51.100.20')).ok);
    const ips = ['203.0.113.1', '198.18.4.77', '192.0.2.5', '100.70.9.200'];   // four addresses, one row each
    for (let pass = 0; pass < 3; pass++) for (let i = 0; i < 4; i++) { await sleep(5); await want(stale[i], ips[i]); }
    const wants = (await (await fetch(`http://127.0.0.1:${port}/opponent`)).json()).wants;
    // tools/rps-opponent.mjs pass() now: contractOf, a closed one skipped, then real++
    const read = []; let counted = 0;
    for (const w of wants.slice(0, 16)) {
      if (counted >= 4) break;
      const k = await (async () => { const r = await fetch(`${SEAT}/round?id=${w.round}`); if (!r.ok) throw new Error(String(r.status)); return { c: decodeRoundContract(new Uint8Array(await r.arrayBuffer())) }; })().catch(() => null);
      if (!k) continue;
      if (Number(k.c.entryCloseMs) - Date.now() <= 0) continue;   // tools/rps-opponent.mjs since #1912: only an open table counts
      counted++;
      read.push(w.round);
    }
    console.log('  MEASURED:', JSON.stringify({ listed: wants.map((w) => w.round.slice(0, 4)), counted, botReads: read.map((r) => r.slice(0, 4)), realRead: read.includes(real) }));
    assert.ok(read.includes(real), `the real player's table is read by the test opponent: ${JSON.stringify({ listed: wants.map((w) => w.round.slice(0, 4)), counted, botReads: read.map((r) => r.slice(0, 4)) })}`);
  } finally { child.kill(); seat.close(); }
});
