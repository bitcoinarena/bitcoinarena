// kanban #1489 v1-refute-22 helpers (#1513 relay quotas)
import WebSocket from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
export const hex = (b) => Buffer.from(b).toString('hex');
export const key = () => { const s = schnorr.utils.randomSecretKey(); return { s, pub: hex(schnorr.getPublicKey(s)) }; };
export const ev = (k, { kind = 8, at = Math.floor(Date.now() / 1000), tags = [], content = 'x' } = {}) => {
  const e = { pubkey: k.pub, created_at: at, kind, tags, content };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.s));
  return e;
};
export const open = async (port) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((x) => ws.on('open', x)); return ws; };
export const ask = (ws, m, until) => new Promise((x) => { const got = []; const h = (raw) => { const a = JSON.parse(String(raw)); got.push(a); if (until(a)) { ws.off('message', h); x(got); } }; ws.on('message', h); ws.send(JSON.stringify(m)); });
// sends events, a fresh socket every 50 (each socket's budget is 60); answers the OK messages
export async function publish(port, events, socks) {
  const oks = [];
  for (let i = 0; i < events.length; i += 50) {
    const ws = await open(port); socks.push(ws);
    for (const e of events.slice(i, i + 50)) oks.push((await ask(ws, ['EVENT', e], (m) => m[0] === 'OK'))[0]);
  }
  return oks;
}
