// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NOSTR READ HELPERS FOR THE BOUNTY CHECKS (kanban #3922: the generic part of the former community-membership module, which the owner removed
// 2026-11-28): NIP-19 bech32 (npub / nprofile), event ids, a test-only signer and a relay reader that sends only REQ and CLOSE. A relay asking
// for NIP-42 AUTH is reported, never answered. Nothing is ever published.
import { createHash } from 'node:crypto';   // kanban #3000
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';

const te = new TextEncoder();
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const short = (e) => String((e && e.message) || e).replace(/[0-9a-f]{64}/gi, '<hex>').replace(/nsec1[0-9a-z]+/gi, '<nsec>').slice(0, 120);

// ---- bech32 (NIP-19 npub / nsec) ----
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(v) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1;
  for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= G[i]; }
  return c >>> 0;
}
export function bech32Decode(str) {
  const s = String(str).trim().toLowerCase(); const p = s.lastIndexOf('1');
  if (p < 1 || s.length > 1000) return null;
  const hrp = s.slice(0, p), d = [];
  for (const ch of s.slice(p + 1)) { const v = B32.indexOf(ch); if (v < 0) return null; d.push(v); }
  if (d.length < 6) return null;
  const pre = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (polymod([...pre, ...d]) !== 1) return null;
  let acc = 0, bits = 0; const out = [];
  for (const v of d.slice(0, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  if (bits >= 5 || ((acc << (8 - bits)) & 255)) return null;
  return { prefix: hrp, bytes: Uint8Array.from(out) };
}
export function bech32Encode(prefix, bytes) {
  const d = []; let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; d.push((acc >> bits) & 31); } }
  if (bits) d.push((acc << (5 - bits)) & 31);
  const pre = [...[...prefix].map((c) => c.charCodeAt(0) >> 5), 0, ...[...prefix].map((c) => c.charCodeAt(0) & 31)];
  const pm = polymod([...pre, ...d, 0, 0, 0, 0, 0, 0]) ^ 1;
  for (let i = 0; i < 6; i++) d.push((pm >>> (5 * (5 - i))) & 31);
  return `${prefix}1${d.map((v) => B32[v]).join('')}`;
}
export const pubkeyOf = (skHex) => hex(schnorr.getPublicKey(unhex(skHex)));

// ---- events ----
export const eventId = (e) => hex(sha256(te.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
export function signEvent(e, skHex) { // tests only: the module itself never signs anything that leaves the process
  const ev = { kind: e.kind, content: e.content, tags: e.tags || [], created_at: e.created_at, pubkey: pubkeyOf(skHex) };
  ev.id = eventId(ev); ev.sig = hex(schnorr.sign(unhex(ev.id), unhex(skHex))); return ev;
}

// ---- relays: REQ / CLOSE only ----
export function wsQuery({ timeoutMs = 8000, WebSocketImpl = globalThis.WebSocket, pageLimit = 500, maxPages = 20, onNote } = {}) {
  const one = (url, filter) => new Promise((resolve) => {
    const got = []; let ws, done = false;
    const sub = `a${Math.random().toString(36).slice(2, 10)}`;
    const finish = (note) => { if (done) return; done = true; clearTimeout(t); try { if (ws.readyState === 1) ws.send(JSON.stringify(['CLOSE', sub])); ws.close(); } catch { /* closed */ } if (note && onNote) onNote(url, note); resolve(got); };
    const t = setTimeout(() => finish('timeout'), timeoutMs);
    try { ws = new WebSocketImpl(url); } catch (e) { finish(short(e)); return; }
    ws.onopen = () => { try { ws.send(JSON.stringify(['REQ', sub, filter])); } catch (e) { finish(short(e)); } };
    ws.onerror = () => finish('socket error');
    ws.onclose = () => finish();
    ws.onmessage = (m) => {
      let a; try { a = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString()); } catch { return; }
      if (!Array.isArray(a)) return;
      // A RELAY'S ANSWER IS READ UP TO THE FILTER'S LIMIT (kanban #3376, audit nostr a6-3-1): one relay ignoring limit:3 streamed 20,000 kind 3
      // events, all kept, then each BIP-340-checked on the faucet's one thread (~27 s). An event the filter did not ask for (another kind or
      // author) is dropped, and at the limit the subscription is closed and the read ends
      if (a[0] === 'EVENT' && a[1] === sub && a[2] && typeof a[2].id === 'string') {
        if (done) return;
        const e = a[2];
        if (Array.isArray(filter.kinds) && !filter.kinds.includes(e.kind)) return;
        if (Array.isArray(filter.authors) && !filter.authors.includes(e.pubkey)) return;
        got.push(e);
        if (Number.isInteger(filter.limit) && filter.limit > 0 && got.length >= filter.limit) finish();
      } else if (a[0] === 'EOSE' && a[1] === sub) finish();
      else if (a[0] === 'CLOSED' && a[1] === sub) finish(`closed: ${String(a[2] || '').slice(0, 60)}`);
      else if (a[0] === 'AUTH') { if (onNote) onNote(url, 'relay asked for NIP-42 AUTH (not answered)'); }
    };
  });
  // kanban #3000: a copy is keyed by all of it (id, signature, content ...), so only byte-equal copies merge
  const copyKey = (e) => { try { return createHash('sha256').update(JSON.stringify(e)).digest('hex'); } catch { return String(e && e.id); } };
  return async (relays, filters) => {
    const seen = new Map();
    let truncated = false;
    await Promise.all(relays.flatMap((url) => filters.map(async (f) => {
      let until;
      for (let p = 0; p < maxPages; p++) {
        const page = await one(url, { ...f, limit: Math.min(f.limit || pageLimit, pageLimit), ...(until === undefined ? {} : { until }) });
        // ONE COPY PER DISTINCT EVENT, NEVER THE LAST ANSWER'S (kanban #3000, audit nostr r2-3): copies were merged by the claimed id, so a relay
        // answering last with a genuine event's id and a broken signature (or garbage content) replaced the copy the other relays sent, and the
        // caller's check then dropped it - a follow or a join erased. Copies that differ are all kept; the caller keeps the ones that check
        let oldest = Infinity; for (const e of page) { seen.set(copyKey(e), e); if (e.created_at < oldest) oldest = e.created_at; }
        if (f.limit || page.length < Math.min(pageLimit, 100) || !Number.isFinite(oldest) || oldest - 1 === until) break;
        until = oldest - 1;
        // kanban #2999: the last page was full and more are left - what this read holds is only the newest part
        if (p === maxPages - 1) truncated = true;
      }
    })));
    const out = [...seen.values()];
    // A READ CUT SHORT SAYS SO (kanban #2999, audit nostr r2-2): a flood of newer events pushed every earlier one past the page
    // budget, and the caller read an answer that was only the newest part
    Object.defineProperty(out, 'truncated', { value: truncated });
    return out;
  };
}
