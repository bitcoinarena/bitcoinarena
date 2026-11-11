// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN LNURL ANSWER IS READ ONLY UP TO A SMALL LIMIT (kanban #1562). A winner's Lightning address, a donation recipient's LNURL and a
// reserve proposal's LNURL are servers anyone runs; every seat of a committee asks them at the same moment. Response.json() reads
// the whole body, so one endpoint streaming hundreds of MB within the 15 s bound ran every seat out of memory at settlement. A
// pay request and its callback's answer are a few KB (LUD-06): the body is read as a stream, counted, and refused - the reader
// cancelled - once it passes LNURL_MAX_BYTES; a content-length over the limit is refused before a byte is read.

/** The most of an LNURL answer a seat reads (kanban #1562): LUD-06 pay requests and invoices are a few KB. */
export const LNURL_MAX_BYTES = 64 * 1024;

/** The JSON of `res`, read to at most `maxBytes` of its body; throws past that. A test's own object with no body stream is read by its json(). */
export async function readJsonBounded(res, maxBytes = LNURL_MAX_BYTES) {
  const body = res && res.body;
  if (!body || typeof body.getReader !== 'function') return res.json();
  const said = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(said) && said > maxBytes) {
    try { await body.cancel(); } catch { /* already gone */ }
    throw new Error(`the answer is ${said} bytes, over the ${maxBytes} an LNURL answer may be`);
  }
  const reader = body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      try { await reader.cancel(); } catch { /* already gone */ }
      throw new Error(`the answer passed the ${maxBytes} bytes an LNURL answer may be`);
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return JSON.parse(new TextDecoder().decode(all));
}
