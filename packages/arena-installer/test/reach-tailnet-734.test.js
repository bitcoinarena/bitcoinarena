// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MACHINE THE INTERNET CANNOT REACH DIRECTLY, ON A TAILNET, IS POINTED AT TAILSCALE FUNNEL (kanban #734, measured 2026-10-29 on the
// macOS: behind the home router with no forward the seats answered reached:false for 46.22.17.30:6221, and asked over the tailnet they
// refused 127.0.0.1 as not a public address). The check never claims direct reach, opens no port, and says what it cannot do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWizard } from '../src/wizard.js';
import { nodeState } from '../src/state.js';
import * as reachKit from '../src/reach.js';

const NAT = { ok: true, reached: false, address: '46.22.17.30', port: 6221, answers: [], diagnosis: { cause: 'nat', advice: 'a router in front of this machine does not forward port 6221' } };
const running = { BackendState: 'Running', Self: { DNSName: 'macbook.example.com.' } };

/** A Tailscale CLI stand-in: `status` answers `st`; every call is recorded. */
const tailscaleOf = (st) => { const calls = []; return { calls, sh: async (bin, args) => { calls.push(args.join(' ')); return args[0] === 'status' ? { ok: Boolean(st), out: st ? JSON.stringify(st) : '', err: st ? '' : 'not found' } : { ok: true, out: '{}', err: '' }; } }; };

async function wizard(t, { direct = NAT, st }) {
  const home = mkdtempSync(join(tmpdir(), 'tailnet-734-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const ts = tailscaleOf(st);
  const w = createWizard({ state: nodeState(home), release: home, seatPort: 6221, tailscale: 'tailscale', tailscaleSh: ts.sh, reach: { ...reachKit, checkDirect: async () => ({ ...direct }) } });
  const server = http.createServer((q, s) => w.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  let cookie = '';
  const go = (method, path, body) => new Promise((ok, no) => {
    const q = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' } }, (r) => {
      const set = r.headers['set-cookie']; if (set) cookie = set[0].split(';')[0];
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* html */ } ok(j); });
    });
    q.on('error', no); if (body) q.write(JSON.stringify(body)); q.end();
  });
  await go('GET', `/?t=${w.token}`);
  return { go, ts };
}

test('not reached, on a tailnet: Funnel is the default, "direct" is refused with the limit stated, and nothing is opened', async (t) => {
  const { go, ts } = await wizard(t, { st: running });
  const d = await go('POST', '/api/reach/direct', { port: 6221 });
  assert.equal(d.result.reached, false, 'no direct reach is claimed');
  assert.equal(d.result.tailnet, 'macbook.example.com');
  assert.equal(d.default, 'tailscale');
  const s = await go('POST', '/api/reach/save', { mode: 'direct' });
  assert.equal(s.ok, false);
  assert.equal(s.why, 'this machine is not reachable directly from the internet (port 6221 at 46.22.17.30). This machine is on your tailnet as macbook.example.com: choose Tailscale Funnel, which needs no port opened on your router');
  assert.deepEqual(ts.calls, ['status --json'], 'the check only asks Tailscale its status: no funnel, no serve');
});

test('not reached, no Tailscale: the permanent tunnel stays the default and the refusal says to open the port or choose a tunnel', async (t) => {
  const { go } = await wizard(t, { st: null });
  const d = await go('POST', '/api/reach/direct', { port: 6221 });
  assert.equal(d.result.tailnet, null);
  assert.equal(d.default, 'permanent');
  assert.match((await go('POST', '/api/reach/save', { mode: 'direct' })).why, /not reachable directly from the internet \(port 6221 at 46\.22\.17\.30\): open the port as the check says/);
});

test('Tailscale installed but logged out is not a tailnet; a machine reached directly keeps direct and Tailscale is not asked', async (t) => {
  assert.equal(await reachKit.tailnetName({ sh: tailscaleOf({ BackendState: 'NeedsLogin', Self: { DNSName: '' } }).sh }), null);
  const { go, ts } = await wizard(t, { st: running, direct: { ...NAT, reached: true, diagnosis: { cause: 'reachable', advice: '' } } });
  const d = await go('POST', '/api/reach/direct', { port: 6221 });
  assert.equal(d.default, 'direct');
  assert.deepEqual(ts.calls, []);
});
