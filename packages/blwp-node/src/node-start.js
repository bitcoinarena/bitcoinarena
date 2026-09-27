// A NODE STARTS, AND RUNS A GUARDIAN ONLY IF IT HOLDS A GUARDIAN KEY (spec §23A.2, one node is one guardian; the owner
// 2026-09-27: "a launcher-started node runs a guardian only when it is one of the four testnet nodes that already hold
// a guardian key ... Starting a node is not enough. Holding that node's guardian key is the test").
//
// The key is what a completed key ceremony leaves beside the node's store: <store>.guardian/private.json (this
// guardian's own keys) and <store>.guardian/consensus.json (the federation it guards). Both there and both parse: the
// node starts its guardian (guardian.js, everything derived) and serves with it; its GET /guardian then says so. Either
// missing: no guardian is started and no directory is made - the node answers {guardian: false}. main.js and the
// launcher start every node through here, so whether a node is a guardian is decided by the node, never by a launcher.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from './server.js';
import { startGuardian } from './guardian.js';

/** Whether the node on this store holds a guardian key: both ceremony files beside it, both parsing. */
export function holdsGuardianKey(storePath) {
  if (!storePath || storePath === ':memory:') return false;
  const dir = `${storePath}.guardian`;
  try {
    JSON.parse(readFileSync(join(dir, 'private.json'), 'utf8'));
    JSON.parse(readFileSync(join(dir, 'consensus.json'), 'utf8'));
    return true;
  } catch { return false; }
}

/**
 * Start one node on its store: its guardian first when it holds a key, then the node, served with that guardian.
 * `store` is `{ db, path }`; `options` are serve()'s; `chain` is what the guardian reads the chain with -
 * `{ bitcoindUrl, cookiePath, call, env, tailscale, log }`, the node's own settings. The returned node's close() stops
 * both.
 */
export async function startNode({ db, path }, options = {}, chain = {}) {
  let guardian = { running: false, stop: async () => {} };
  if (holdsGuardianKey(path)) {
    guardian = await startGuardian({ nodePort: options.port, host: options.host || '127.0.0.1', storePath: path,
      bitcoindUrl: chain.bitcoindUrl, cookiePath: chain.cookiePath, call: chain.call,
      ...(chain.env ? { env: chain.env } : {}), ...(chain.tailscale !== undefined ? { tailscale: chain.tailscale } : {}),
      ...(chain.log ? { log: chain.log } : {}) });
  }
  let node;
  try {
    node = await serve(db, guardian.running
      ? { ...options, guardian: { apiPort: guardian.apiPort, endpoint: guardian.endpoint } } : options);
  } catch (e) { await guardian.stop(); throw e; }
  const closeNode = node.close;
  node.close = async () => { try { await closeNode(); } finally { await guardian.stop(); } };
  node.guardianRunning = guardian.running;
  return node;
}
