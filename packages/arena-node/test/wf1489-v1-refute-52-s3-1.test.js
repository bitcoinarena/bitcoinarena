// kanban #1540 refute (#1489 v1, skeptic 3, "second copies"): #1723 bounded the duty poster's read of the census seats' GET /games in
// duty-day.js (seatJson -> jsonUpTo), but the same file's other read of the same census seats - createDayDuty seatRounds, GET
// /rounds?next=1&ahead=50h, run on every look() through seatsAnswered() - still does `await r.json()` with no byte bound. One census
// seat answering 120 MB grows the poster's heap (the seat's own process) the way #1540/#1723 measured for /games.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { dutyOrder, dayStartMs } from '../../arena-protocol/src/duty.js';
import { createDayDuty } from '../src/duty-day.js';

const H = 3600000, MIN = 60000, DAY = 20753, T0 = dayStartMs(DAY);
const KEYS = [1, 2, 3, 4, 5].map((n) => new Uint8Array(32).fill(n));
const ORDER = dutyOrder({ networkId: NETWORK_ID_TESTNET4, slot: DAY, nodeKeys: KEYS });
const GID = 'c4'.repeat(32), DEV = 'ab'.repeat(32);
const header = (timeS, n) => { const h = new Uint8Array(80); h[0] = n & 0xff; h[1] = (n >> 8) & 0xff; new DataView(h.buffer).setUint32(68, timeS, true); return h; };

test('#1489-v1-refute-52-s3-1: the duty poster\'s read of a census seat\'s GET /rounds is bounded like its GET /games', async () => {
  const ENTRY = '{"game":{"id":"00"},"startTime":"x"},';
  const COUNT = 3_000_000;                                 // ~110 MB
  let asked = 0;
  const evil = createServer((q, r) => {
    if (!q.url.startsWith('/rounds')) { r.writeHead(404); return r.end(); }
    asked++;
    r.writeHead(200, { 'content-type': 'application/json' });
    r.write('{"rounds":[');
    let i = 0; const chunk = ENTRY.repeat(10000);
    const pump = () => { while (i < COUNT) { i += 10000; if (!r.write(chunk)) return r.once('drain', pump); } r.end('{"game":{"id":"00"}}]}'); };
    pump();
  });
  await new Promise((ok) => evil.listen(0, '127.0.0.1', ok));
  const E = `http://127.0.0.1:${evil.address().port}`;
  let peak = 0, parsed = 0;
  const base = process.memoryUsage().heapUsed;
  // the node's own fetch, watched: the heap right after an answer is parsed, and how many rounds it parsed
  const watched = async (u, o) => { const r = await fetch(u, o); const json = r.json.bind(r);
    r.json = async () => { const v = await json(); peak = Math.max(peak, process.memoryUsage().heapUsed - base); parsed = Math.max(parsed, Array.isArray(v && v.rounds) ? v.rounds.length : 0); return v; }; return r; };
  const nowMs = T0 + 10 * MIN, firstHeight = 1000, blocks = [];
  for (let t = T0 - 40 * H, i = 0; t <= nowMs; t += 10 * MIN, i++) blocks.push({ header: header(Math.floor(t / 1000), i), transactions: [], t });
  const tip = firstHeight + blocks.length - 1;
  try {
    const duty = createDayDuty({
      game: 'nextblock', item: 'nextblock-day', role: 'primary', postedPrimary: async () => false, networkId: NETWORK_ID_TESTNET4, local: new Set(),
      dir: mkdtempSync(join(tmpdir(), 'wf1489-s3-')), dry: true, gridDry: true,
      chain: { view: async () => ({ blocks, firstHeight }), censusKeysAt: async () => KEYS, seatUrls: async () => [E] },
      chainCall: async (m) => { if (m === 'getrawmempool') return []; if (m === 'getblockhash') return 'h'; if (m === 'getblockcount') return tip; throw new Error(`no ${m}`); },
      walletRpc: async () => { throw new Error('not the wallet\'s'); },
      gridBase: async () => ({ ok: false, why: 'test' }), openGrid: async () => ({ ok: false }),
      postSeries: async () => ({ took: 0, of: 0, refused: [] }), fedsNow: async () => [],
      seatCatalog: async () => new Map([[GID, { id: GID, name: 'nextblock', version: 24, dev: DEV }]]), devOf: { nextblock: DEV },
      fetchFn: watched, canPay: async () => ({ ok: false, why: 'test' }), now: () => nowMs, say: () => {},
    });
    void ORDER; void fromHex;
    await duty.look();
    const mb = Math.round(peak / 1048576);
    console.log(`asked ${asked}; the duty poster's heap grew ${mb} MB on one census seat's /rounds, ${parsed} rounds parsed`);
    assert.ok(asked > 0, 'the poster asked the census seat its rounds');
    assert.ok(mb < 64 && parsed < 100000, `one census seat's /rounds answer took ${mb} MB of the reading node's heap in the duty poster, ${parsed} rounds parsed`);
  } finally { evil.closeAllConnections?.(); evil.close(); }
});
