// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Audit faucet r3-1: the site Worker's chain read (src/website/chain-scan.js, every 2 min, /api/chain-nodes -> the home page's node list) lists
// the txs paying the public bond marker newest first and keeps at most 40 pages of 25 (1,000 txs, 41 fetches). The marker is a public P2TR script anyone can pay:
// a stranger's 1,100 dust payments to it (testnet4 coins) push every honest bond and advertisement update past the page cap - they drop out of
// the read (even though the previous read held them, proved and checked) and the home page shows "No bonded node found on Bitcoin testnet4".
// Safe: a bond the previous read held is not dropped because newer junk filled the listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanChain, MARKER_SCRIPTHASHES, SOURCE } from '../../../src/website/chain-scan.js';

const hex64 = (n) => n.toString(16).padStart(64, '0');
const HONEST = 'ab'.repeat(32);
function world(junkCount) {
  // newest first: the stranger's junk, then the honest bond (older)
  const list = [...Array.from({ length: junkCount }, (_, i) => hex64(i + 1)), HONEST]
    .map((txid) => ({ txid, status: { confirmed: true, block_hash: 'cd'.repeat(32), block_height: 157000 } }));
  const fetch = async (url) => {
    const u = String(url).slice(SOURCE.length);
    const ok = (b) => new Response(typeof b === 'string' ? b : JSON.stringify(b));
    if (u === '/blocks/tip/height') return ok('157100');
    let m = /^\/scripthash\/([0-9a-f]{64})\/txs$/.exec(u);
    if (m) return ok(m[1] === MARKER_SCRIPTHASHES.arena ? list.slice(0, 25) : []);
    m = /^\/scripthash\/([0-9a-f]{64})\/txs\/chain\/([0-9a-f]{64})$/.exec(u);
    if (m) { const i = list.findIndex((t) => t.txid === m[2]); return ok(m[1] === MARKER_SCRIPTHASHES.arena ? list.slice(i + 1, i + 26) : []); }
    if (/\/outspend\//.test(u)) return ok({ spent: false });
    return new Response('nope', { status: 404 });
  };
  // the previous read already held every one of them, read and proved (nothing to fetch again but the honest bond's outspend)
  const previous = { txs: list.map((s) => ({ txid: s.txid, marker: 'arena', hex: '00', height: 157000, pos: 1, merkle: [], header: '00'.repeat(80),
    bondVout: s.txid === HONEST ? 0 : null, outspends: s.txid === HONEST ? [false] : undefined })) };
  return { fetch, previous };
}

for (const [name, junk] of [['100 junk marker payments (control)', 100], ['1,100 junk marker payments', 1100]]) {
  test(`an honest bond the last read held stays in the chain read after ${name}`, async (t) => {
    const w = world(junk);
    t.mock.method(globalThis, 'fetch', w.fetch);
    const read = await scanChain(w.previous);
    const has = read.txs.some((x) => x.txid === HONEST);
    console.error(`  MEASURED (${name}): txs read ${read.txs.length}, fetches ${read.fetches}, partial ${read.partial}, honest bond kept: ${has}`);
    assert.ok(has, `the honest bond fell out of /api/chain-nodes after ${junk} stranger payments to the public marker`);
  });
}
