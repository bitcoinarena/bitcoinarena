#!/usr/bin/env node
// THE CUSTODY AGENT'S SERVICE (kanban #471 slice 5 part 4, custody-agent.js): one tick a minute, its lines in <home>/custody.log.
//
//     custody-agent --home ~/.arena-node
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { nodeState, defaultHome } from '../src/state.js';
import { createCustodyAgent } from '../src/custody-agent.js';
const args = process.argv.slice(2);
const i = args.indexOf('--home');
const home = resolve(i >= 0 ? args[i + 1] : defaultHome());
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const agent = createCustodyAgent({ state: nodeState(home), release, log: (l) => console.log(`${new Date().toISOString()} ${l}`) });
let last = '';
const run = async () => {
  let r; try { r = await agent.tick(); } catch (e) { r = { ok: false, why: e.message }; }
  const line = r.did ? `did ${r.did} ${r.txid || ''}` : r.idle || r.why;
  if (line !== last) { console.log(`${new Date().toISOString()} ${line}`); last = line; }
};
await run();
setInterval(run, 60000);
