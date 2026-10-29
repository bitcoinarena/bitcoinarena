// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LND WITH NO ROUTER, NO TOR AND NO OUTSIDE ADDRESS (kanban #730, measured 2026-10-29 in the Linux VM on 2026.1.9.12: nat=true was written,
// no router answered NAT-PMP, LND quit 20 s after each start - "unable to discover a NAT-PMP enabled device on the local network: Timed out
// trying to contact gateway" - five times in three minutes, and step 10 waited for its first answer for good).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureLnd } from '../src/lnd.js';
import { setUpOwnLnd, lndCrashes, lndReady } from '../src/lnd-setup.js';
import { routerForwards, defaultGateway } from '../src/router-probe.js';
import { nodeState } from '../src/state.js';

const chain = { url: 'http://127.0.0.1:48332', cookiePath: '/c/cookie' };

test('lnd.conf names nat only when a router answered, and never beside Tor or an outside address', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-730-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const conf = (o) => readFileSync(configureLnd({ home, chain, ...o }).conf, 'utf8');
  assert.doesNotMatch(conf({}), /nat=true/, 'nothing known: no nat');
  assert.match(conf({ nat: true }), /\nnat=true\n/, 'a router answered');
  assert.doesNotMatch(conf({ nat: true, externalIp: '1.2.3.4' }), /nat=true/);
  assert.doesNotMatch(conf({ nat: true, tor: { socks: 9050, control: 9051 } }), /nat=true/);
});

const setUp = async (t, { forwards }) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-730-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = nodeState(home);
  state.save({ chain: { kind: 'core', ...chain } });
  const configured = [];
  let asked = 0;
  const r = await setUpOwnLnd({ state, release: '/r', fetcher: async () => ({}),
    reach: { checkDirect: async () => ({ ok: true, reached: false, address: '46.22.17.30' }) },
    lndKit: { installLnd: async () => ({ ok: true, lnd: '/fake/lnd' }), lndArgs: () => ['/fake/lnd'],
      configureLnd: (o) => { configured.push(o); return { lnddir: join(home, 'lnd'), restUrl: 'https://127.0.0.1:8080', tlsCert: 'c', macaroon: 'm', passwordFile: 'p' }; },
      installProgram: async () => ({ ok: true }) },
    tor: { torBin: async () => null },
    router: async () => { asked++; return forwards ? { answered: true, by: 'NAT-PMP', why: 'the router 10.0.0.1 answered NAT-PMP' } : { answered: false, by: null, why: 'no router here forwards ports on request: no UPnP Internet gateway answered, and the router 10.0.2.2 did not answer NAT-PMP' }; } });
  return { r, configured, asked, st: state.read() };
};

test('not reached, no Tor and no router: LND is set up without nat and dials out; the step says how peers can reach it', async (t) => {
  const { r, configured, asked, st } = await setUp(t, { forwards: false });
  assert.equal(r.ok, true);
  assert.equal(asked, 1, 'the router is asked once');
  assert.equal(configured[0].nat, false, 'no nat=true: LND would stop at every start');
  assert.match(r.peers, /^LND dials out to its peers only: .*did not answer NAT-PMP\. For peers to reach it, forward TCP \d+ on your router to this computer, or install Tor \(on Linux: sudo apt install tor\), then run this step again$/);
  assert.equal(st.lnReach.router.answered, false);
  assert.match(st.tor.why, /neither this release nor this system has one/);
});

test('not reached, no Tor, a router that forwards on request: nat=true', async (t) => {
  const { r, configured } = await setUp(t, { forwards: true });
  assert.equal(configured[0].nat, true);
  assert.match(r.peers, /LND asks your router \(NAT-PMP\) to forward its port/);
});

const LOG = (lines) => () => lines.join('\n');
const exit = (ts) => `${ts} [ERR] LTND: Shutting down due to error in main method rev=bfa92b err="unable to discover a NAT-PMP enabled device on the local network: Timed out trying to contact gateway"`;

test('LND that stops itself twice since setup started it ends the wait with its reason and what to do; once, or before the start, does not', () => {
  const since = new Date('2026-10-29T13:07:00').getTime();
  assert.equal(lndCrashes({ lnddir: '/l', sinceMs: since, readLog: LOG([exit('2026-10-29 13:07:37.461')]) }), null, 'one exit: still waiting');
  assert.equal(lndCrashes({ lnddir: '/l', sinceMs: since, readLog: LOG([exit('2026-10-29 12:07:37.461'), exit('2026-10-29 12:08:37.461')]) }), null, 'exits before this start do not count');
  const c = lndCrashes({ lnddir: '/l', sinceMs: since, readLog: LOG([exit('2026-10-29 13:07:37.461'), '2026-10-29 13:08:10.000 [INF] LTND: Version: 0.21.5', exit('2026-10-29 13:08:30.120')]) });
  assert.equal(c.exits, 2);
  assert.match(c.why, /^LND stops right after it starts \(2 times since setup started it\): unable to discover a NAT-PMP enabled device .*\. Its settings ask your router to forward a port \(nat\) and no router here answers\. Choose "Set up LND here" again/);
});

test('step 10 leaves "Waiting for LND\'s first answer" when LND keeps stopping', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-730-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = nodeState(home);
  state.save({ lightning: { mode: 'own', lnddir: join(home, 'lnd'), startedMs: 1000 } });
  state.writeSecret('seed.hex', '11'.repeat(64) + '\n');
  const lndKit = { createLndWallet: async () => ({ ok: true, created: false }), testLnd: async () => ({ ok: false, why: 'the RPC server is in the process of starting up' }) };
  const waiting = await lndReady({ state, lndKit, crashes: () => null });
  assert.equal(waiting.waiting, true, 'starting, not stopping: still waiting');
  const stopped = await lndReady({ state, lndKit, crashes: () => ({ exits: 3, err: 'x', why: 'LND stops right after it starts (3 times since setup started it): x. y' }) });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.waiting, false, 'the wait ends: the step shows why');
  assert.match(stopped.why, /^LND stops right after it starts/);
});

test('the router probe: UPnP or NAT-PMP answered, or neither; the default gateway from /proc/net/route', async () => {
  const none = await routerForwards({ gateway: async () => '10.0.2.2', askUdp: async () => null });
  assert.deepEqual([none.answered, none.by], [false, null]);
  assert.match(none.why, /the router 10\.0\.2\.2 did not answer NAT-PMP/);
  const pmp = await routerForwards({ gateway: async () => '192.0.2.1', askUdp: async ({ port }) => (port === 5351 ? '192.0.2.1' : null) });
  assert.deepEqual([pmp.answered, pmp.by], [true, 'NAT-PMP']);
  const upnp = await routerForwards({ gateway: async () => null, askUdp: async ({ port }) => (port === 1900 ? '192.0.2.1' : null) });
  assert.deepEqual([upnp.answered, upnp.by], [true, 'UPnP']);
  const routes = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\nenp0s1\t00000000\t0202000A\t0003\t0\t0\t100\t00000000\nenp0s1\t0002000A\t00000000\t0001\t0\t0\t100\t00FFFFFF\n';
  assert.equal(await defaultGateway({ platform: 'linux', readRoutes: () => routes }), '10.0.2.2');
  assert.equal(await defaultGateway({ platform: 'win32' }), null);
});

test('LND up with no port, no Tor and no router: the Lightning step says it dials out only, and how peers can reach it', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-730-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = nodeState(home);
  state.writeSecret('seed.hex', '11'.repeat(64) + '\n');
  const lndKit = { createLndWallet: async () => ({ ok: true, created: false }), testLnd: async () => ({ ok: true, pubkey: '02ab', alias: 'a', uris: [] }) };
  state.save({ lightning: { mode: 'own', lnddir: join(home, 'lnd'), startedMs: 1 }, tor: { why: 'no Tor' },
    lnReach: { reached: false, port: 9935, atMs: 1, router: { answered: false, by: null, why: 'none' } } });
  assert.equal((await lndReady({ state, lndKit })).peers,
    'LND dials out to its peers only: no open port (measured), no Tor and no router that forwards ports. For peers to reach it, forward TCP 9935 on your router to this computer, or install Tor (on Linux: sudo apt install tor), then run this step again');
  state.save({ lnReach: { reached: false, port: 9935, atMs: 1, router: { answered: true, by: 'UPnP', why: 'x' } } });
  assert.equal((await lndReady({ state, lndKit })).peers, 'no open port (measured) and no Tor: LND asks your router (UPnP) to forward its port 9935');
});
