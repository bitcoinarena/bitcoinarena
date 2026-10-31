// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET TRIED ON THE NODE (kanban #920): the check, the reads as this node makes them, the code in its sandbox. The owner's form calls it, and the draft
// costs nothing. Sockets are read briefly here; a round reads them for their whole time.
import { checkMarketCode } from '../../arena-protocol/src/market-check.js';
import { readMarketSources } from './market-reader.js';
import { runMarketCode } from './market-sandbox.js';
import { MARKET_SOURCE_KIND } from '../../arena-protocol/src/manifest.js';
import { codeOfSource } from '../../arena-protocol/src/market-rule.js';

const SOCKET_TRY = { most: 5, waitMs: 5000 };

export async function testMarket({ reads = [], code = '', market = {} }, { parse = null, read = readMarketSources, run = runMarketCode } = {}) {
  const started = Date.now();
  const got = await read(reads, { socket: SOCKET_TRY });
  if (got.why) return { ok: false, stage: 'read', why: got.why };
  if (!code) return { ok: true, reads: got.reads, ms: Date.now() - started };
  const acorn = parse || (await import('acorn')).parse;
  const check = checkMarketCode(code, acorn);
  if (!check.ok) return { ok: false, stage: 'check', check };
  const out = await run({ code, reads: got.reads, market });
  return out.ok ? { ok: true, out: out.out, reads: got.reads, check, ms: Date.now() - started } : { ok: false, stage: 'run', why: out.why };
}

/** A MARKET'S RESULT ON THIS NODE (kanban #920): its reads, its code checked here again, its run in the sandbox. Answers { ok, out } or { ok: false, why }. */
export async function runSourceOnce(source, market, { parse = null, read = readMarketSources, run = runMarketCode } = {}) {
  if (source.kind === MARKET_SOURCE_KIND.CODE) {
    const check = checkMarketCode(source.code, parse || (await import('acorn')).parse);
    if (!check.ok) return { ok: false, why: `the code fails its check: ${check.problems[0].why}` };
  }
  const got = await read(source.reads.map((r) => ({ id: r.id, kind: r.socket ? 'ws' : 'http', url: r.url, subscribe: r.subscribe })));
  if (got.why) return { ok: false, why: got.why };
  return run({ code: codeOfSource(source), reads: got.reads, market });
}
