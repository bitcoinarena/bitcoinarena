// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 round 3, Nostr #1: A SLOW RELAY MUST NOT MINT A SECOND GAME SEED OVER THE FIRST.
// A player who logs in with a signer (extension, bunker, Amber) has a RANDOM game seed whose only copy is the kind 30078 event
// on the relays. seedFor counts a relay as "answered" once its socket opens (reachable), then asks for the seed with
// querySync(maxWait). A relay that holds the seed but does not finish its answer in time (busy, or kept busy by a stranger)
// looks exactly like "no seed": the page makes a new random seed and publishes it as a NEWER replaceable event, which every
// relay that takes it keeps in place of the old one. The player's wallet seed - and the sats on it - is gone.
// Safe behaviour: when a relay that was reached did not answer the seed query, no new seed is made (an error, as for
// "no relay answered"), and the seed event already kept stays the one kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, WebSocket } from 'ws';
import { startRelay } from '../../arena-node/src/nostr-relay.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { extensionSigner, seedFor, SEED_KIND } from '../nostr/nostr-login.js';

const hex = (b) => Buffer.from(b).toString('hex');

// A relay in front of the real one that takes EVENTs at once but answers a REQ only after `lagMs` (a busy relay)
async function slowRelay(upstreamUrl, lagMs) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (client) => {
    const up = new WebSocket(upstreamUrl);
    const queue = [];
    up.on('open', () => { for (const m of queue.splice(0)) up.send(m); });
    up.on('message', (m) => { if (client.readyState === 1) client.send(String(m)); });
    client.on('message', (raw) => {
      const text = String(raw);
      let m; try { m = JSON.parse(text); } catch { return; }
      const go = () => { if (up.readyState === 1) up.send(text); else queue.push(text); };
      if (m[0] === 'REQ') setTimeout(go, lagMs); else go();
    });
    client.on('close', () => up.close());
  });
  return { url: `ws://127.0.0.1:${wss.address().port}`, close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(r); }) };
}

test('wf1489-r3-nostr-1: a relay slow to answer the seed query makes no second seed over the player\'s first', async () => {
  const r = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${r.port}`;
  const secret = generateSecretKey();
  const ext = { getPublicKey: async () => getPublicKey(secret), signEvent: async (t) => finalizeEvent(t, secret),
    nip44: { encrypt: async (p, t) => nip44.encrypt(t, nip44.getConversationKey(secret, p)), decrypt: async (p, t) => nip44.decrypt(t, nip44.getConversationKey(secret, p)) } };
  const pool1 = new SimplePool();
  const slow = await slowRelay(url, 2500);
  const pool2 = new SimplePool();
  try {
    // the first login: a random seed, kept on the relay - the only copy of the player's wallet
    const first = await seedFor(await extensionSigner(ext), { pool: pool1, relays: [url] });
    assert.equal(first.created, true);
    const before = r.events().find((e) => e.kind === SEED_KIND);
    await new Promise((res) => setTimeout(res, 1100));   // a later second: the next event is newer
    // the next login, the relay busy: its socket opens, its answer to the REQ comes after maxWait
    let second = null, threw = null;
    try { second = await seedFor(await extensionSigner(ext), { pool: pool2, relays: [slow.url], maxWait: 1000 }); } catch (e) { threw = e; }
    await new Promise((res) => setTimeout(res, 1500));
    const after = r.events().find((e) => e.kind === SEED_KIND);
    const kept = JSON.parse(nip44.decrypt(after.content, nip44.getConversationKey(secret, getPublicKey(secret)))).seed;
    console.log(`second login: ${threw ? `refused (${threw.message})` : `created=${second.created} same seed=${hex(second.seed) === hex(first.seed)}`}; relay's seed event replaced=${after.id !== before.id}; kept seed is the first=${kept === hex(first.seed)}`);
    assert.ok(threw || hex(second.seed) === hex(first.seed), 'a slow relay made the page mint a new seed for an account that has one');
    assert.equal(kept, hex(first.seed), 'the player\'s first seed was replaced on the relay');
  } finally { pool1.close([url]); pool2.close([slow.url]); await slow.close(); await r.close(); }
});
