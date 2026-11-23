// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2867 (feedback #088, a headless Linux node): (1) a seat restart left no line in the setup log saying it stopped or why - the seat's
// unit now writes every start and every stop (result, exit code and status, its last journal lines) there; (2) the owner page is reached only
// through a quick tunnel, and a saved link died without a word when the tunnel took a new name - `bitcoinarena owner-link` prints the owner
// page's link through the tunnel's CURRENT address and keeps it in the setup log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seatUnit } from '../src/service.js';
import { ownerLinkOf, noteSetupLog, OWNER_SITE } from '../src/bitcoinarena.js';

test('#2867 the seat unit writes its starts and stops (result, code, status, last lines) to the setup log', () => {
  const u = seatUnit({ node: '/n/node', release: '/r', home: '/h', port: 8470 });
  assert.match(u, /^ExecStartPre=-\/bin\/sh -c '.* seat on port 8470 starting" >> %h\/\.cache\/bitcoin-arena-node-setup\.log'$/m);
  assert.match(u, /^ExecStopPost=-\/bin\/sh -c '.*stopped: result=\$\$SERVICE_RESULT code=\$\$EXIT_CODE status=\$\$EXIT_STATUS; its last lines: \$\$\(journalctl --user -u %n -n 3 .*>> %h\/\.cache\/bitcoin-arena-node-setup\.log'$/m);
  assert.ok(!/[^$]\$\{/.test(u.split('\n').filter((l) => l.startsWith('Exec')).join('\n')), 'no ${...} left for systemd to expand');
});

test('#2867 owner-link: the tunnel\'s current address as local=, else public_url; written to the setup log', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ol-')), key = 'ab'.repeat(32), log = join(home, 'setup.log');
  writeFileSync(join(home, 'arena.conf'), 'port = 8470\npublic_url = wss://old-name.trycloudflare.com\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ reach: { mode: 'quick', url: 'wss://old-name.trycloudflare.com' }, service: { identity: key } }));
  const r = await ownerLinkOf(home, { quickUrl: async () => 'https://new-name.trycloudflare.com' });
  assert.equal(r.ok, true); assert.equal(r.quick, true);
  assert.equal(r.link, `${OWNER_SITE}#node=${key}&local=${encodeURIComponent('https://new-name.trycloudflare.com')}`);
  const stale = await ownerLinkOf(home, { quickUrl: async () => null });
  assert.equal(stale.url, 'https://old-name.trycloudflare.com', 'no tunnel name read: the configured address, as https');
  noteSetupLog(`owner link: ${r.link} (quick tunnel)`, { setupLog: log });
  assert.match(readFileSync(log, 'utf8'), /^\d{4}-\d\d-\d\dT[\d:.]+Z owner link: https:\/\/testnet\.bitcoinarena\.io\/owner\/#node=/);
  const none = mkdtempSync(join(tmpdir(), 'ol-')); writeFileSync(join(none, 'arena.conf'), 'port = 8470\n');
  assert.equal((await ownerLinkOf(none, {})).ok, false);
});
