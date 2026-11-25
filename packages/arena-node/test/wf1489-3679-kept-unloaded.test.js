// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3679, ruled in #3706: a superseded version whose rounds are all final, settled and 24 h past, with no open round and no series
// naming it, is left unloaded at start (still hosted, nothing on disk moved or removed) and loaded when a round, replay, re-run or
// re-verify first reaches it; any of the four conditions failing keeps it loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as P from '../src/plugin-package.js';
import * as H from '../src/plugins.js';
import * as I from '../src/version-idle.js';
import { openStore } from '../src/store.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testDevKey } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { RESULT_TYPE, PAYOUT_RULE, NO_PARENT, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { signManifest } from '../../arena-donor/src/manifest-sign.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const { packageOf, installPackage, loadInstalled } = P;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'k3679-'));
const src = (v) => `export const DECIDE = { name: 'tac', decide(moves) { const out = {}; const best = Math.max(...moves.map((m) => m.move)); /* v${v} */
  const w = moves.filter((m) => m.move === best).length; for (const m of moves) out[m.key] = w === moves.length ? 'DRAW' : m.move === best ? 'WIN' : 'LOSS'; return out; } };\n`;
function version(v, parent) {
  const s = src(v), file = join(srcDir, `d${v}.mjs`); writeFileSync(file, s);
  const hash = sha(Buffer.from(s)), cfg = '33'.repeat(32), set = testDonationSet('tac'), key = testDevKey('tac dev');
  const manifest = signManifest({ gameName: 'tac', gameDevPubkey: key.pubkey, version: v, parentManifestId: parent, resultType: RESULT_TYPE.HEAD_TO_HEAD,
    cores: [{ hash: Buffer.from(hash, 'hex'), configs: [Buffer.from(cfg, 'hex')] }], runTicksMax: 0, roundPeriodMs: 0n, payoutRule: PAYOUT_RULE.RANK_CURVE,
    rankNumerator: 3, rankDenominator: 4, minScore: 2, clients: [], gameDonationSetId: donationSetId(set), players: 2, moveCount: 3, revealWindowMs: 60000n }, key);
  return { name: 'tac', manifest, gameId: gameIdOf(manifest), donationSet: set, clientUrls: [], hash, cfg,
    cores: new Map([[hash, { name: 'tac', hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) }]]) };
}
const N = 16, games = [];
{ let parent = NO_PARENT; for (let v = 1; v <= N; v++) { const g = version(v, parent); games.push(g); parent = g.gameId; } }
const installAll = (dir, list) => list.forEach((g) => installPackage(dir, packageOf(g, { ancestors: games.slice(0, games.indexOf(g)).map((x) => x.manifest) }), toHex(g.gameId)));
const tree = (dir) => readdirSync(dir, { recursive: true }).sort().map((f) => `${f}:${statSync(join(dir, f)).isDirectory() ? 'd' : statSync(join(dir, f)).size}`);

test('#3679 an idle superseded version is left unloaded at start, still hosted, and loaded when a round reaches it', async () => {
  const one = mkdtempSync(join(tmpdir(), 'k3679-one-')), many = mkdtempSync(join(tmpdir(), 'k3679-many-'));
  installAll(many, games); installAll(one, [games[N - 1]]);
  const all = (ids) => ids;   // every candidate idle (the store's verdict is the next test's)
  await loadInstalled(one, { verify: verifyEd25519, keepUnloaded: all });
  const first = await loadInstalled(many, { verify: verifyEd25519, keepUnloaded: all });   // the first start: every trial runs, none unloaded
  assert.equal(first.unloaded.length, 0, 'a version with no kept trial result is never left unloaded');
  const before = tree(many);
  let t = Date.now(); const a = await loadInstalled(one, { verify: verifyEd25519, keepUnloaded: all }); H.hostedPlugins(a.registrations); const oneMs = Date.now() - t;
  t = Date.now(); const b = await loadInstalled(many, { verify: verifyEd25519, keepUnloaded: all }); const hosted = H.hostedPlugins(b.registrations); const manyMs = Date.now() - t;
  console.log(`#3679 restart with hosting: 1 version ${oneMs} ms, ${N} versions ${manyMs} ms (${b.unloaded.length} kept unloaded, ${hosted.size} hosted)`);
  assert.equal(hosted.size, N, 'every version is still hosted');
  assert.equal(b.unloaded.length, N - 1, 'every superseded version is left unloaded; the newest is loaded');
  assert.ok(!b.unloaded.includes(toHex(games[N - 1].gameId)));
  assert.ok(manyMs < 4 * Math.max(oneMs, 50), `the restart loaded every one of ${N} versions: ${manyMs} ms against ${oneMs} ms for one`);
  assert.deepEqual(tree(many), before, 'nothing under the package store is moved or removed');
  // a round (a replay, a re-run, a re-verify after a reorg: each asks pluginForRound) of an unloaded version loads it
  const old = hosted.get(toHex(games[2].gameId));
  assert.equal(old.kept.unloaded, true);
  const f = H.pluginForRound({ gameId: games[2].gameId, simCoreHash: Buffer.from(games[2].hash, 'hex'), configHash: Buffer.from(games[2].cfg, 'hex') }, hosted);
  assert.equal(old.kept.unloaded, false, 'the round loaded it');
  assert.ok(f.ok || !/does not load|unloaded/.test(f.why), f.why);
  assert.equal(hosted.get(toHex(games[3].gameId)).kept.unloaded, true, 'only the version asked for is loaded');
  // a version the store keeps loaded is loaded at start
  const c = await loadInstalled(many, { verify: verifyEd25519, keepUnloaded: (ids) => ids.filter((x) => x !== toHex(games[0].gameId)) });
  assert.ok(!c.unloaded.includes(toHex(games[0].gameId)));
  assert.equal(c.registrations.find((r) => toHex(r.gameId) === toHex(games[0].gameId)).unloaded, undefined);
});

test('#3679 the store\'s verdict: unloaded only when no round is open, every round is final and settled, and 24 h have passed', () => {
  const db = openStore(':memory:'), now = Date.now(), H24 = 24 * 3600 * 1000;
  const put = (table, row) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all(), full = { ...row };
    for (const c of cols) if (!(c.name in full) && c.notnull && c.dflt_value === null) full[c.name] = /INT/i.test(c.type) ? 0 : /BLOB/i.test(c.type) ? Buffer.alloc(1) : 'x';
    const k = Object.keys(full); db.prepare(`INSERT INTO ${table} (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`).run(...k.map((x) => full[x]));
  };
  let n = 0;
  const contractOf = (gid) => Buffer.concat([Buffer.from([1, 0, 1]), Buffer.alloc(32, 7), Buffer.from(gid, 'hex'), Buffer.alloc(64)]);
  const round = (gid, { state = 1, closed = now - H24 - 60000 } = {}) => { const rid = Buffer.alloc(32, ++n); put('rounds', { round_id: rid, contract: contractOf(gid), state, opened_ms: closed === null ? now : closed - 1000, closed_ms: closed }); return rid; };
  const id = (k) => k.repeat(32);
  const cases = {
    idle: id('a1'), open: id('a2'), recent: id('a3'), objection: id('a4'), unsettled: id('a5'), resubmitting: id('a6'), settledRecent: id('a7'), series: id('a8'), settled: id('a9'), market: id('aa'), noRounds: id('ab'),
  };
  round(cases.idle); round(cases.idle);
  round(cases.open); round(cases.open, { state: 0, closed: null });
  round(cases.recent, { closed: now - 3600 * 1000 });
  { const r = round(cases.objection); put('pending_objections', { round_id: r, entry_id: Buffer.alloc(32, 1), arrived_ms: now - H24 }); }
  { const r = round(cases.unsettled); put('stake_locks', { round_id: r, entry_id: Buffer.alloc(32, 2) }); }
  // a reorg that took the settlement back: the row is SUBMITTING again
  { const r = round(cases.resubmitting); put('stake_locks', { round_id: r, entry_id: Buffer.alloc(32, 3) }); put('lock_settlements', { round_id: r, state: 'SUBMITTING', made_ms: now - 2 * H24 }); }
  { const r = round(cases.settledRecent); put('stake_locks', { round_id: r, entry_id: Buffer.alloc(32, 4) }); put('lock_settlements', { round_id: r, state: 'ACCEPTED', made_ms: now - 3600 * 1000 }); }
  round(cases.series);
  { const r = round(cases.settled); put('stake_locks', { round_id: r, entry_id: Buffer.alloc(32, 5) }); put('lock_settlements', { round_id: r, state: 'ACCEPTED', made_ms: now - H24 - 1000 }); }
  { const r = round(cases.market); put('market_states', { round_id: r, state: 'ATTESTED' }); }
  const r = I.idleVersions(db, Object.values(cases), { nowMs: now, seriesGameIds: new Set([cases.series]) });
  const got = Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, r.idle.has(v) ? 'unloaded' : `loaded: ${r.why.get(v)}`]));
  console.log('#3679', JSON.stringify(got));
  for (const k of ['idle', 'settled', 'noRounds']) assert.equal(got[k], 'unloaded', k);
  for (const k of ['open', 'recent', 'objection', 'unsettled', 'resubmitting', 'settledRecent', 'series', 'market']) assert.match(got[k], /^loaded: /, k);
});
