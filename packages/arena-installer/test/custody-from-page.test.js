// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CUSTODY ADDED FROM THE OWNER PAGE (kanban #563): the plan shows Lightning, the bond against the guardian floor and what the wallet must
// hold (the wizard's own parts for custody added later) and changes nothing; the start needs the typed I UNDERSTAND, writes the request
// (0600) and starts the runner detached, once at a time; refused without Bitcoin Core, without a bond, and when custody is held already.
// The runner calls the wizard's own steps by name: each of them is one the wizard has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { custodyPlan, startCustodyAdd, custodyProgress, UNDERSTOOD } from '../src/add-custody.js';
import { createWizard, CUSTODY_PEG_IN_SATS, CUSTODY_UPDATE_RESERVE_SATS } from '../src/wizard.js';
import { RING_RESERVE_SATS, OUTSIDE_RESERVE_SATS } from '../src/custody-agent.js';
import { BOND_MIN_SATS } from '../src/bond.js';
import { nodeState } from '../src/state.js';

// a release with a guardian for this system (runtime/custody/fedimintd and fedimint-cli), as the release carries them
function release() {
  const rel = mkdtempSync(join(tmpdir(), 'rel-'));
  mkdirSync(join(rel, 'runtime', 'custody'), { recursive: true });
  const x = process.platform === 'win32' ? '.exe' : '';
  for (const f of [`fedimintd${x}`, `fedimint-cli${x}`]) writeFileSync(join(rel, 'runtime', 'custody', f), '');
  mkdirSync(join(rel, 'packages', 'arena-installer', 'bin'), { recursive: true });
  writeFileSync(join(rel, 'packages', 'arena-installer', 'bin', 'custody-add.mjs'), '');
  return rel;
}
function node(patch = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cust-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core', url: 'http://127.0.0.1:48332/' }, owner: { pubkey: 'ab'.repeat(32) },
    reach: { mode: 'permanent', url: 'https://node.example.com', port: 8570 }, bond: { txid: 'b0'.repeat(32), vout: 0, sats: '60000', maturity: 160000 }, ...patch });
  const kit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 40000 }] }) };
  return { home, state, kit };
}

test('the plan: Lightning to install, the bond against the guardian floor, the wallet against what custody needs - nothing changes', async () => {
  const n = node(), rel = release();
  const r = await custodyPlan({ home: n.home, release: rel, state: n.state, kit: n.kit });
  assert.equal(r.ok, true, r.why);
  const p = r.plan;
  assert.equal(p.lightning, 'install');
  assert.deepEqual([p.bondSats, p.bondFloorSats, p.bondBelowFloor], [60000, Number(BOND_MIN_SATS), 60000 < Number(BOND_MIN_SATS)]);
  assert.deepEqual(p.parts, { custodyUpdate: CUSTODY_UPDATE_RESERVE_SATS, advertUpdate: CUSTODY_UPDATE_RESERVE_SATS, pegIn: CUSTODY_PEG_IN_SATS, outside: OUTSIDE_RESERVE_SATS, ring: RING_RESERVE_SATS },
    'the wizard\'s own parts for custody added to a bonded node: two advertisement updates, the peg-in, the channels\' reserves - no second bond');
  const need = 2 * CUSTODY_UPDATE_RESERVE_SATS + CUSTODY_PEG_IN_SATS + OUTSIDE_RESERVE_SATS + RING_RESERVE_SATS;
  assert.deepEqual([p.needSats, p.walletSats, p.shortSats], [need, 40000, Math.max(0, need - 40000)]);
  assert.match(p.address, /^tb1p/);
  assert.equal(p.guardianEndpoint, 'wss://node.example.com/guardian');
  assert.deepEqual(n.state.read().roles, ['verify', 'settlement'], 'the plan changes nothing');
  assert.equal(n.state.read().custodyLater, undefined);
  const lower = await custodyPlan({ home: n.home, release: rel, state: n.state, kit: n.kit, pegInSats: 20000 });
  assert.equal(lower.plan.parts.pegIn, 20000, 'a peg-in the owner names');
  const ln = node({ lightning: { mode: 'own', lnddir: '/lnd', restUrl: 'https://127.0.0.1:10080', pubkey: '03' + 'cd'.repeat(32) }, gateway: { apiUrl: 'http://127.0.0.1:8176' } });
  assert.deepEqual([(await custodyPlan({ home: ln.home, release: rel, state: ln.state, kit: ln.kit })).plan.lightning, (await custodyPlan({ home: ln.home, release: rel, state: ln.state, kit: ln.kit })).plan.gateway], ['running', 'set up']);
});

test('refused without Bitcoin Core, without a bond, without a guardian in the release; done when custody is held', async () => {
  const rel = release();
  const e = node({ chain: { kind: 'electrum', url: 'ssl://x:50002' } });
  assert.match((await custodyPlan({ home: e.home, release: rel, state: e.state, kit: e.kit })).why, /your own Bitcoin Core/);
  const nb = node({ bond: null });
  assert.match((await custodyPlan({ home: nb.home, release: rel, state: nb.state, kit: nb.kit })).why, /no bond yet/);
  const ng = node();
  assert.match((await custodyPlan({ home: ng.home, release: mkdtempSync(join(tmpdir(), 'bare-')), state: ng.state, kit: ng.kit })).why, /cannot run a guardian/);
  const held = node({ roles: ['verify', 'custody'], bond: { txid: 'b0'.repeat(32), sats: '60000', custodyAdvert: { txid: 'c0'.repeat(32) } } });
  assert.deepEqual((await custodyPlan({ home: held.home, release: rel, state: held.state, kit: held.kit })).done, true);
});

test('the start needs I UNDERSTAND, writes the request for the owner alone, starts the runner detached - once at a time', () => {
  const n = node(), rel = release();
  const runs = [];
  const run = (cmd, args, opts) => { runs.push({ cmd, args, opts }); return { unref() {} }; };
  assert.match(startCustodyAdd({ home: n.home, release: rel, understood: 'ok', run }).why, /type I UNDERSTAND/);
  assert.equal(runs.length, 0);
  const r = startCustodyAdd({ home: n.home, release: rel, understood: ' i understand ', pegInSats: 30000, node: '/node', run, nowMs: 1000 });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([runs[0].cmd, runs[0].args], ['/node', [join(rel, 'packages', 'arena-installer', 'bin', 'custody-add.mjs'), '--home', n.home]]);
  assert.equal(runs[0].opts.detached, true, 'detached: its service step restarts the seat that started it');
  const req = JSON.parse(readFileSync(join(n.home, 'custody-add.req'), 'utf8'));
  assert.deepEqual(req, { understood: UNDERSTOOD, pegInSats: 30000 });
  assert.equal(statSync(join(n.home, 'custody-add.req')).mode & 0o077, 0);
  assert.equal(custodyProgress(n.home).state, 'running');
  const again = startCustodyAdd({ home: n.home, release: rel, understood: UNDERSTOOD, run, nowMs: 2000 });
  assert.deepEqual([again.ok, again.status], [false, 409]);
  writeFileSync(join(n.home, 'custody-add.json'), JSON.stringify({ state: 'failed', why: 'x', atMs: 3000 }));
  assert.equal(startCustodyAdd({ home: n.home, release: rel, understood: UNDERSTOOD, run, nowMs: 4000 }).ok, true, 'after a failed run it starts again');
  assert.equal(startCustodyAdd({ home: n.home, release: mkdtempSync(join(tmpdir(), 'old-')), understood: UNDERSTOOD, run, nowMs: 99e9 }).status, 501, 'a release without the runner');
});

// and the address switch, which calls the wizard's steps the same way (before the wizard named its steps, every call was undefined)
test('the runners call the wizard\'s own steps: every one custody-add and reach-switch name is one the wizard has', () => {
  const n = node();
  const wizard = createWizard({ state: n.state, release: release() });
  for (const [bin, least] of [['custody-add.mjs', 10], ['reach-switch.mjs', 4]]) {
    const runner = readFileSync(new URL(`../bin/${bin}`, import.meta.url), 'utf8');
    const named = [...runner.matchAll(/wizard\['(POST \/api\/[a-z/]+)'\]/g)].map((m) => m[1]);
    assert.ok(named.length >= least, `${bin} names ${named.length} steps`);
    for (const k of new Set(named)) assert.equal(typeof wizard[k], 'function', `${bin}: ${k} is a wizard step`);
  }
  assert.ok(!existsSync(join(n.home, 'arena.conf')), 'naming the steps runs none');
});
