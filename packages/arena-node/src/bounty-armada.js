// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ARMADA COMMUNITY MEMBERSHIP FOR THE BUG-BOUNTY SOCIAL BONUS (kanban #2641), read-only. Armada (armada.buzz) keeps a community's member list in
// its "Concord" guestbook: NIP-59-style wraps (kind 1059) authored by the guestbook stream key, each holding a seal (kind 20013, signed by the
// member) whose rumor is a join/leave (3306), a kick (3309) or a member snapshot (3312). The stream key is derived from the community root, a random
// secret only members hold; the owner keeps it in its own community list (kind 33302, NIP-44 encrypted to itself). So the owner key reads:
//   33302 (author = owner) -> decrypt -> entry { community_id, owner, owner_salt, community_root, root_epoch, held_roots }
//   guestbook stream per held root: sk = HKDF-SHA256(ikm = root, info = "concord/guestbook" 0x00 community_id u64be(epoch)) (scalar retry)
//   1059 (authors = stream pks) -> NIP-44 v2 (conversation key of the stream with itself) -> seal 20013 -> same key -> rumor
// and folds the rumors the way the Armada client does (last state per key wins; kicks and snapshots only from the owner/refounder).
// Nothing is ever published: the relay code sends only REQ and CLOSE. A relay asking for NIP-42 AUTH is reported, never answered.
// Secrets come in as arguments and never reach an answer, a log line or an error text.
import { readFileSync } from 'node:fs';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf, extract as hkdfExtract, expand as hkdfExpand } from '@noble/hashes/hkdf.js';

export const ARMADA_RELAYS = ['wss://relay.ditto.pub', 'wss://relay.dreamith.to'];
const HEX64 = /^[0-9a-f]{64}$/;
const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: true });
const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
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
function key32(input, prefix) {
  const s = String(input || '').trim();
  if (HEX64.test(s.toLowerCase())) return s.toLowerCase();
  const d = bech32Decode(s);
  return d && d.prefix === prefix && d.bytes.length === 32 ? hex(d.bytes) : null;
}
export const secretKeyHexOf = (input) => key32(input, 'nsec');
export const pubkeyOf = (skHex) => hex(schnorr.getPublicKey(unhex(skHex)));

// ---- ChaCha20 (RFC 8439), NIP-44 v2 ----
function chacha20(key, nonce, data) {
  const k = new Uint32Array(8), n = new Uint32Array(3), kv = new DataView(key.buffer, key.byteOffset, 32), nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
  for (let i = 0; i < 8; i++) k[i] = kv.getUint32(4 * i, true);
  for (let i = 0; i < 3; i++) n[i] = nv.getUint32(4 * i, true);
  const out = new Uint8Array(data.length), x = new Uint32Array(16), s = new Uint32Array(16), ks = new Uint8Array(64), kd = new DataView(ks.buffer);
  const r = (v, c) => (v << c) | (v >>> (32 - c));
  const q = (a, b, c, d) => { x[a] += x[b]; x[d] = r(x[d] ^ x[a], 16); x[c] += x[d]; x[b] = r(x[b] ^ x[c], 12); x[a] += x[b]; x[d] = r(x[d] ^ x[a], 8); x[c] += x[d]; x[b] = r(x[b] ^ x[c], 7); };
  for (let off = 0, ctr = 0; off < data.length; off += 64, ctr++) {
    s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574, ...k, ctr, ...n]); x.set(s);
    for (let i = 0; i < 10; i++) { q(0, 4, 8, 12); q(1, 5, 9, 13); q(2, 6, 10, 14); q(3, 7, 11, 15); q(0, 5, 10, 15); q(1, 6, 11, 12); q(2, 7, 8, 13); q(3, 4, 9, 14); }
    for (let i = 0; i < 16; i++) kd.setUint32(4 * i, (x[i] + s[i]) >>> 0, true);
    for (let i = 0; i < 64 && off + i < data.length; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}
export function conversationKey(skHex, pkHex) {
  const shared = secp256k1.getSharedSecret(unhex(skHex), unhex(`02${pkHex}`)).subarray(1, 33);
  return hkdfExtract(sha256, shared, te.encode('nip44-v2'));
}
function messageKeys(ck, nonce) { const k = hkdfExpand(sha256, ck, nonce, 76); return { ck: k.subarray(0, 32), cn: k.subarray(32, 44), hk: k.subarray(44, 76) }; }
function paddedLen(n) { if (n <= 32) return 32; const np = 1 << (Math.floor(Math.log2(n - 1)) + 1); const ch = np <= 256 ? 32 : np / 8; return ch * (Math.floor((n - 1) / ch) + 1); }
export function nip44Decrypt(payload, ck) {
  const d = Uint8Array.from(Buffer.from(String(payload), 'base64'));
  if (d.length < 99 || d[0] !== 2) throw new Error('nip44: bad payload');
  const nonce = d.subarray(1, 33), ct = d.subarray(33, d.length - 32), mac = d.subarray(d.length - 32);
  const { ck: k, cn, hk } = messageKeys(ck, nonce);
  const want = hmac(sha256, hk, cat(nonce, ct)); let diff = 0;
  for (let i = 0; i < 32; i++) diff |= want[i] ^ mac[i];
  if (diff) throw new Error('nip44: bad mac');
  const p = chacha20(k, cn, ct), len = (p[0] << 8) | p[1];
  if (len < 1 || 2 + len > p.length || p.length !== 2 + paddedLen(len)) throw new Error('nip44: bad padding');
  return td.decode(p.subarray(2, 2 + len));
}
export function nip44Encrypt(text, ck, nonce = crypto.getRandomValues(new Uint8Array(32))) {
  const m = te.encode(text); if (m.length < 1 || m.length > 65535) throw new Error('nip44: bad length');
  const p = new Uint8Array(2 + paddedLen(m.length)); p[0] = m.length >> 8; p[1] = m.length & 255; p.set(m, 2);
  const { ck: k, cn, hk } = messageKeys(ck, nonce), ct = chacha20(k, cn, p);
  return Buffer.from(cat(Uint8Array.of(2), nonce, ct, hmac(sha256, hk, cat(nonce, ct)))).toString('base64');
}

// ---- events ----
export const eventId = (e) => hex(sha256(te.encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
export function signEvent(e, skHex) { // tests only: the module itself never signs anything that leaves the process
  const ev = { kind: e.kind, content: e.content, tags: e.tags || [], created_at: e.created_at, pubkey: pubkeyOf(skHex) };
  ev.id = eventId(ev); ev.sig = hex(schnorr.sign(unhex(ev.id), unhex(skHex))); return ev;
}
function sigOk(e) { try { return typeof e.sig === 'string' && eventId(e) === e.id && schnorr.verify(unhex(e.sig), unhex(e.id), unhex(e.pubkey)); } catch { return false; } }

// ---- Concord key derivation (the Armada client's jn/Cn/z) ----
const N = secp256k1.Point.CURVE().n;
function infoOf(label, id, n) {
  const l = te.encode(label), a = new Uint8Array(l.length + 1 + 32 + (n === undefined ? 0 : 8));
  a.set(l, 0); a.set(id, l.length + 1); if (n !== undefined) new DataView(a.buffer).setBigUint64(l.length + 33, BigInt(n), false); return a;
}
function scalarFrom(ikm, info) {
  const ok = (k) => { const v = BigInt(`0x${hex(k)}`); return v > 0n && v < N; };
  let k = hkdf(sha256, ikm, new Uint8Array(0), info, 32); if (ok(k)) return k;
  for (let i = 0; i <= 255; i++) { k = hkdf(sha256, ikm, new Uint8Array(0), cat(info, Uint8Array.of(i)), 32); if (ok(k)) return k; }
  throw new Error('scalar rejection');
}
export function streamKey(label, secretHex, idHex, n) {
  const sk = hex(scalarFrom(unhex(secretHex), infoOf(label, unhex(idHex), n))), pk = pubkeyOf(sk);
  return { sk, pk, convKey: conversationKey(sk, pk) };
}
export const guestbookStream = (rootHex, idHex, epoch) => streamKey('concord/guestbook', rootHex, idHex, epoch);
export const communityIdOf = (ownerHex, saltHex) => hex(sha256(cat(te.encode('concord/community'), unhex(ownerHex), unhex(saltHex))));

// ---- the owner's community list (kind 33302, legacy 13302) ----
// 32-byte fields are stored as unpadded base64url in the list fragments (hex in older ones)
export function k32(v) {
  if (typeof v !== 'string') return undefined;
  if (HEX64.test(v.toLowerCase())) return v.toLowerCase();
  if (!/^[A-Za-z0-9_-]{43}$/.test(v)) return undefined;
  const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/') + '=', 'base64'); return b.length === 32 ? hex(b) : undefined;
}
export function communityEntries(listEvents, skHex) {
  const own = pubkeyOf(skHex), ck = conversationKey(skHex, own), byD = new Map(), out = new Map();
  for (const e of listEvents) {
    if (e.pubkey !== own || (e.kind !== 33302 && e.kind !== 13302)) continue;
    const d = e.kind === 13302 ? 'legacy' : ((e.tags.find((t) => t[0] === 'd') || [])[1] ?? '');
    const o = byD.get(d); if (!o || e.created_at > o.created_at) byD.set(d, e);
  }
  for (const e of byD.values()) {
    let j; try { j = JSON.parse(nip44Decrypt(e.content, ck)); } catch { continue; }
    for (const en of Array.isArray(j && j.entries) ? j.entries : []) {
      const raw = en && en.current; if (!raw || typeof raw !== 'object') continue;
      const c = { ...raw, community_id: k32(en.community_id ?? raw.community_id), owner: k32(raw.owner), owner_salt: k32(raw.owner_salt), community_root: k32(raw.community_root), refounder: k32(raw.refounder) };
      if (!c.community_id || !c.community_root || !c.owner || !c.owner_salt || !Number.isSafeInteger(raw.root_epoch)) continue;
      if (communityIdOf(c.owner, c.owner_salt) !== c.community_id) continue;
      const roots = [{ epoch: BigInt(c.root_epoch), key: c.community_root, refounder: c.refounder }];
      for (const h of Array.isArray(raw.held_roots) ? raw.held_roots : []) { try { const k = k32(h.key), ep = BigInt(h.epoch); if (k && !roots.some((r) => r.epoch === ep)) roots.push({ epoch: ep, key: k, refounder: k32(h.refounder) }); } catch { /* skip */ } }
      const sd = en.seed; if (sd && k32(sd.community_root)) { try { const ep = BigInt(sd.root_epoch); if (!roots.some((r) => r.epoch === ep)) roots.push({ epoch: ep, key: k32(sd.community_root), refounder: k32(sd.refounder) }); } catch { /* skip */ } }
      const id = c.community_id, prev = out.get(id);
      if (!prev || BigInt(c.root_epoch) > prev.rootEpoch) out.set(id, { id, owner: c.owner, name: typeof c.name === 'string' ? c.name : '', rootEpoch: BigInt(c.root_epoch), roots, relays: Array.isArray(raw.relays) ? raw.relays.filter((r) => typeof r === 'string' && /^wss?:\/\//.test(r)) : [], refounder: c.refounder, controlPk: k32(raw.control_pk) });
    }
  }
  return [...out.values()];
}

// ---- unwrap and fold the guestbook ----
export function unwrap(wrap, stream) {
  if (wrap.kind !== 1059 && wrap.kind !== 21059) throw new Error('not a wrap');
  if (wrap.pubkey !== stream.pk) throw new Error('wrap author is not the stream');
  const seal = JSON.parse(nip44Decrypt(wrap.content, stream.convKey));
  if (seal.kind !== 20013 && seal.kind !== 20014) throw new Error('bad seal kind');
  if (!sigOk(seal)) throw new Error('bad seal signature');
  const r = JSON.parse(seal.kind === 20013 ? nip44Decrypt(seal.content, stream.convKey) : seal.content);
  if (r.pubkey !== seal.pubkey) throw new Error('rumor author is not the sealer');
  if (eventId(r) !== r.id) throw new Error('bad rumor id');
  const msTag = (r.tags || []).find((t) => t[0] === 'ms'), ms = r.created_at * 1000 + (msTag && /^(0|[1-9][0-9]{0,2})$/.test(msTag[1]) ? Number(msTag[1]) : 0);
  return { rumorId: r.id, author: seal.pubkey, kind: r.kind, content: r.content, tags: r.tags || [], ms, streamPk: wrap.pubkey, sealKind: seal.kind };
}
const tag1 = (tags, k) => { const v = tags.filter((t) => t.length >= 2 && t[0] === k); return v.length === 1 ? v[0][1] : undefined; };
function snapTag(tags) {
  const t = tags.filter((x) => x.length >= 4 && x[0] === 'snap'); if (t.length !== 1 || !HEX64.test(String(t[0][1]).toLowerCase())) return null;
  const i = Number(t[0][2]), n = Number(t[0][3]); return Number.isInteger(i) && Number.isInteger(n) && i >= 1 && i <= n ? { id: t[0][1].toLowerCase(), i, n } : null;
}
// rumors: unwrapped guestbook rumors of every held stream; ctx: { owner, livePk, authorityOf: Map(streamPk -> refounder/owner), kickers: Set, nowMs }
export function foldMembers(rumors, ctx) {
  const now = ctx.nowMs ?? Date.now(), kickers = ctx.kickers || new Set([ctx.owner]), states = [];
  for (const r of rumors) {
    if (r.ms > now + 3600000 || (r.sealKind !== undefined && r.sealKind !== 20013)) continue;
    if (r.kind === 3306 && (r.content === 'join' || r.content === 'leave')) states.push({ pubkey: r.author, state: r.content, ms: r.ms, rumorId: r.rumorId, snap: false, via: r.content });
    else if (r.kind === 3309) { const p = String(tag1(r.tags, 'p') || '').toLowerCase(); if (HEX64.test(p) && kickers.has(r.author)) states.push({ pubkey: p, state: 'kick', ms: r.ms, rumorId: r.rumorId, snap: false, via: 'kick' }); }
    else if (r.kind === 3312 && snapTag(r.tags)) {
      const auth = ctx.authorityOf && r.streamPk ? ctx.authorityOf.get(r.streamPk) : undefined;
      if ((auth ? auth !== r.author : r.author !== ctx.owner)) continue;
      let list = []; try { list = JSON.parse(r.content); } catch { /* skip */ }
      for (const p of Array.isArray(list) ? list : []) if (typeof p === 'string' && HEX64.test(p.toLowerCase())) states.push({ pubkey: p.toLowerCase(), state: 'join', ms: r.ms, rumorId: r.rumorId, snap: true, via: 'snapshot' });
    }
  }
  const last = new Map();
  for (const s of states) {
    const e = last.get(s.pubkey);
    if (!e || s.ms > e.ms || (s.ms === e.ms && (e.snap === s.snap ? s.rumorId < e.rumorId : e.snap))) last.set(s.pubkey, s);
  }
  // a refounder's complete snapshot on the live stream cuts every join before it that the snapshot left out
  const refounder = ctx.authorityOf && ctx.livePk ? ctx.authorityOf.get(ctx.livePk) : undefined;
  if (refounder) {
    const parts = new Map();
    for (const r of rumors) {
      const sn = r.kind === 3312 && r.streamPk === ctx.livePk && r.author === refounder ? snapTag(r.tags) : null; if (!sn) continue;
      const a = parts.get(sn.id) || { held: new Set(), n: 0, evs: [] }; a.held.add(sn.i); a.n = Math.max(a.n, sn.n); a.evs.push(r); parts.set(sn.id, a);
    }
    let whole = parts.size > 0; for (const { held, n } of parts.values()) for (let i = 1; i <= n; i++) if (!held.has(i)) whole = false;
    if (whole) {
      const base = new Set(); let cut;
      for (const { evs } of parts.values()) for (const r of evs) { let l = []; try { l = JSON.parse(r.content); } catch { /* skip */ } for (const p of Array.isArray(l) ? l : []) if (typeof p === 'string') base.add(p.toLowerCase()); if (cut === undefined || r.ms < cut) cut = r.ms; }
      const streamOf = new Map(rumors.map((r) => [r.rumorId, r.streamPk]));
      for (const [pk, s] of last) if (s.state === 'join' && !base.has(pk)) { const sp = streamOf.get(s.rumorId); if (s.ms < cut || (sp !== undefined && sp !== ctx.livePk)) last.set(pk, { ...s, state: 'refounded' }); }
    }
  }
  return last; // pubkey -> { state: join | leave | kick | refounded, ms, via }
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
      if (a[0] === 'EVENT' && a[1] === sub && a[2] && typeof a[2].id === 'string') got.push(a[2]);
      else if (a[0] === 'EOSE' && a[1] === sub) finish();
      else if (a[0] === 'CLOSED' && a[1] === sub) finish(`closed: ${String(a[2] || '').slice(0, 60)}`);
      else if (a[0] === 'AUTH') { if (onNote) onNote(url, 'relay asked for NIP-42 AUTH (not answered)'); }
    };
  });
  return async (relays, filters) => {
    const seen = new Map();
    await Promise.all(relays.flatMap((url) => filters.map(async (f) => {
      let until;
      for (let p = 0; p < maxPages; p++) {
        const page = await one(url, { ...f, limit: Math.min(f.limit || pageLimit, pageLimit), ...(until === undefined ? {} : { until }) });
        let oldest = Infinity; for (const e of page) { seen.set(e.id, e); if (e.created_at < oldest) oldest = e.created_at; }
        if (f.limit || page.length < Math.min(pageLimit, 100) || !Number.isFinite(oldest) || oldest - 1 === until) break;
        until = oldest - 1;
      }
    })));
    return [...seen.values()];
  };
}

// ---- the API ----
export async function armadaPubkeyOf(input, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const s = String(input || '').trim();
  const k = key32(s, 'npub'); if (k) return k;
  const d = bech32Decode(s);
  if (d && d.prefix === 'nprofile') { const b = d.bytes; for (let i = 0; i + 2 <= b.length;) { const ty = b[i], l = b[i + 1]; if (ty === 0 && l === 32) return hex(b.subarray(i + 2, i + 34)); i += 2 + l; } return null; }
  const m = /^([a-z0-9._-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(s);
  if (!m) return null;
  try {
    const r = await fetchFn(`https://${m[2].toLowerCase()}/.well-known/nostr.json?name=${encodeURIComponent(m[1].toLowerCase())}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!r.ok) return null;
    const j = await r.json(), v = j && j.names && j.names[m[1].toLowerCase()];
    return typeof v === 'string' && HEX64.test(v.toLowerCase()) ? v.toLowerCase() : null;
  } catch { return null; }
}

// returns the Set of member pubkeys; with { detail: true } returns { members, states, community, rumors, notes }
export async function armadaMembers({ secretKeyHex, relays = ARMADA_RELAYS, community = {}, query, detail = false, nowMs } = {}) {
  const notes = [];
  const q = query || wsQuery({ onNote: (url, n) => notes.push(`${url}: ${n}`) });
  const sk = secretKeyHexOf(secretKeyHex); if (!sk) throw new Error('armada: no usable owner secret key');
  // community: { id?, name?, author? }. The community's own kind 33301 (d "") is signed by its invite-link key, not by the owner, so `author`
  // narrows the list only when it names an entry's owner; `d` is accepted for the env shape and not needed to read the guestbook.
  const own = pubkeyOf(sk), author = String(community.author || '').toLowerCase();
  const list = await q(relays, [{ kinds: [33302], authors: [own] }, { kinds: [13302], authors: [own], limit: 1 }]);
  let entries = communityEntries(list, sk);
  if (author && entries.some((c) => c.owner === author)) entries = entries.filter((c) => c.owner === author);
  if (community.id) entries = entries.filter((c) => c.id === String(community.id).toLowerCase());
  if (community.name) entries = entries.filter((c) => c.name === community.name);
  if (entries.length !== 1) throw new Error(entries.length === 0 ? `armada: community not in the owner's list (${list.length} list events)` : `armada: ${entries.length} communities match; name one`);
  const c = entries[0];
  const streams = c.roots.map((r) => ({ ...guestbookStream(r.key, c.id, r.epoch), epoch: r.epoch, authority: r.epoch > 0n ? (r.refounder || c.owner) : undefined }));
  const live = streams.find((s) => s.epoch === c.rootEpoch);
  const wraps = await q([...new Set([...relays, ...c.relays])], [{ kinds: [1059], authors: streams.map((s) => s.pk) }]);
  const byPk = new Map(streams.map((s) => [s.pk, s])), rumors = []; let bad = 0;
  for (const w of wraps) { const s = byPk.get(w.pubkey); if (!s) continue; try { rumors.push(unwrap(w, s)); } catch { bad++; } }
  const authorityOf = new Map(streams.filter((s) => s.authority).map((s) => [s.pk, s.authority]));
  const states = foldMembers(rumors, { owner: c.owner, livePk: live && live.pk, authorityOf, nowMs });
  const members = new Set([...states].filter(([, s]) => s.state === 'join').map(([pk]) => pk));
  members.add(c.owner);
  if (!detail) return members;
  return { members, states, community: { id: c.id, name: c.name, owner: c.owner, epochs: c.roots.length, liveEpoch: c.rootEpoch }, wraps: wraps.length, rumors: rumors.length, undecryptable: bad, notes };
}

export function armadaVerifier({ secretKeyHex, relays = ARMADA_RELAYS, community = {}, members = armadaMembers, cacheMs = 60000, query } = {}) {
  let cache = null; // { at, set }
  let inflight = null;
  const load = async () => {
    if (cache && Date.now() - cache.at < cacheMs) return cache.set;
    if (!inflight) inflight = (async () => { try { const set = await members({ secretKeyHex, relays, community, query }); cache = { at: Date.now(), set }; return set; } finally { inflight = null; } })();
    return inflight;
  };
  return async (link) => {
    const pk = String((link && link.userId) || '').toLowerCase();
    if (!HEX64.test(pk)) return { member: null, why: 'not a nostr pubkey' };
    try { const set = await load(); return set.has(pk) ? { member: true, why: 'in the community guestbook' } : { member: false, why: 'not in the community guestbook' }; }
    catch (e) { return { member: null, why: short(e) }; }
  };
}

export function armadaFromEnv(env = process.env, { readFn = (p) => readFileSync(p, 'utf8') } = {}) {
  const f = env.FAUCET_BOUNTY_ARMADA_NSEC_FILE; if (!f) return null;
  let sk; try { sk = secretKeyHexOf(readFn(f)); } catch { return null; }
  if (!sk) return null;
  const relays = String(env.FAUCET_BOUNTY_ARMADA_RELAYS || '').split(',').map((s) => s.trim()).filter((s) => /^wss?:\/\//.test(s));
  const author = String(env.FAUCET_BOUNTY_ARMADA_AUTHOR || '').trim().toLowerCase();
  const community = { ...(HEX64.test(author) ? { author } : {}), d: env.FAUCET_BOUNTY_ARMADA_D ?? '', ...(env.FAUCET_BOUNTY_ARMADA_ID ? { id: env.FAUCET_BOUNTY_ARMADA_ID } : {}), ...(env.FAUCET_BOUNTY_ARMADA_NAME ? { name: env.FAUCET_BOUNTY_ARMADA_NAME } : {}) };
  return armadaVerifier({ secretKeyHex: sk, relays: relays.length ? relays : ARMADA_RELAYS, community });
}
