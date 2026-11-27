// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r40 nostr-3: A SIGNER'S RANDOM WALLET SEED IS MADE ALTHOUGH THE GAME'S RELAY - THE ONE THAT KEEPS IT - REFUSED IT (gap in #2713).
//
// For a signer login (extension, bunker, Amber) seedFor (nostr/nostr-login.js) makes a RANDOM seed; its kind 30078 event is the only copy, and
// the code says why the game's relay must hold it: "public relays prune NIP-78 app data, ours keeps it". #2713 made sure the game's relay ANSWERED
// the ask before a random seed is made - but not that it TOOK the new seed: publishWithPow counts any relay that took the event, so when the game's
// relay answers the EVENT with 'rate-limited:' (its signature budget drained - kanban #3044/#3145: good signatures under free fresh keys spend the
// shared bucket and the clean reserve) or 'blocked: the relay is full', and one public relay takes it, the login answers created: true and the page
// shows and funds that wallet. The seed now sits only on public relays. Once they prune it (or are not reachable), the next login finds the game's
// relay answering EOSE with nothing - every #1574/#2713 guard passes - and a NEW random seed is minted: the funded wallet is gone from the account
// unless the player wrote down the 24 words.
//
// Attack (role c, a stranger on the game relay): keep the relay's verify budget drained with valid events under fresh keys while new players log in.
// Safe behaviour: a signer's random seed is not taken into use unless the game's own relay (the list's first) kept its event; the account's seed
// never changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startRelay } from '../../arena-node/src/nostr-relay.js';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { SimplePool } from 'nostr-tools/pool';
import { extensionSigner, seedFor } from '../nostr/nostr-login.js';

const hex = (b) => Buffer.from(b).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('r40 nostr-3: a signer login whose seed the game relay refused does not take that seed into use (the account seed never changes)', async () => {
  const secret = generateSecretKey();
  const ext = { getPublicKey: async () => getPublicKey(secret), signEvent: async (t) => finalizeEvent(t, secret),
    nip44: { encrypt: async (p, t) => nip44.encrypt(t, nip44.getConversationKey(secret, p)), decrypt: async (p, t) => nip44.decrypt(t, nip44.getConversationKey(secret, p)) } };
  // the game's relay A, with small signature buckets that do not refill during the test (the default 200/s + 50/s are drained the same way, faster)
  const a = await startRelay({ port: 0, limits: { verifyBurst: 3, verifyPerS: 0, verifyCleanBurst: 3, verifyCleanPerS: 0, verifyStandingBurst: 0, verifyStandingPerS: 0 } });
  const urlA = `ws://127.0.0.1:${a.port}`;
  let b = await startRelay({ port: 0 });                    // a public relay
  const portB = b.port, urlB = `ws://127.0.0.1:${portB}`;
  const pools = [];
  const pool = () => { const p = new SimplePool(); pools.push(p); return p; };
  try {
    // the stranger drains A's buckets with good signatures under fresh keys
    const s = new WebSocket(urlA); await new Promise((r) => s.on('open', r));
    const oks = []; s.on('message', (m) => { const x = JSON.parse(String(m)); if (x[0] === 'OK') oks.push(x); });
    for (let i = 0; i < 8; i++) s.send(JSON.stringify(['EVENT', finalizeEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: `{"name":"x${i}"}` }, generateSecretKey())]));
    for (let t = Date.now(); oks.length < 8 && Date.now() - t < 3000;) await sleep(10);
    s.terminate();

    // day 1: a new player logs in with a signer; the game relay answers the ask (EOSE, nothing) and refuses the new seed 'rate-limited:'
    let day1;
    try { day1 = await seedFor(await extensionSigner(ext), { pool: pool(), relays: [urlA, urlB], maxWait: 1500 }); } catch (e) { day1 = { refused: e.message }; }
    const onA = a.events().filter((e) => e.kind === 30078).length;
    // the public relay prunes NIP-78 app data (here: it comes back empty on the same address)
    await b.close(); b = await startRelay({ port: portB });
    await sleep(1100);
    // day 2: the player logs in again
    let day2;
    try { day2 = await seedFor(await extensionSigner(ext), { pool: pool(), relays: [urlA, urlB], maxWait: 1500 }); } catch (e) { day2 = { refused: e.message }; }
    console.log(`  FACTS: stranger's ${oks.length} frames answered ${[...new Set(oks.map((x) => `${x[2]}`))].join('/')}; day 1 ${day1.refused ? `refused: ${day1.refused}` : `${day1.from} seed ${hex(day1.seed).slice(0, 12)} created=${day1.created}, kept on ${day1.relays.length} relay(s) ${JSON.stringify(day1.relays.map((u) => (u === urlA ? 'game' : 'public')))}`}; seed events on the game relay: ${onA}; day 2 ${day2.refused ? `refused: ${day2.refused}` : `${day2.from} seed ${hex(day2.seed).slice(0, 12)} created=${day2.created}`}`);
    if (day1.refused) return;   // safe: no wallet was made on a seed the game's relay does not keep
    assert.ok(onA > 0 || day1.relays.includes(urlA), 'the login took a random wallet seed into use that the game\'s relay refused (kept only on a public relay)');
    assert.ok(day2.refused || hex(day2.seed) === hex(day1.seed), `the account's wallet seed changed from ${hex(day1.seed).slice(0, 12)} to ${hex(day2.seed).slice(0, 12)}: the wallet funded on day 1 is lost`);
  } finally {
    for (const p of pools) { try { p.close([urlA, urlB]); } catch { /* closed */ } }
    await a.close(); await b.close();
  }
});
