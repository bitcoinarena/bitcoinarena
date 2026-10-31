// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET TRIED ON THE NODE (kanban #920): the check, the reads as this node makes them, the code in its sandbox. The owner's form calls it, and the draft
// costs nothing. Sockets are read briefly here; a round reads them for their whole time.
import { checkMarketCode } from '../../arena-protocol/src/market-check.js';
import { readMarketSources } from './market-reader.js';
import { runMarketCode } from './market-sandbox.js';

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
