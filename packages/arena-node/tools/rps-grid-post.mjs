#!/usr/bin/env node
/**
 * POST A PUBLISHED GRID'S ROUNDS FROM ITS FILE (kanban #344): the contracts the keeper saved at publication
 * (paid/rps-grid-<txid>.json), each round still at least LEAD_MS from its start, to every seat - a few at a time, a
 * dropped connection or a seat still reading its chain view asked again (measured 19:57Z: one "fetch failed" from a seat
 * under load stopped the keeper's own posting of grid aac10bf8 after its beacon came 6 deep). Each round is named in the
 * funded-rounds file first, as the keeper names it. The seats check the publication and the beacon themselves.
 *
 *   GRID=<file> PORTS=<seat ports> FUNDED=<funded-rounds file> [LEAD_MS=190000] [BATCH=3] node tools/rps-grid-post.mjs
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { decodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const env = process.env;
const log = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const grid = JSON.parse(readFileSync(env.GRID, 'utf8'));
const nodes = env.PORTS.split(',').map((p) => `http://127.0.0.1:${p.trim()}`);
const lead = Number(env.LEAD_MS || 190000), batch = Number(env.BATCH || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function postTo(node, bytes) {
  let why = '';
  for (let t = 0; t < 20; t++) {
    try {
      const r = await fetch(`${node}/round`, { method: 'POST', body: bytes, signal: AbortSignal.timeout(30000) });
      if (r.ok) return { ok: true };
      why = await r.text();
      if (!/no chain view|view .*pending|no beacon|no publication transaction|still reading/i.test(why)) return { ok: false, why: why.slice(0, 160) };
    } catch (e) { why = e.message; }
    await sleep(3000);
  }
  return { ok: false, why: why.slice(0, 160) };
}
const all = grid.contracts.map((h) => { const bytes = Buffer.from(h, 'hex'); const c = decodeRoundContract(new Uint8Array(bytes)); return { bytes, c, id: toHex(roundId(c)) }; });
let posted = 0, skipped = 0, refused = 0, first = null;
for (let i = 0; i < all.length; i += batch) {
  const now = Date.now();
  const due = all.slice(i, i + batch).filter((x) => Number(x.c.startTimeMs) - now >= lead);
  skipped += Math.min(batch, all.length - i) - due.length;
  for (const x of due) appendFileSync(env.FUNDED, `${x.id}\n`);
  const said = await Promise.all(due.map(async (x) => ({ x, per: await Promise.all(nodes.map((n) => postTo(n, x.bytes))) })));
  for (const { x, per } of said) {
    if (per.every((p) => p.ok)) { posted++; if (!first) { first = x; log({ step: 'first posted', round: x.id.slice(0, 16), start: new Date(Number(x.c.startTimeMs)).toISOString(), entryClose: new Date(Number(x.c.entryCloseMs)).toISOString() }); } }
    else { refused++; if (refused <= 5) log({ step: 'refused', round: x.id.slice(0, 16), why: per.filter((p) => !p.ok).map((p) => p.why) }); }
  }
  if (i % 60 === 0) log({ step: 'progress', at: i, of: all.length, posted, skipped, refused });
  // PACED (measured 20:09Z: 63 rounds posted back to back held every seat's loop 5-29 s and the seating of the next rounds
  // missed its window); PAUSE_MS between batches keeps the seats answering
  if (due.length && env.PAUSE_MS) await sleep(Number(env.PAUSE_MS));
}
log({ step: 'done', posted, skipped, refused, of: all.length });
