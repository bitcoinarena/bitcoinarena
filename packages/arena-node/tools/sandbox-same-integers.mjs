// SAME INTEGERS IN THE SANDBOX (kanban #328, spec §0A.6): the stored runs of a seat's store replayed by a tree's replay
// worker, one line of JSON per run - its core, outcome, score, state hash and the worker's clock. Run once with today's
// tree and once with the sandbox's, and the two files are compared run for run.
//
//   node tools/sandbox-same-integers.mjs --tree <checkout> --db <store> [--per-core N] > out.jsonl
//
// The store is opened read-only; the replay is the production path - replayInWorker with the run named by its store,
// so the worker reads the transcript itself - under the core the round names, with the beacon the seat kept for it.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const tree = resolve(arg('--tree', '.'));
const dbPath = resolve(arg('--db'));
const perCore = Number(arg('--per-core', '25'));
/** --repeat N: each run replayed N times (the cost table: clock, p50, p95, min, max) */
const repeat = Number(arg('--repeat', '1'));
const at = (p) => pathToFileURL(`${tree}/packages/${p}`).href;
const { replayInWorker } = await import(at('arena-node/src/replay.js'));
const { hostedPlugins, pluginForRound } = await import(at('arena-node/src/plugins.js'));
const { GAME } = await import(at('nextblock/plugin/nextblock.js'));
const { decodeRoundContract, decodeEntryContract } = await import(at('arena-protocol/src/contracts.js'));
const { toHex } = await import(at('arena-protocol/src/hash.js'));

const plugins = hostedPlugins([GAME]);
const db = new DatabaseSync(dbPath, { readOnly: true });
const runs = db.prepare(`SELECT e.round_id, e.entry_id, e.contract AS entry, r.contract AS round, b.hash AS beacon,
  (SELECT COUNT(*) FROM ticks t WHERE t.round_id = e.round_id AND t.entry_id = e.entry_id) AS n
  FROM entries e JOIN rounds r ON r.round_id = e.round_id JOIN round_beacons b ON b.round_id = e.round_id ORDER BY e.joined_ms`).all();
const taken = new Map();
for (const row of runs) {
  if (!row.n) continue;
  // a round of an older layout this code does not read is not a run either tree can replay
  let contract; try { contract = decodeRoundContract(new Uint8Array(row.round)); } catch { continue; }
  const found = pluginForRound(contract, plugins);
  if (!found.ok || !found.core) continue;
  const coreHash = toHex(contract.simCoreHash);
  if ((taken.get(coreHash) || 0) >= perCore) continue;
  taken.set(coreHash, (taken.get(coreHash) || 0) + 1);
  const roundId = new Uint8Array(row.round_id);
  const core = { ...found.core, config: found.config, runTicks: found.runTicks,
    world: { configHash: contract.configHash, censusRoot: contract.censusRoot, roundId, sharedWorld: [...found.plugin.sharedWorld] } };
  const entry = decodeEntryContract(new Uint8Array(row.entry));
  for (let k = 0; k < repeat; k++) {
  const t0 = performance.now();
  const a = await replayInWorker(null, entry, { core, roundRandomness: new Uint8Array(row.beacon),
    source: { store: dbPath, roundId, entryId: new Uint8Array(row.entry_id) } });
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ round: toHex(roundId).slice(0, 16), entry: toHex(new Uint8Array(row.entry_id)).slice(0, 16), core: coreHash.slice(0, 8),
    ticks: row.n, ok: a.ok, why: a.why || null, outcome: a.outcome ?? null, score: a.score ?? null, stateHash: a.stateHash ?? null, ms: Math.round(ms), at: new Date().toISOString() }));
  }
}
