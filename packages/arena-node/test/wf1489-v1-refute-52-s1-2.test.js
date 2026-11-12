// kanban #1723 (#1489 v1 refute of #1540): the duty poster's reads of census seats' GET /games are bounded in bytes and in games,
// measured without watching r.json (the bounded reader no longer calls it): how many manifests reach decode, and what the read gives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createGridBase } from '../src/duty-day.js';
import { PEER_LISTING_GAMES } from '../src/peer-read.js';

const serve = async (body) => { const s = createServer((q, r) => { if (!q.url.startsWith('/games')) { r.writeHead(404); return r.end(); } body(r); });
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok)); return s; };
const base = (E, decode) => createGridBase({ chainCall: async () => 0, censusEntriesAt: async () => [], contractAt: () => ({}), catalogSeats: async () => [E],
  chainSeats: async () => [], decode, idOf: () => new Uint8Array(32), blockHashOf: () => null, donationSetAt: () => null });

test('#1723: a census seat listing 1,000 games has at most PEER_LISTING_GAMES of them decoded', async () => {
  const games = Array.from({ length: 1000 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), manifest: '00' }));
  const s = await serve((r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ games })); });
  let decoded = 0;
  try {
    await base(`http://127.0.0.1:${s.address().port}`, () => { decoded++; throw new Error('not a manifest'); }).seatCatalog().catch(() => null);
    assert.ok(decoded > 0 && decoded <= PEER_LISTING_GAMES, `${decoded} manifests decoded from one seat's listing`);
  } finally { s.closeAllConnections?.(); s.close(); }
});

test('#1723: a census seat streaming a 120 MB listing is refused before any manifest is decoded, and the read stops', async () => {
  let sent = 0, decoded = 0;
  const s = await serve((r) => {
    r.writeHead(200, { 'content-type': 'application/json' }); r.write('{"games":[');
    const chunk = '{"id":"00","manifest":"00","title":"x"},'.repeat(10000);
    const pump = () => { while (sent < 120 * 1048576) { sent += chunk.length; if (r.destroyed) return; if (!r.write(chunk)) return r.once('drain', pump); } r.end('{"id":"00","manifest":"00"}]}'); };
    r.on('close', () => { sent = Math.min(sent, sent); }); pump();
  });
  try {
    const t0 = Date.now();
    await base(`http://127.0.0.1:${s.address().port}`, () => { decoded++; throw new Error('x'); }).seatCatalog().catch(() => null);
    await new Promise((ok) => setTimeout(ok, 300));
    console.log(`read stopped after ${Math.round(sent / 1048576)} MB sent, ${Date.now() - t0} ms, ${decoded} decoded`);
    assert.equal(decoded, 0);
    assert.ok(sent < 64 * 1048576, `the seat kept streaming: ${Math.round(sent / 1048576)} MB`);
  } finally { s.closeAllConnections?.(); s.close(); }
});
