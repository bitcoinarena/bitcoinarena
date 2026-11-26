// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT BINDS ITS /play SOCKETS TO ITS ENTRY (kanban #3799, follow-up of #3742 / PR #90). A seat keeps a Void learned on a socket as
// the player's only when the entry's session key signed that socket's nonce; before this the client sent no `nonce` / `player`, so every
// honest catch-up was 'play-unbound'. Each socket - the home socket and every peer link - now asks for a nonce once the entry is known and
// answers it signed; a seat on an older build ('error unknown text message') changes nothing for the run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Client } from '../src/client.js';
import { playOwnerDigest } from '../../arena-protocol/src/play-owner.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

function seat({ old = false, sessionPub }) {
  const key = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
  const http = createServer(); const wss = new WebSocketServer({ noServer: true });
  const bound = []; const said = [];
  http.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => {
    let nonce = null;
    ws.on('message', (d) => {
      const t = d.toString(); said.push(t.split(' ')[0]);
      if (old) return ws.send(t === 'ping' ? 'pong' : 'error unknown text message');
      if (t === 'nonce') { nonce = ed25519.utils.randomSecretKey(); return ws.send(`nonce ${toHex(nonce)} ${toHex(key)}`); }
      if (t.startsWith('player ')) {
        const [, eh, sh] = t.split(' '); const n = nonce; nonce = null;
        const ok = !!n && ed25519.verify(fromHex(sh), playOwnerDigest({ seatPubkey: key, nonce: n, entryId: fromHex(eh) }), sessionPub);
        if (ok) bound.push(eh);
        return ws.send(ok ? `player ${eh}` : 'error that signature does not verify');
      }
      return ws.send(t === 'ping' ? 'pong' : 'error unknown text message');
    });
  }));
  return new Promise((r) => http.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${http.address().port}`, bound, said,
    close: () => { for (const c of wss.clients) c.terminate(); return new Promise((d) => http.close(d)); } })));
}
const until = async (ok, ms = 3000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 20))) if (ok()) return true; return ok(); };

test('#3799 the home socket and a peer link are bound to the entry with the session key; an older seat changes nothing', async () => {
  const session = ed25519.utils.randomSecretKey(); const sessionPub = ed25519.getPublicKey(session);
  const home = await seat({ sessionPub }), peer = await seat({ sessionPub }), old = await seat({ old: true, sessionPub });
  const c = new Client({ base: home.base, core: {}, sign: (m) => ed25519.sign(m, session), verify: () => true });
  const roundId = new Uint8Array(32).fill(1), entryId = new Uint8Array(32).fill(2), eh = toHex(entryId);
  try {
    await c.connect();
    c.setRound({ roundId, entryId, blockTicks: 600 });
    await c.peerLink(peer.base);
    await c.peerLink(old.base);
    await until(() => home.bound.length && peer.bound.length && old.said.includes('nonce'));
    const after = { home: await c.send('ping'), old: await c.sendPeer(old.base, 'ping') };
    console.log('  FACTS:', JSON.stringify({ home: home.bound, peer: peer.bound, oldSaid: old.said, after }));
    assert.deepEqual(home.bound, [eh], 'the home socket is shown to be the player\'s');
    assert.deepEqual(peer.bound, [eh], 'the peer link is too');
    assert.deepEqual(after, { home: 'pong', old: 'pong' }, 'the answers after the binding still go to their own sends');
  } finally { try { c.sock && c.sock.close(); } catch { /* gone */ } for (const [, l] of c.peerLinks) try { l.sock && l.sock.close(); } catch { /* gone */ } await home.close(); await peer.close(); await old.close(); }
});
