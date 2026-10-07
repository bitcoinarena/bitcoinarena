// A NODE RUNS A GUARDIAN ONLY IF IT HOLDS A GUARDIAN KEY (spec §23A.2; the owner 2026-09-27: "Starting a node is not
// enough. Holding that node's guardian key is the test"). The key is <store>.guardian/private.json and consensus.json,
// what a completed ceremony leaves. A launcher starts nodes only; a node that holds a key starts its own guardian and
// says so on GET /guardian, and a node that does not starts none, makes no directory, and is advertised as none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startNode, holdsGuardianKey } from '../src/node-start.js';
import { standUpRound } from '../tools/round-2of2.mjs';
import { NEXTBLOCK } from '../../core/plugin/nextblock.js';
// A LAUNCHER HANDS ITS NODES THE GAMES THEY HOST (kanban #202, §0A.4): nextblock, as src/main.js does.
const launchNode = (store, options, chain) => startNode(store, { plugins: [NEXTBLOCK], ...options }, chain);


// a port the guardian's own ports (node + 1000 .. + 4000) also fit after
const port = (from) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(port(from + 7)));
  s.listen(from, '127.0.0.1', () => s.close(() => resolve(from)));
});
const getGuardian = async (p) => (await fetch(`http://127.0.0.1:${p}/guardian`, { headers: { connection: 'close' } })).json();

// A STAND-IN fedimintd on the PATH, as guardian.test does: it notes that it was started, and waits to be stopped.
function standIn(dir) {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const started = join(dir, 'fedimintd-started');
  writeFileSync(join(bin, 'fedimintd'), `#!/bin/sh\necho "$FM_API_URL" >> ${started}\nexec sleep 60\n`);
  chmodSync(join(bin, 'fedimintd'), 0o755);
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const chain = { bitcoindUrl: 'http://127.0.0.1:48332', cookiePath: cookie, call: async () => ({ chain: 'testnet4' }),
    env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: null, log: () => {} };
  return { chain, started };
}
// A FOUNDED GUARDIAN'S DIRECTORY: the two files a completed ceremony writes
function founded(storePath) {
  mkdirSync(`${storePath}.guardian`, { recursive: true });
  writeFileSync(`${storePath}.guardian/private.json`, JSON.stringify({ broadcast_sk: 'x' }));
  writeFileSync(`${storePath}.guardian/consensus.json`, JSON.stringify({ broadcast_public_keys: {} }));
}

test('a launcher-started node that holds a guardian key starts its own guardian and is advertised as one; its peer without a key is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-'));
  const { chain, started } = standIn(dir);
  const store = join(dir, 'store'); mkdirSync(store);
  founded(join(store, 'a.db'));
  const [portA, portB] = [await port(22611), await port(22711)];
  const r = await standUpRound({ portA, portB, store, guardianChain: chain });
  try {
    const endpoint = `ws://127.0.0.1:${portA}/guardian`;
    assert.deepEqual(await getGuardian(portA), { guardian: true, endpoint }, 'node A holds a key: its GET /guardian says so');
    assert.deepEqual(await getGuardian(portB), { guardian: false }, 'node B holds none');
    assert.deepEqual([r.adverts[0].guardianCapable, r.adverts[0].guardianEndpoint], [true, endpoint], "A's advert is its own answer");
    assert.deepEqual([r.adverts[1].guardianCapable, r.adverts[1].guardianEndpoint], [false, ''], "B's advert says not a guardian");
    assert.equal(existsSync(join(store, 'b.db.guardian')), false, 'no guardian directory is made for a node without a key');
    assert.ok(existsSync(started), 'A started its fedimintd');
  } finally { for (const d of r.daemons) await d.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a node with no key, or a guardian directory without private.json, starts no fedimintd, makes no directory, and answers {guardian: false}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-none-'));
  const { chain, started } = standIn(dir);
  try {
    const bare = join(dir, 'bare.db');
    assert.equal(holdsGuardianKey(bare), false);
    const p1 = await port(22811);
    const n1 = await launchNode({ db: openStore(bare), path: bare }, { port: p1 }, chain);
    try {
      assert.deepEqual(await getGuardian(p1), { guardian: false });
      assert.equal(existsSync(`${bare}.guardian`), false, 'no directory is made');
    } finally { await n1.close(); }

    const half = join(dir, 'half.db');
    mkdirSync(`${half}.guardian`);
    writeFileSync(`${half}.guardian/consensus.json`, '{}');   // a setup left behind, no private.json: no key
    assert.equal(holdsGuardianKey(half), false);
    const p2 = await port(22911);
    const n2 = await launchNode({ db: openStore(half), path: half }, { port: p2 }, chain);
    try { assert.deepEqual(await getGuardian(p2), { guardian: false }); } finally { await n2.close(); }

    assert.equal(existsSync(started), false, 'no fedimintd was started for a node without a key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
