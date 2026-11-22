// kanban #2990 (audit 2026-11-18 hosting r2-1): ONE RELAYING SEAT MAKES AN AUTO-UPDATING SEAT REFUSE A GENUINE UPDATE FOR 24 H.
// autoUpdateSweep (server.js) keeps a trial refusal (`r.trial`) as the verdict on the game id for TRIAL_REFUSED_MS (24 h), on the
// promise (kanban #1880/#1913) that "the trial runs only bytes checked against [the id] ... no seat can make this one refuse another
// seat's genuine copy". But verifyPackage hands the trial the package's cores[].name (plugin-package.js: `name: c.name || ...`),
// which nobody signs and checkPackage never types: a relaying seat that serves the developer's genuine package with
// cores[0].name = {"toString":1} (or a deeply nested array) makes loadCore throw ("Cannot convert object to primitive value" /
// "Maximum call stack size exceeded"), the trial answers a plain refusal (no `retry`), and the seat files the GENUINE version as
// refused by its trial - every later source holding the same bytes is skipped (refusedByTrial) for 24 h.
// SAFE: the unsigned core name cannot turn a genuine version into a trial refusal; the honest source's copy is taken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { verifyPackage } from '../src/plugin-package.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { testDevKey, testDonationSet } from './plugins/sign.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'audit-hosting-r2-1-'));
const ticSource = (tag) => `export const DECIDE = { name: 'tic ${tag}', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move));
  const winners = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = winners === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
function ticGame({ version, parent = NO_PARENT, tag = 'v' + version }) {
  const src = ticSource(tag), file = join(srcDir, `decide-${tag}.mjs`);
  writeFileSync(file, src);
  const hash = sha(Buffer.from(src)), cfg = '22'.repeat(32);
  const set = testDonationSet('tic');
  const key = testDevKey('tic dev');
  const manifest = signManifest({ gameName: 'tic', gameDevPubkey: key.pubkey, version, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'tic', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [],
    cores: new Map([[hash, { name: `tic ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}

test('r2-1a: the unsigned cores[].name turns the developer\'s genuine package into a trial refusal (kept as a verdict)', async () => {
  const v1 = ticGame({ version: 1 });
  const v2 = ticGame({ version: 2, parent: v1.gameId });
  const c = await serve(openStore(), { plugins: [{ ...v2, ancestors: [v1.manifest] }], port: 0 });
  try {
    const pkg = await (await fetch(`http://127.0.0.1:${c.port}/plugin?game=${toHex(v2.gameId)}`)).json();
    const honest = verifyPackage(pkg, { verify: verifyEd25519, want: toHex(v2.gameId) });
    assert.equal(honest.ok, true, honest.why);
    const relayed = { ...pkg, cores: pkg.cores.map((x) => ({ ...x, name: { toString: 1 } })) };
    const v = verifyPackage(relayed, { verify: verifyEd25519, want: toHex(v2.gameId) });
    console.log('  FACTS:', JSON.stringify({ honestOk: honest.ok, relayedOk: v.ok, relayedTrial: v.trial, relayedRetry: v.retry, why: v.why }));
    // the bytes are the genuine signed ones: a field nobody signed must not make them a trial refusal kept for the game id
    assert.ok(v.ok || !v.trial, `a relaying seat's core name made the genuine version a trial verdict: ${v.why}`);
  } finally { await c.close(); }
});

test('r2-1b: one relaying seat listed first makes the auto-updating seat skip the honest source\'s genuine update', async () => {
  const v1 = ticGame({ version: 1, tag: 'b1' });
  const v2 = ticGame({ version: 2, parent: v1.gameId, tag: 'b2' });
  const id2 = toHex(v2.gameId);
  // C: an honest seat hosting v2 (with v1 as its ancestor), as any seat that took the update does
  const c = await serve(openStore(), { plugins: [{ ...v2, ancestors: [v1.manifest] }], port: 0 });
  const C = `http://127.0.0.1:${c.port}`;
  // R: a relaying seat - lists exactly what C lists, hands over C's genuine package with one unsigned field changed
  const r = createServer(async (req, res) => {
    try {
      const got = await fetch(C + req.url);
      if (req.url.startsWith('/plugin')) {
        const pkg = await got.json();
        res.writeHead(got.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ...pkg, cores: pkg.cores.map((x) => ({ ...x, name: { toString: 1 } })) }));
      }
      res.writeHead(got.status, { 'content-type': got.headers.get('content-type') || 'application/json' });
      res.end(Buffer.from(await got.arrayBuffer()));
    } catch (e) { res.writeHead(502); res.end(String(e.message)); }
  });
  await new Promise((ok) => r.listen(0, '127.0.0.1', ok));
  const R = `http://127.0.0.1:${r.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'audit-hosting-r2-1b-'));
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const rec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  process.env.ARENA_AUTO_UPDATE_MS = '300';
  const b = await serve(openStore(), { plugins: [v1], port: 0, pluginsDir: dir, owner: { store: { read: () => rec, write: (o) => Object.assign(rec, o), writeCode: () => {} } } });
  delete process.env.ARENA_AUTO_UPDATE_MS;
  try {
    const B = `http://127.0.0.1:${b.port}`;
    const node = (await (await fetch(`${B}/owner`)).json()).node;
    const req = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = async (path, body) => { const x = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [x.status, await x.json()]; };
    const games = async () => (await (await fetch(`${B}/games`)).json()).games.map((g) => g.id);
    // the network's seats as sources: the relaying one happens to come first, the honest one holds the same genuine version
    const [st] = await post('/owner/settings', req('settings', { autoUpdate: true, sources: [R, C] }));
    assert.equal(st, 200);
    let seen = [];
    for (let i = 0; i < 40 && !seen.includes(id2); i++) { await new Promise((ok) => setTimeout(ok, 100)); seen = await games(); }
    console.log('  FACTS:', JSON.stringify({ hostedAfter4s: seen.map((g) => g.slice(0, 16)), v2: id2.slice(0, 16) }));
    assert.ok(seen.includes(id2), `the genuine v2 ${id2.slice(0, 16)} that the honest source C holds was never taken: one relaying seat's unsigned core name filed it as refused by the trial`);
  } finally { await b.close(); await c.close(); await new Promise((ok) => r.close(ok)); }
});

