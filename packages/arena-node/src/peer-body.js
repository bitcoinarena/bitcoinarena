// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PEER'S ANSWER, READ UP TO A CAP (kanban #1550, #1685, #1870, #1901): every pull from another seat has a deadline (the fetch's own
// signal, which bounds the body read too) and a size cap. A bare r.json() or r.arrayBuffer() buffers whatever the peer sends inside
// the deadline - one seat streamed 96 MiB of /api/round-result in about 420 ms, on every finality pass of a head-to-head close. The body
// is read chunk by chunk and the read stops, the connection dropped, as soon as it passes `cap`. Shared by verify.js, entry-relay.js and
// server.js so that no peer pull reads without one.

/** The body of a peer's answer, at most `cap` bytes; throws past the cap (a peer that answers too much proves nothing). */
export async function peerBody(answer, cap) {
  if (!(cap > 0)) throw new Error('peerBody needs a cap');
  const declared = Number(answer.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) { try { await answer.body?.cancel(); } catch { /* gone */ } throw new Error(`answer of ${declared} bytes is past ${cap}`); }
  if (!answer.body) return new Uint8Array(0);
  const parts = []; let n = 0;
  for await (const chunk of answer.body) {
    n += chunk.length;
    if (n > cap) { try { await answer.body.cancel(); } catch { /* gone */ } throw new Error(`answer past ${cap} bytes`); }
    parts.push(chunk);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const c of parts) { out.set(c, at); at += c.length; }
  return out;
}

/** A peer's JSON answer, at most `cap` bytes. */
export async function peerJsonUpTo(answer, cap) { return JSON.parse(Buffer.from(await peerBody(answer, cap)).toString('utf8')); }
