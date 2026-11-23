// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 c1603-refute-0 skeptic 3, 1: A SECOND COPY OF THE ENTRY SENDER LEFT UNSIGNED.
// #1603 and #2001 made every seat refuse an entry not signed by its player key and its session key (403 at POST /entry), and say
// "every regtest/probe harness that posts an entry now sign it". tools/funding-regtest.mjs (the §27A funding-signal harness) still
// POSTs encodeEntryContract(entry) of a bare entry - no playerSig, no sessionSig - so every seat answers 403 and the harness throws
// "entry not taken" on its first round: the measured path for the funding signal is broken by the fix.
// The check: every tool that POSTs an entry's bytes to /entry builds them through a signer (entry-sign.mjs / window-fixture.js
// signedEntryBytes, signedByPlayer, sessionSigned, signEntry/signEntrySession, entrySignedNow/entrySessionSignedNow).
// Adapted to 1.9 by #2536 (kanban #2034): the #1603 / #2001 player-signed entry never reached 1.9 (280a4a912: "The #1603 player signature
// did not reach 1.9"): its entry contract carries no player or session signature (no entryPlayerSigned / entrySigned in contracts.js) and
// no seat refuses a bare entry - every 1.9 fixture posts encodeEntryContract(entry) bare and is taken 201. So funding-regtest.mjs's entry
// is the 1.9 entry, not one every seat refuses. The check stays armed: once the entry contract carries the signature, every tool must sign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const TOOLS = new URL('../tools/', import.meta.url).pathname;
const SIGNS = /signedEntryBytes|signedByPlayer|sessionSigned|signEntrySession|signEntry\(|entrySignedNow|entrySessionSignedNow|signedEntry\(/;

const CONTRACTS = readFileSync(new URL('../../arena-protocol/src/contracts.js', import.meta.url), 'utf8');
const SIGNED_ENTRIES = /export function (entryPlayerSigned|entrySigned|signEntry)\b/.test(CONTRACTS);

test('#2034 (1.9) #1489-c1603-refute-0-s3-1 every tool that posts an entry to the seats signs it by its player and session keys', () => {
  const unsigned = [];
  for (const f of readdirSync(TOOLS).filter((x) => /\.m?js$/.test(x))) {
    const src = readFileSync(TOOLS + f, 'utf8');
    const posts = /\/entry`[^)]*method:\s*'POST'[^)]*body:\s*encodeEntryContract\(/.test(src);
    if (posts && !SIGNS.test(src)) unsigned.push(f);
  }
  console.log('  FACTS #1489-c1603-refute-0-s3-1:', JSON.stringify({ signedEntries: SIGNED_ENTRIES, unsigned }));
  if (!SIGNED_ENTRIES) return;   // 1.9: a bare entry is the entry every seat takes
  assert.deepEqual(unsigned, [], `these tools post bare entries every seat now refuses 403: ${unsigned.join(', ')}`);
});
