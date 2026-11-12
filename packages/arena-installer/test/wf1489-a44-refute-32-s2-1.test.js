// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute #1630 (skeptic 2): the node writes <db>.owner.json durably (.bak first, then the file, each atomic) and
// reads a file that does not parse from its .bak. The installer's wizard - run again on an installed node (arena-install.mjs,
// reach-switch, custody-add open it on the same home) - still writes owner.json with a plain writeFileSync (truncate, then write)
// and never touches the .bak. A crash in that write leaves owner.json torn beside a .bak that still names the PREVIOUS owner, and
// the node starts claimed by that previous key (with its old leave) instead of refusing: the stale .bak is trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWizard } from '../src/wizard.js';
import { nodeState } from '../src/state.js';
import { readDurableJson, writeDurableJson } from '../../arena-node/src/durable-json.js';

const RELEASE = resolve(fileURLToPath(import.meta.url), '../../../..');

function client(port) {
  let cookie = '';
  const req = (method, path, body, headers = {}) => new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => {
        const sc = res.headers['set-cookie']; if (sc) cookie = String(sc[0] || sc).split(';')[0];
        let j = null; try { j = JSON.parse(b); } catch { /* html */ }
        ok({ status: res.statusCode, json: j });
      });
    });
    r.on('error', no); if (body) r.write(JSON.stringify(body)); r.end();
  });
  return { req, post: (path, body = {}) => req('POST', path, body, { 'x-arena-wizard': '1' }), get: (path) => req('GET', path) };
}

test('#1489 a44-refute-32-s2-1: the wizard\'s owner write leaves a stale .bak - a torn owner.json reads back as the previous owner', { timeout: 60000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-a44-32-s2-'));
  const state = nodeState(home);
  const OLD = 'a'.repeat(64);          // the owner the running node had (claimed, leaving) - written by the node, durably
  const NEW = 'b'.repeat(64);          // the seed's owner key the wizard binds now
  writeDurableJson(join(home, 'node.db.owner.json'), { pubkey: OLD, claimedAtMs: 1, leaving: { atMs: 2 } });
  state.save({ done: { start: 1, seed: 1 }, seedOwnerPubkey: NEW });
  const wizard = createWizard({ state, release: RELEASE, seatPort: 1 });
  const server = http.createServer((q, s) => wizard.handle(q, s));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => server.close());
  const c = client(server.address().port);
  assert.equal((await c.get(`/?t=${wizard.token}`)).status, 303);
  const r = await c.post('/api/owner', { mode: 'seed' });
  assert.equal(r.json && r.json.ok, true, JSON.stringify(r.json));
  const main = JSON.parse(readFileSync(join(home, 'node.db.owner.json'), 'utf8'));
  assert.equal(main.pubkey, NEW, 'the wizard bound the new owner');
  const bak = JSON.parse(readFileSync(join(home, 'node.db.owner.json.bak'), 'utf8'));
  // the crash in the wizard's writeFileSync: O_TRUNC landed, the bytes did not
  writeFileSync(join(home, 'node.db.owner.json'), '');
  let after; try { after = readDurableJson(join(home, 'node.db.owner.json'), null); } catch (e) { after = { threw: e.code }; }
  console.log(`  #1489 a44-refute-32-s2-1: .bak after the wizard's owner write names ${bak.pubkey.slice(0, 8)}; a torn owner.json reads as ${JSON.stringify(after).slice(0, 80)}`);
  assert.equal(bak.pubkey, NEW, 'the wizard wrote owner.json without its .bak: the .bak still names the previous owner');
  assert.notEqual(after && after.pubkey, OLD, 'a crash in the wizard\'s owner write hands the node back to the previous owner (and its old leave)');
});
