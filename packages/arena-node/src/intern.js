// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SAME VALUE, ONE OBJECT (kanban #927, a heap snapshot of a seat 2026-11-01: 1.14 M Uint8Arrays and 1.94 M 64-hex strings of 783 MB). Every open round keeps its decoded
// contract, and nearly all of a contract's fields are the same in every round of a series: 18,000 contracts held 18,000 copies each of the network id, the config hash, the
// census root, the nine node keys. A seat sat at its heap limit, the collector took half a core, and seat 1 died of it after 10.7 h. A decoded contract is shared and never
// changed (Round.contractOf), so equal values can be one object. Bounded: past `most` values the table starts again, which only loses sharing, never a value.
const MOST = 8192;

export function createInterner({ most = MOST } = {}) {
  let bytes = new Map(), texts = new Map();
  const shareBytes = (u) => {
    const k = Buffer.from(u.buffer, u.byteOffset, u.byteLength).latin1Slice();
    const had = bytes.get(k);
    if (had) return had;
    if (bytes.size >= most) bytes = new Map();
    bytes.set(k, u);
    return u;
  };
  const shareText = (s) => {
    const had = texts.get(s);
    if (had !== undefined) return had;
    if (texts.size >= most) texts = new Map();
    texts.set(s, s);
    return s;
  };
  const share = (v) => {
    if (v instanceof Uint8Array) return v.byteLength <= 128 ? shareBytes(v) : v;
    if (typeof v === 'string') return v.length <= 256 ? shareText(v) : v;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = share(v[i]); return v; }
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) { for (const k of Object.keys(v)) v[k] = share(v[k]); return v; }
    return v;
  };
  return { share, shareText, sizes: () => ({ bytes: bytes.size, texts: texts.size }) };
}
