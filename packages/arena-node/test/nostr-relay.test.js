// THE GAME'S OWN NOSTR RELAY (kanban #277): what the page's Nostr login writes to first - a profile, an encrypted game seed
// (NIP-78, kind 30078), NIP-46 signing messages. Signatures are checked, a newer replaceable event replaces the older, the
// filters select, a live subscription is told at once, and anything outside the game's kinds is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { startRelay, eventId } from '../src/nostr-relay.js';

const hex = (b) => Buffer.from(b).toString('hex');
const keyOf = (n) => { const sk = new Uint8Array(32).fill(n); return { sk, pk: hex(schnorr.getPublicKey(sk)) }; };
const sign = (k, { kind, content = '', tags = [], created_at = Math.floor(Date.now() / 1000) }) => {
  const e = { pubkey: k.pk, created_at, kind, tags, content };
  e.id = eventId(e);
  e.sig = hex(schnorr.sign(Uint8Array.from(Buffer.from(e.id, 'hex')), k.sk));
  return e;
};
const client = async (port) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on('open', r));
  const inbox = [];
  ws.on('message', (m) => inbox.push(JSON.parse(String(m))));
  const next = async (pred, ms = 2000) => { for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 10))) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; } return null; };
  return { ws, send: (m) => ws.send(JSON.stringify(m)), next, inbox };
};

test('the relay keeps the game\'s events, signed, newest of each replaceable one; filters select; a live subscription hears at once', async () => {
  const r = await startRelay({ port: 0 });
  const a = keyOf(1), b = keyOf(2);
  const c = await client(r.port);
  try {
    // a profile, then a newer one: only the newer is kept
    const p1 = sign(a, { kind: 0, content: '{"name":"alice"}', created_at: 1000 });
    const p2 = sign(a, { kind: 0, content: '{"name":"alice2"}', created_at: 2000 });
    c.send(['EVENT', p1]); assert.deepEqual((await c.next((m) => m[0] === 'OK' && m[1] === p1.id)).slice(2, 3), [true]);
    c.send(['EVENT', p2]); assert.equal((await c.next((m) => m[0] === 'OK' && m[1] === p2.id))[2], true);
    c.send(['EVENT', p1]);
    assert.match((await c.next((m) => m[0] === 'OK' && m[1] === p1.id))[3], /newer one is kept/);
    // the encrypted seed (NIP-78) under its d tag, replaced by d
    const s1 = sign(a, { kind: 30078, content: 'ciphertext-1', tags: [['d', 'bitcoin-arena/seed']], created_at: 3000 });
    const s2 = sign(a, { kind: 30078, content: 'ciphertext-2', tags: [['d', 'bitcoin-arena/seed']], created_at: 4000 });
    const other = sign(a, { kind: 30078, content: 'x', tags: [['d', 'other-app']], created_at: 4000 });
    for (const e of [s1, s2, other]) { c.send(['EVENT', e]); await c.next((m) => m[0] === 'OK' && m[1] === e.id); }
    c.send(['REQ', 'seed', { authors: [a.pk], kinds: [30078], '#d': ['bitcoin-arena/seed'] }]);
    const got = await c.next((m) => m[0] === 'EVENT' && m[1] === 'seed');
    assert.equal(got[2].content, 'ciphertext-2');
    assert.ok(await c.next((m) => m[0] === 'EOSE' && m[1] === 'seed'));
    assert.equal(c.inbox.filter((m) => m[1] === 'seed').length, 0, 'only the newest seed event, and not the other app\'s');
    assert.deepEqual(r.events().map((e) => e.content).sort(), ['{"name":"alice2"}', 'ciphertext-2', 'x'].sort());
    // refusals: a forged signature, a changed content (id no longer its hash), a kind the game does not keep
    const forged = { ...sign(b, { kind: 0, content: '{}' }) }; forged.sig = forged.sig.replace(/^./, (x) => (x === '0' ? '1' : '0'));
    c.send(['EVENT', forged]); assert.match((await c.next((m) => m[0] === 'OK' && m[1] === forged.id))[3], /signature/);
    const changed = { ...sign(b, { kind: 0, content: '{}' }), content: '{"x":1}' };
    c.send(['EVENT', changed]); assert.match((await c.next((m) => m[0] === 'OK' && m[1] === changed.id))[3], /hash/);
    const note = sign(b, { kind: 1, content: 'hello' });
    c.send(['EVENT', note]); assert.match((await c.next((m) => m[0] === 'OK' && m[1] === note.id))[3], /^blocked/);
    // NIP-46: an ephemeral signing message reaches a live subscriber and is never kept
    const d = await client(r.port);
    d.send(['REQ', 'nip46', { kinds: [24133], '#p': [b.pk] }]);
    await d.next((m) => m[0] === 'EOSE');
    const msg = sign(a, { kind: 24133, content: 'nip44-request', tags: [['p', b.pk]] });
    c.send(['EVENT', msg]);
    const live = await d.next((m) => m[0] === 'EVENT' && m[1] === 'nip46');
    assert.equal(live[2].id, msg.id);
    assert.ok(!r.events().some((e) => e.kind === 24133), 'ephemeral: not kept');
    d.ws.close();
    // NIP-11
    const info = await (await fetch(`http://127.0.0.1:${r.port}/`, { headers: { accept: 'application/nostr+json' } })).json();
    assert.deepEqual(info.supported_nips, [1, 11, 42, 46, 47, 58, 65, 78]);
  } finally { c.ws.close(); await r.close(); }
});
