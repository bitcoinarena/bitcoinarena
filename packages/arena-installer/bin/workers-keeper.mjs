#!/usr/bin/env node
// THE WORKERS KEEPER'S SERVICE (kanban #471, workers.js): every 20 s the quick tunnel's name; a new one goes into the node's Worker on
// the operator's workers.dev at once, so its permanent address keeps answering. Lines in <home>/workers.log.
//
//     workers-keeper --home ~/.arena-node
import { resolve } from 'node:path';
import { nodeState, defaultHome } from '../src/state.js';
import { createWorkersKeeper } from '../src/workers.js';
import { quickTunnelUrl } from '../src/reach.js';
const args = process.argv.slice(2);
const i = args.indexOf('--home');
const home = resolve(i >= 0 ? args[i + 1] : defaultHome());
const keeper = createWorkersKeeper({ state: nodeState(home), tunnelUrl: () => quickTunnelUrl({ home, waitMs: 3000 }) });
let last = '';
const run = async () => {
  let r; try { r = await keeper.tick(); } catch (e) { r = { ok: false, why: e.message }; }
  const line = r.did ? `forwards to ${r.target}` : r.idle || r.why;
  if (line !== last) { console.log(`${new Date().toISOString()} ${line}`); last = line; }
};
await run();
setInterval(run, 20000);
