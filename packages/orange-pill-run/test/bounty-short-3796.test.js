// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3796 (owner 2026-11-26: "Wenn beide gecheckt sind und der Entry valide, nur noch die Kurzfassung ... Es ist zu voll"): one short line once set up.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bountyShort } from "../client/src/screens.js";

const main = readFileSync(new URL("../client/src/main.js", import.meta.url), "utf8");

test("#3796 X checked + Lightning saved -> one short line; anything missing -> the full box", () => {
  assert.deepEqual(bountyShort({ x: { username: "alice", follows: true }, placed: true, lnAddress: "alice@wallet.com" }, 2500),
    { text: "✓ You're eligible for today's 2,500 sat prize", who: "@alice · ⚡ alice@wallet.com" });
  assert.equal(bountyShort({ x: { username: "alice" }, placed: true }), null);                                   // no Lightning address
  assert.equal(bountyShort({ x: { username: "bob", follows: false }, placed: false, lnAddress: "b@w.com" }), null);   // does not follow
  assert.equal(bountyShort({ lnAddress: "b@w.com" }), null);                                                     // no X
  assert.equal(bountyShort(null), null);
  assert.doesNotMatch(bountyShort({ x: { username: "a" }, placed: true, lnAddress: "a@w.com" }).text, /draw/i);   // the day's best run wins
});

test("#3796 the short line only inside the box of a run that counts; Change opens the full box", () => {
  assert.match(main, /paintBounty\(m === "play" && !!run && !!api && !!S\.me && !!after,/);
  assert.match(main, /const short = !BB\.open && !XF\.r\.dirty && !LN\.r\.dirty/);
});
