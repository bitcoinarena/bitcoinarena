// SAME INTEGERS, EVERY CORE VERSION (kanban #328, spec §0A.6): one fixed set of runs per core a node holds - nextblock's
// current core, the three frozen ones and the pre-fork name, and the two test cores (counter, tally) - replayed by a tree's
// replay worker, one line of JSON per run. Run once with today's tree and once with the sandbox's; compare run for run.
//
//   node tools/sandbox-same-runs.mjs --tree <checkout> [--long] > out.jsonl
//
// The runs are scripted (seeds, drives, a load, liquidations, price samples) and the same for both trees.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const tree = resolve(arg('--tree', '.'));
const at = (p) => pathToFileURL(`${tree}/packages/${p}`).href;
const { replayInWorker } = await import(at('arena-node/src/replay.js'));
const { NEXTBLOCK_CORES } = await import(at('nextblock/plugin/truck-cores.js'));
const { COUNTER } = await import(at('arena-node/test/cores/counter.js'));
const { TALLY_CORE } = await import(at('arena-node/test/plugins/tally/index.js'));

/** A drive: throttle, steer, brake, handbrake, practice - integers, the same on every machine. */
const drive = (kind, t) => {
  if (kind === 0) return [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0];
  if (kind === 1) return [65536, (t % 400) < 200 ? 20000 : -20000, 0, (t % 1500) < 10 ? 65536 : 0, 0];
  if (kind === 2) return [(t * 131) % 65537, ((t * 7919) % 65536) - 32768, (t % 97) < 9 ? 65536 : 0, 0, 0];
  return [t % 2 ? 65536 : 0, 0, 0, 0, 0];
};
const RUNS = [
  { seed: 1, kind: 0, ticks: 1200 },
  { seed: 2, kind: 1, ticks: 1800, loads: [[0, 17314, 42]] },
  { seed: 3, kind: 2, ticks: 2400, liquidations: [[300, 5], [900, 12]] },
  { seed: 4, kind: 0, ticks: 3000, loads: [[0, 9000, 21, 30000]], samples: [[300, 6100000], [600, 6120000], [900, 6080000]] },
  { seed: 5, kind: 3, ticks: 600 },
  { seed: 0x7fffffff, kind: 1, ticks: 900, liquidations: [[100, 3]] },
];
if (process.argv.includes('--long')) RUNS.push({ seed: 6, kind: 0, ticks: 10800, loads: [[0, 17314, 42]] });

const cores = [...NEXTBLOCK_CORES.values()].map((c) => ({ label: c.hash.slice(0, 8), core: c, configs: [[...c.configs.values()][0] || {}] }));
cores.push({ label: 'counter', core: COUNTER, configs: [...COUNTER.configs.values()] });
cores.push({ label: 'tally', core: TALLY_CORE, configs: [{}] });

for (const { label, core, configs } of cores) {
  for (const config of configs) {
    for (const r of RUNS) {
      const runTicks = core.fixedRunTicks || (label === 'counter' ? config.ticks : label === 'tally' ? 600 : 10800);
      const n = Math.min(r.ticks, runTicks);
      const transcript = { ticks: Array.from({ length: n }, (_, t) => ({ tick: t, words: drive(r.kind, t) })),
        liquidations: r.liquidations || [], loads: r.loads || [], samples: r.samples || [], tapes: [] };
      const c = { ...core, config, runTicks };
      // the before-fork name carries its own hash; its files are 2069b4c2's (the sandbox checks them against that)
      const t0 = performance.now();
      const a = await replayInWorker(transcript, { joinTick: 0 }, { core: c, seedWord: r.seed, marks: [], pictures: [Math.min(500, n - 1)] });
      console.log(JSON.stringify({ core: label, config: JSON.stringify(config), seed: r.seed, ticks: n, ok: a.ok, why: a.why || null,
        outcome: a.outcome ?? null, score: a.score ?? null, heat: a.heat ?? null, stateHash: a.stateHash ?? null,
        picture: a.pictures ? a.pictures[0] || null : null, ms: Math.round(performance.now() - t0) }));
    }
  }
}
