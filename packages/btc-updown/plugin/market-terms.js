// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOIN UP OR DOWN'S MARKET, AS ITS OWN PACKAGE DEFINES IT (kanban #568: it was in the Arena's test fixture arena-node/test/plugins/updown,
// which now takes it from here): Polymarket's BTC Up or Down 15m as a Bitcoin Arena market - one round per UTC quarter hour (its manifest's
// period, 900 000 ms), its terms, its attestors' words and every client version the manifests pin, by hash.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const UPDOWN_PERIOD_MS = 900000n;
export const UPDOWN_TERMS = Object.freeze({
  nodeFeeBps: 50, donationBps: 50,
  question: 'Will BTC/USD be at or above, at the end of this 15-minute window, the price at its start?',
  resolveAfterCloseMs: 0n, deadlineAfterResolveMs: 600000n,
  sourceRule: 'Each attestor reads BTC/USD every 10 s from three public exchanges (A, B: Coinbase, Kraken, Bitstamp; C: Gemini, '
    + 'Coinbase, Kraken) and keeps the median in whole cents. The price to beat is the time-weighted average of the readings over '
    + 'the 60 s before the window\'s start; the end price is the same 60 s average before its end. Up if end price >= price to '
    + 'beat (a tie is Up), else Down. Signed at the window\'s end (observed_at = the window\'s end); 2 of 3 attestors.',
});
// the attestors' words, in the order A, B, C (the manifest lists their keys sorted)
export const UPDOWN_ATTESTOR_WORDS = Object.freeze(['updown attestor A', 'updown attestor B', 'updown attestor C']);
// THE MARKET'S OWN CLIENT (kanban #237 step 2), pinned by its hash: the Arena page runs only these bytes for this market
// The bytes manifests v1 (672415c8) and v2 (f5f3f187) pin are kept as client/index-v2.html; client/index.html is the newest
// client, version 3's (kanban #388: the back button on its own row, the title on its own line, as Rock Paper Scissors')
export const UPDOWN_CLIENT_FILE = new URL('../client/index-v2.html', import.meta.url);
export const UPDOWN_CLIENT_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_FILE)).digest();
// version 3's client (#388) is kept as client/index-v3.html; version 4's ("← Arena", kanban #396) as client/index-v4.html;
// version 5's (an order's progress in the sheet, a joinable window first - kanban #438) as client/index-v5.html; client/index.html is
// version 6's (My orders as cards - kanban #443) as client/index-v6.html; client/index.html is version 7's (the history: closed orders
// with what they won or lost, pending through the 10-minute objection window, and the totals - kanban #447) as client/index-v7.html;
// version 8's (the desktop view as an exchange: chart or depth and the full order book - kanban #448) as client/index-v8.html;
// version 9's (past orders kept in the browser: round, side, stake, result, P/L - a table on a desktop - kanban #447) as
// client/index-v9.html; version 10's (its history logic in one block a test runs - kanban #450) as client/index-v10.html;
// version 11's (the History totals in one short line on a phone - kanban #453) as client/index-v11.html; client/index.html is version
// 12's (the amount: − / + steps, 100 sats by default, the last amount kept in the browser - kanban #456)
export const UPDOWN_CLIENT_V3_FILE = new URL('../client/index-v3.html', import.meta.url);
export const UPDOWN_CLIENT_V3_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V3_FILE)).digest();
export const UPDOWN_CLIENT_V4_FILE = new URL('../client/index-v4.html', import.meta.url);
export const UPDOWN_CLIENT_V4_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V4_FILE)).digest();
export const UPDOWN_CLIENT_V5_FILE = new URL('../client/index-v5.html', import.meta.url);
export const UPDOWN_CLIENT_V5_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V5_FILE)).digest();
export const UPDOWN_CLIENT_V6_FILE = new URL('../client/index-v6.html', import.meta.url);
export const UPDOWN_CLIENT_V6_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V6_FILE)).digest();
export const UPDOWN_CLIENT_V7_FILE = new URL('../client/index-v7.html', import.meta.url);
export const UPDOWN_CLIENT_V7_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V7_FILE)).digest();
export const UPDOWN_CLIENT_V8_FILE = new URL('../client/index-v8.html', import.meta.url);
export const UPDOWN_CLIENT_V8_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V8_FILE)).digest();
export const UPDOWN_CLIENT_V9_FILE = new URL('../client/index-v9.html', import.meta.url);
export const UPDOWN_CLIENT_V9_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V9_FILE)).digest();
export const UPDOWN_CLIENT_V10_FILE = new URL('../client/index-v10.html', import.meta.url);
export const UPDOWN_CLIENT_V10_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V10_FILE)).digest();
export const UPDOWN_CLIENT_V11_FILE = new URL('../client/index-v11.html', import.meta.url);
export const UPDOWN_CLIENT_V11_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V11_FILE)).digest();
export const UPDOWN_CLIENT_V12_FILE = new URL('../client/index-v12.html', import.meta.url);
export const UPDOWN_CLIENT_V12_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V12_FILE)).digest();
// version 13 (kanban #454): the fee line as the market's terms name it - 0.4 % nodes + 0.4 % donation + 0.2 % protocol reserve
export const UPDOWN_CLIENT_V13_FILE = new URL('../client/index-v13.html', import.meta.url);
export const UPDOWN_CLIENT_V13_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V13_FILE)).digest();
// version 14 (kanban #461): a phone's Compact / Advanced switch - Advanced shows the exchange (chart or depth, the full order book)
export const UPDOWN_CLIENT_V14_FILE = new URL('../client/index-v14.html', import.meta.url);
export const UPDOWN_CLIENT_V14_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V14_FILE)).digest();
// version 15 (the owner 2026-10-20: "In the history and pending always display the date of the bet"): every order's round reads as its
// day and window, "20 Oct · 20:45–21:00 UTC"
export const UPDOWN_CLIENT_V15_FILE = new URL('../client/index.html', import.meta.url);
export const UPDOWN_CLIENT_V15_HASH = createHash('sha256').update(readFileSync(UPDOWN_CLIENT_V15_FILE)).digest();
