// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SKEW CASE OF KANBAN #1034, REDONE ON THE DRAW (#1039): how much bonded capital reaches the threshold of a census key. No curve: shares are all this reads.
//
//   node packages/arena-node/tools/census-draw-measure.mjs --nodes 1000 --top 100 --draws 2000
//
// A census of Zipf bonds, weight max(1, floor(top / rank)) x 100,000 sat, past the cap, drawn on a fresh block hash each time. Three coalitions:
//   fixed    the largest nodes, chosen before the draw: the capital where 683 of 1024 becomes a coin toss
//   chosen   nodes picked after the draw, most shares per sat first: what bribing the lucky holders of one key costs. A key's shares are public from h on
//   fewest   the same with the fewest nodes, largest holders first
import { randomBytes } from 'node:crypto';
import { censusKeyShares } from '../../arena-protocol/src/census-key.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const at = args.indexOf(`--${name}`); return at < 0 ? fallback : Number(args[at + 1]); };
const count = opt('nodes', 1000), top = opt('top', 100), draws = opt('draws', 2000), S = opt('shares-max', 1024);
const say = (line) => console.log(`#1039 ${line}`);
const nodes = Array.from({ length: count }, (_, i) => ({ pubkey: randomBytes(32), bondSats: BigInt(Math.max(1, Math.floor(top / (i + 1)))) * 100000n, txid: randomBytes(32), vout: 0 }));
const hexOf = (b) => b.toString('hex');
const sats = new Map(nodes.map((n) => [hexOf(n.pubkey), Number(n.bondSats)]));
const T = [...sats.values()].reduce((a, b) => a + b, 0);
const byBond = [...nodes].map((n) => hexOf(n.pubkey));

const stats = (list) => { const s = [...list].sort((a, b) => a - b); return { min: s[0], median: s[s.length >> 1], max: s[s.length - 1] }; };
const pct = (v) => `${(100 * v).toFixed(1)} %`;
const fixedAt = []; const chosen = []; const fewestNodes = []; const fewestCapital = []; const holdersN = [];
let threshold = 0;
for (let d = 0; d < draws; d++) {
  const r = censusKeyShares({ entries: nodes, network: 'regtest', blockHash: new Uint8Array(randomBytes(32)), sharesMax: S });
  if (!r.drawn) throw new Error('that census is exact: raise --top or --nodes');
  threshold = r.threshold;
  holdersN.push(r.holders.length);
  const held = new Map(r.holders.map((h) => [h.key, h.shares]));
  let have = 0, cap = 0;
  for (const k of byBond) { have += held.get(k) || 0; cap += sats.get(k); if (have >= threshold) break; }
  fixedAt.push(cap / T);
  have = 0; cap = 0;
  for (const h of [...r.holders].sort((a, b) => b.shares / sats.get(b.key) - a.shares / sats.get(a.key))) { have += h.shares; cap += sats.get(h.key); if (have >= threshold) break; }
  chosen.push(cap / T);
  have = 0; cap = 0; let n = 0;
  for (const h of [...r.holders].sort((a, b) => b.shares - a.shares)) { have += h.shares; cap += sats.get(h.key); n += 1; if (have >= threshold) break; }
  fewestNodes.push(n); fewestCapital.push(cap / T);
}
const line = (name, list) => { const s = stats(list); say(`${name}: min ${pct(s.min)}, median ${pct(s.median)}, max ${pct(s.max)} of the bonded capital`); };
say(`census: ${count} nodes, ${T} sat, top bond ${pct(Number(nodes[0].bondSats) / T)}; ${draws} draws of ${S} shares, threshold ${threshold}; ${stats(holdersN).median} nodes hold shares (median)`);
line('fixed coalition, largest nodes first', fixedAt);
line('chosen after the draw, most shares per sat', chosen);
line('fewest nodes, largest holders first', fewestCapital);
{ const s = stats(fewestNodes); say(`fewest nodes reaching the threshold: min ${s.min}, median ${s.median}, max ${s.max}`); }

/** The chance capital share p draws the threshold of S, exact binomial, in logs. */
const logFact = (() => { const f = [0]; for (let i = 1; i <= S; i++) f.push(f[i - 1] + Math.log(i)); return f; })();
const tail = (p) => { let sum = 0; for (let k = threshold; k <= S; k++) sum += Math.exp(logFact[S] - logFact[k] - logFact[S - k] + k * Math.log(p) + (S - k) * Math.log(1 - p)); return sum; };
const tail10 = (p) => { let best = -Infinity; for (let k = threshold; k <= S; k++) best = Math.max(best, (logFact[S] - logFact[k] - logFact[S - k] + k * Math.log(p) + (S - k) * Math.log(1 - p)) / Math.LN10); return best; };
for (const p of [0.2, 0.5, 0.55, 0.6, 0.62, 0.65]) say(`chance capital ${pct(p)} draws ${threshold} of ${S}: ${tail(p) > 1e-300 ? tail(p).toExponential(1) : `about 1e${tail10(p).toFixed(0)}`}`);
