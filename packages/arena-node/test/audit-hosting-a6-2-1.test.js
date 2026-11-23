// kanban #3358: the card's test (audit hosting a6-2-1); the flip also reads Uint8Array.prototype.toHex (V8 13.8+, Node 25), so a host whose
// default Node is 25 shows the split without Node 26; RELEASE_NODE defaults to an nvm install of 24.22.3
// Audit (hosting, round 2, finding 1): a decide adapter can answer by the seat's Node build. The sandbox keeps the language's
// globals, but which methods those globals carry is the running Node's (V8's) own - Iterator.concat, Map.prototype.getOrInsert,
// Uint8Array.prototype.toHex are there on Node 26 (V8 14.6) and not on the release's pinned Node 24.22.3 (V8 13.6) - so one adapter
// decides the same reveals one way on an installer seat and the other way on a seat run from a checkout on a newer Node.
// SAFE BEHAVIOUR: the same adapter on the same moves answers the same verdict on every seat, whatever Node build the seat runs
// (or the seat does not decide on a runtime other than the pinned one).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCore } from '../src/core-sandbox.js';
import { trialRun } from '../src/plugin-trial.js';
import { scanSource } from '../src/plugin-check.js';
import { RESULT_TYPE } from '../../arena-protocol/src/manifest.js';

// the runtime tools/release/build-release.sh bundles (NODE_VER=24.22.3) - every installer seat runs it
const RELEASE_NODE = process.env.RELEASE_NODE || `${process.env.HOME}/.nvm/versions/node/v24.22.3/bin/node` /* a Node 24.22.3 binary on the test machine */;

// higher move wins where the runtime has no Iterator.concat (V8 13.6, the release's Node); lower move wins where it has one (V8 14.x)
const ADAPTER = `export const DECIDE = { name: 'probe', decide(moves) {
  const flip = typeof Iterator.concat === 'function' || typeof Uint8Array.prototype.toHex === 'function';
  const out = {};
  const [a, b] = moves;
  if (a.move === b.move) { out[a.key] = 'DRAW'; out[b.key] = 'DRAW'; return out; }
  const aWins = flip ? a.move < b.move : a.move > b.move;
  out[a.key] = aWins ? 'WIN' : 'LOSS'; out[b.key] = aWins ? 'LOSS' : 'WIN';
  return out;
} };
`;
const MOVES = [{ key: 'aa'.repeat(32), move: 0 }, { key: 'bb'.repeat(32), move: 2 }];
const decideHere = () => {
  const box = loadCore({ files: new Map([['core.mjs', ADAPTER]]), entry: 'core.mjs' });
  try { return box.call('decide', { moves: MOVES, config: {} }); } finally { box.end(); }
};

test('the adapter passes the package scan and the plugin trial', () => {
  assert.deepEqual(scanSource(ADAPTER), [], 'the scan finds nothing in it');
  const t = trialRun(ADAPTER, { resultType: RESULT_TYPE.HEAD_TO_HEAD, players: 2, moveCount: 3 });
  assert.equal(t.ok, true, `the trial passes it: ${t.why}`);
});

test('one decide adapter, one set of reveals: the same verdict on a seat of the release Node and on a seat of this Node', () => {
  assert.ok(existsSync(RELEASE_NODE), `the release's Node ${RELEASE_NODE} is on this host`);
  const here = decideHere();
  const sandbox = new URL('../src/core-sandbox.js', import.meta.url).href;
  const script = `import { loadCore } from ${JSON.stringify(sandbox)};
const box = loadCore({ files: new Map([['core.mjs', ${JSON.stringify(ADAPTER)}]]), entry: 'core.mjs' });
process.stdout.write(JSON.stringify(box.call('decide', { moves: ${JSON.stringify(MOVES)}, config: {} }))); box.end(); process.exit(0);`;
  const out = execFileSync(RELEASE_NODE, ['--input-type=module', '-e', script], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 60000 });
  const release = JSON.parse(out);
  assert.deepEqual(here, release,
    `the seat on Node ${process.version} (V8 ${process.versions.v8}) signs ${JSON.stringify(here)}; a seat on the release's Node 24.22.3 signs ${JSON.stringify(release)}`);
});
