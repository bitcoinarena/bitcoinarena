// A NODE'S ADVERT SAYS WHETHER IT IS A GUARDIAN, AND THE LAUNCHER TAKES THAT ONLY FROM THE RUNNING NODE'S HTTP
// GET /guardian (spec §5A.1 v4.6.4, §23A.2 one node is one guardian - RULED the owner 2026-09-26 22:54; the slice accepted
// 2026-09-27: "taken only from the running node's HTTP GET /guardian"). Nothing an operator types sets either field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore, nodeIdentity } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeAdvert, decodeAdvert, advertId } from '../../protocol/src/advert.js';
import { standUpRound, guardianFieldsFromNode } from '../tools/round-2of2.mjs';

const b32 = (n) => new Uint8Array(32).fill(n);
const freePort = () => new Promise((resolve) => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const getGuardian = async (url) => (await fetch(`${url}/guardian`)).json();

test("a guardian node's advert carries exactly what its GET /guardian answers, under the node's own signature", async () => {
  const db = openStore(':memory:');
  const endpoint = 'wss://seat.example.com/guardian-1/guardian';
  const node = await serve(db, { port: 0, guardian: { apiPort: 1, endpoint } });
  try {
    const url = `http://127.0.0.1:${node.port}`;
    const body = await getGuardian(url);
    assert.deepEqual(body, { guardian: true, endpoint });
    const fields = await guardianFieldsFromNode(url);
    assert.deepEqual(fields, { guardianCapable: true, guardianEndpoint: body.endpoint }, 'the fields are the HTTP body and nothing else');
    const id = nodeIdentity(db);
    const advert = { nodePubkey: id.pubkey, operatorId: '2of2', protocolVersions: [1], roles: ['game', 'settlement', 'verify'],
      endpoint: 'wss://seat.example.com/guardian-1', region: 'eu-west', capacityClass: 2, softwareHash: b32(3),
      settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 1,
      payoutPubkey: b32(4), guardianOf: [], ...fields, timestamp: 1788700000000n };
    const signature = schnorr.sign(advertId(advert), id.secret);
    const back = decodeAdvert(encodeAdvert(advert));
    assert.equal(back.guardianCapable, true);
    assert.equal(back.guardianEndpoint, endpoint);
    assert.ok(schnorr.verify(signature, advertId(back), id.pubkey), "the decoded advert verifies under the node's key");
  } finally { await node.close(); }
});

test("round-2of2's own nodes are not guardians: their GET /guardian says so and their adverts say guardian_capable 0", async () => {
  const [portA, portB] = [await freePort(), await freePort()];
  const r = await standUpRound({ portA, portB, store: ':memory:' });
  try {
    for (const d of r.daemons) assert.deepEqual(await getGuardian(`http://127.0.0.1:${d.port}`), { guardian: false });
    assert.equal(r.adverts.length, 2, 'the launcher hands back the adverts it bonded');
    for (const a of r.adverts) {
      assert.equal(a.guardianCapable, false);
      assert.equal(a.guardianEndpoint, '');
    }
  } finally { for (const d of r.daemons) await d.close(); }
});

// Each start in its own process, as the Daily restarts: two starts in one process share its fetch pool, which reuses
// sockets to the first start's closed daemons ("other side closed" - measured on the commit before this slice too).
test('a second start on the same store still holds the rounds the first one opened, and bonds and opens its own', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'launcher-reuse-'));
  const [portA, portB] = [await freePort(), await freePort()];
  const tool = new URL('../tools/round-2of2.mjs', import.meta.url).href;
  const start = (then) => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', `
    const { standUpRound } = await import(${JSON.stringify(tool)});
    const r = await standUpRound({ portA: ${portA}, portB: ${portB}, store: ${JSON.stringify(dir)} });
    const out = { rounds: r.rounds().map((x) => x.id), adverts: r.adverts.length, ports: r.daemons.map((d) => d.port) };
    ${then}
    for (const d of r.daemons) await d.close();
    console.log('RESULT ' + JSON.stringify(out)); process.exit(0);`], { timeout: 90000 },
  (e, stdout) => { const line = String(stdout).split('\n').find((l) => l.startsWith('RESULT '));
    return line ? resolve(JSON.parse(line.slice(7))) : reject(e || new Error('no result: ' + stdout)); }));
  try {
    const first = await start('');
    assert.ok(first.rounds.length >= 1, 'the first start opened a round');
    const second = await start('');
    const statuses = [];
    // the second start's own view of the first start's rounds, asked from a third process after it
    const probe = await start(`out.statuses = [];
      for (const id of ${JSON.stringify(first.rounds)})
        for (const d of r.daemons) out.statuses.push((await fetch('http://127.0.0.1:' + d.port + '/round?id=' + id)).status);`);
    statuses.push(...probe.statuses);
    assert.ok(statuses.length >= 2 && statuses.every((c) => c === 200), `the first start's rounds are still held: ${statuses}`);
    assert.equal(second.adverts, 2);
    assert.ok(second.rounds.length >= 1, 'the second start opened its own round after its census');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
