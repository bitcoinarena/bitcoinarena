// kanban #3262: the card's test (audit r21 nostr-1)
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r21-nostr-1: A KEPT EVENT SENT AGAIN IS NOT NEWS. The relay's EVENT path skips the store step for an id it already keeps
// (`if (!has.get(e.id))`), answers OK and then fans the event out to every live subscription that matches - every time. So a stranger
// who signs nothing re-sends any event already on the relay (a node's signed round result, a badge award, a player's profile or seed,
// or one 64 KB event of their own, kept once inside its quota) as often as the per-socket budget lets, from as many sockets as they
// like, and every honest subscriber gets it again each time: no quota is ever spent, and the honest clients' backlog grows until the
// slow-client bound (#1542/#1904) drops THEM. NIP-01 relays answer such a copy "duplicate:" and pass nothing on.
// Safe: a copy of an event the relay already keeps reaches a live subscriber once at most (it was passed on when it first arrived).
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
const ev = (k, at, kind, tags, content) => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
const ask = (ws, m, until) => new Promise((x) => { const h = (raw) => { const a = JSON.parse(String(raw)); if (until(a)) { ws.off('message', h); x(a); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });

test('r21-nostr-1: re-sending a kept event does not hand it to every subscriber again', async () => {
  const r = await startRelay({ port: 0 });
  const player = await open(r.port), node = await open(r.port), stranger = await open(r.port);
  try {
    const nodeKey = key(), playerKey = key(), now = Math.floor(Date.now() / 1000);
    // the player follows their badge awards (kind 8 by #p), as the page does
    let seen = 0, id = null;
    player.on('message', (raw) => { const a = JSON.parse(String(raw)); if (a[0] === 'EVENT' && a[1] === 'mine' && a[2].id === id) seen++; });
    await ask(player, ['REQ', 'mine', { kinds: [8], '#p': [playerKey.pub] }], (a) => a[0] === 'EOSE');
    // the node publishes one award - big, as an award with many evidence rounds is
    const award = ev(nodeKey, now, 8, [['a', `30009:${nodeKey.pub}:arena-first-win`], ['p', playerKey.pub], ['evidence', ...Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(64, '0'))]], '');
    id = award.id;
    const ok = await ask(node, ['EVENT', award], (a) => a[0] === 'OK');
    assert.equal(ok[2], true, `the award is kept: ${ok[3]}`);
    // a stranger, who signs nothing, sends the very same event again and again
    for (let i = 0; i < 40; i++) await ask(stranger, ['EVENT', award], (a) => a[0] === 'OK' || a[0] === 'NOTICE');
    await new Promise((x) => setTimeout(x, 200));
    assert.ok(seen <= 1, `the player's subscription got the same kept award ${seen} times (once from the node, ${seen - 1} times from a stranger's copies)`);
  } finally { player.terminate(); node.terminate(); stranger.terminate(); await r.close(); }
});
