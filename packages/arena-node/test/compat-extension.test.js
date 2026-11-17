// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Optional integration check: the real store extension and our real login component/bundle, on a local relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { checkExtension } from '../tools/compat-extension.mjs';

test('the store extension opens a wallet through the real login component, survives its reload, and reads its encrypted seed back', {
  skip: !process.env.COMPAT_EXTENSION_PACKAGE,
  timeout: 120000,
}, async () => {
  const events = [];
  const server = createServer((req, res) => {
    if (req.url === '/arena-nostr.js' || req.url === '/arena-react.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(readFileSync(new URL(req.url === '/arena-nostr.js' ? '../../arena-client/dist/arena-nostr.js' : '../../../src/arena-ui/arena-react.js', import.meta.url)));
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><div id="wallet"></div><script src="/arena-nostr.js"></script><script src="/arena-react.js"></script><script>
      const N = window.ARENA_NOSTR;
      const already = !!sessionStorage.getItem('arena.player.seed');
      window.ARENA_WALLET_SCREEN = { shown: !already };
      if (!already) window.ArenaWalletStart.open(document.getElementById('wallet'), { nostr: {
        load: async () => N,
        extension: () => N.extensionSigner(window.nostr),
        login: async (signer) => {
          const got = await N.seedFor(signer, { relays: ['ws://' + location.host], maxWait: 2000 });
          sessionStorage.setItem('arena.player.seed', Array.from(got.seed, b => b.toString(16).padStart(2, '0')).join(''));
          localStorage.setItem('arena.nostr', JSON.stringify({ npub: N.npubOf(signer.pubkey) }));
          location.reload();
        }
      } });
    </script>`);
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] === 'EVENT') { events.push(m[1]); ws.send(JSON.stringify(['OK', m[1].id, true, ''])); }
    if (m[0] === 'REQ') {
      const f = m[2];
      for (const e of events) if ((!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey))
        && (!f['#d'] || e.tags.some((t) => t[0] === 'd' && f['#d'].includes(t[1])))) ws.send(JSON.stringify(['EVENT', m[1], e]));
      ws.send(JSON.stringify(['EOSE', m[1]]));
    }
  }));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const host = `127.0.0.1:${server.address().port}`;
  try {
    const result = await checkExtension({ adapter: process.env.COMPAT_EXTENSION_ADAPTER || 'nos2x' }, { site: `http://${host}/`, relay: `ws://${host}`, packageFile: process.env.COMPAT_EXTENSION_PACKAGE });
    assert.deepEqual(result.checks, { login: 'ok', seed: 'ok', decrypt: 'ok', sign: 'ok' });
    assert.ok(result.version);
    assert.equal(events.filter((e) => e.kind === 30078).length, 1);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise((done) => wss.close(done));
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
