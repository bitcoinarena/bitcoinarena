// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3328 (owner 2026-11-22): until when the promotion runs; no error-looking "No Lightning Address"; an inline X handle field checked on the server,
// never the page's My feedback dialog from the game.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { introModel, prizeLine, promoLine, xHandleOf, xFieldModel, xSaveAnswer } from "../client/src/screens.js";

const round = (o = {}) => ({ id: "2026-11-23", number: 1, test: false, phase: "open", startMs: Date.parse("2026-11-23T00:00:00Z"), endMs: Date.parse("2026-11-24T00:00:00Z"),
  entrySats: 0, maxAttempts: 5, split: [50, 30, 20], potSats: 0, bountySats: 5000, best: null, ...o });
const PROMO = { firstDay: "2026-11-23", endMs: Date.parse("2026-11-30T00:00:00Z") };

test("#3328 the promotion line: the days and the end, only when the service names one; ended after it", () => {
  assert.equal(promoLine(round({ promo: PROMO }), Date.parse("2026-11-24T10:00:00Z")), "Daily bounty 23–29 Nov · until 29 Nov, 24:00 UTC");
  assert.equal(promoLine(round({ promo: PROMO }), Date.parse("2026-11-30T00:00:00Z")), "The daily bounty ended on 29 Nov");
  assert.equal(promoLine(round({ promo: { firstDay: "2026-11-23", endMs: Date.parse("2026-12-02T12:00:00Z") } }), Date.parse("2026-11-24T00:00:00Z")), "Daily bounty 23 Nov – 2 Dec · until 2 Dec, 12:00 UTC");
  assert.equal(promoLine(round(), Date.parse("2026-11-24T00:00:00Z")), null);
  assert.equal(prizeLine(round()).promo, undefined);
  assert.equal(prizeLine(round({ promo: PROMO }), Date.parse("2026-11-24T00:00:00Z")).promo, "Daily bounty 23–29 Nov · until 29 Nov, 24:00 UTC");
  const m = introModel({ round: round({ promo: PROMO }), me: null, board: [], wallet: { pubkey: "ab".repeat(32), balance: null }, nowMs: Date.parse("2026-11-24T00:00:00Z") });
  assert.equal(m.prize.promo, "Daily bounty 23–29 Nov · until 29 Nov, 24:00 UTC");
});

test("#3328 the X handle: typed as @name, name or a link; the field says nothing while empty", () => {
  assert.equal(xHandleOf("@Satoshi_N"), "Satoshi_N"); assert.equal(xHandleOf("https://x.com/abc/status/1"), "abc"); assert.equal(xHandleOf("a b"), null);
  assert.equal(xHandleOf("x".repeat(16)), null);
  assert.deepEqual(xFieldModel("", null), { text: "", kind: "", canSave: false });
  assert.deepEqual(xFieldModel("@bob", null), { text: "", kind: "", canSave: true });
  assert.deepEqual(xFieldModel("bad name!", null), { text: "Not an X username", kind: "bad", canSave: false });
  assert.deepEqual(xFieldModel("@Bob", "bob"), { text: "✓ saved", kind: "ok", canSave: false });
});

test("#3328 the server's answer: saved when found, a clear message when the account does not exist, follows not, or is taken", () => {
  assert.deepEqual(xSaveAnswer({ ok: true, results: { x: { member: true, username: "bob", why: "follows" } } }, "@bob"), { ok: true, kind: "ok", text: "✓ saved @bob" });
  assert.deepEqual(xSaveAnswer({ ok: true, results: { x: { member: false, username: "nosuch", why: "no such X account" } } }, "@nosuch"),
    { ok: false, kind: "bad", text: "No X account @nosuch - check the spelling. Not saved." });
  assert.match(xSaveAnswer({ ok: true, results: { x: { member: false, username: "carol", why: "does not follow" } } }, "carol").text, /@carol found, but it does not follow @bitcoinarena_io yet/);
  assert.equal(xSaveAnswer({ ok: true, results: { x: { member: null, why: "that account is linked to another report key" } } }, "dave").text, "that account is linked to another report key - not saved");
  assert.equal(xSaveAnswer({ ok: false, why: "one check every 15 seconds" }, "dave").text, "one check every 15 seconds");
  assert.equal(xSaveAnswer(null, "dave").ok, false);
});

test("#3328 the game never opens the page's My feedback dialog; the fields are empty with a plain placeholder", () => {
  const main = readFileSync(new URL("../client/src/main.js", import.meta.url), "utf8");
  assert.equal(/bridge\.linkX\s*\(/.test(main), false, "no bridge.linkX() call");
  const page = readFileSync(new URL("../client/index.template.html", import.meta.url), "utf8");
  assert.equal((page.match(/placeholder="you@wallet.com"/g) || []).length, 2);
  for (const p of ["i", "r"]) assert.match(page, new RegExp(`id="${p}XfIn"[^>]*placeholder="@yourXhandle"`));
  assert.equal((page.match(/>Check<\/button>/g) || []).length, 2);
});
