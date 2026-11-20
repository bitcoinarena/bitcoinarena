// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageFunction } from "./page-script.js";
import { centsToTapeUnits, medianOf } from "../../arena-protocol/src/price-sample.js";

const PAGE = new URL("../../../src/arena-ui/index.html", import.meta.url);
const HTML = readFileSync(PAGE, "utf8");
const from = "    (function () {\n      var P = window.ARENA_PRICES";
const at = HTML.indexOf(from); assert.ok(at > 0);
const BLOCK = HTML.slice(at, HTML.indexOf("\n    })();\n", at) + "\n    })();\n".length);
const settle = () => new Promise((r) => setTimeout(r, 10));
const key = (i) => (i + 1).toString(16).padStart(2, "0").repeat(32);
const sig = (b) => b.toString(16).padStart(2, "0").repeat(64);
const VAL = [100, 200, 300, 400, 500, 600, 700];   // keys 0..6, one cents value each
const reading = (i, s = 0x10 + i) => ({ key: key(i), priceCents: VAL[i], signature: sig(s) });
function rig(answerOf) {
  const client = { offered: 0, got: [], submitAttestedSample: (x) => { client.got.push(x); return true; }, submitAttestedTape: (x) => { client.tape = x; return true; } };
  const core = { step: () => { client.offered++; }, submitSample: () => true, submitTape: () => true };
  const window = { ARENA_CORES: { a: core }, unityInstance: { Module: { blwpNet: { inWorld: true, client } } } };
  const fetch = async (u) => { const a = answerOf(String(u)); return { ok: a.status === 200, status: a.status, json: async () => a.body }; };
  pageFunction(PAGE, ["window", "ARENACLIENT", "fetch", "setInterval", "clearInterval", "console", "AbortSignal"], BLOCK)(
    window, { centsToTapeUnits }, fetch, () => 1, () => {}, { log: () => {} }, { timeout: () => undefined });
  return { P: window.ARENA_PRICES, core, client };
}
const sample = (rs, tick = 2) => ({ tick, priceCents: medianOf(rs.map((r) => r.priceCents)), readings: rs });

// kanban #1489 refute of #3153/#3159 (r1120b item 13, skeptic 2), honest path. No attacker: two committee readings are late at
// DIFFERENT seats (k6 = 700 reached a1..a3 after SERVE_AFTER_MS, k5 = 600 reached b1..b3 after it). a1..a3 serve keys 0..5
// (median 300), b1..b3 serve keys 0..4 + 6 (median 300), c serves all seven (median 400). The price vote is 300 (six seats),
// every key's variant is served by at least three of them, so the merge keeps the UNION - all seven - whose median is 400, not
// 300, and built() drops the sample: the honest page loses that tick although each of six seats serves one that stands.
test("refute #3159: honest seats on one price with different late readings: the union of their readings is not that price", async () => {
  const nodes = ["http://a1", "http://a2", "http://a3", "http://b1", "http://b2", "http://b3", "http://c"];
  const A = [0, 1, 2, 3, 4, 5].map((i) => reading(i)), B = [0, 1, 2, 3, 4, 6].map((i) => reading(i)), C = [0, 1, 2, 3, 4, 5, 6].map((i) => reading(i));
  const { P, core, client } = rig((u) => ({ status: 200, body: { feed: true, samples: [sample(u.startsWith("http://a") ? A : u.startsWith("http://b") ? B : C)] } }));
  P.watch("ab".repeat(32), nodes); await settle();
  for (let i = 0; i < 4; i++) core.step({});
  console.log("FACTS: a/b/c serve", sample(A).priceCents, sample(B).priceCents, sample(C).priceCents, "held", [...P.samples.keys()], "applied", client.got.length);
  assert.equal(client.got.length, 1, "six honest seats serve price 300 with a standing set of readings each: the page plays it");
  const g = client.got[0];
  assert.equal(medianOf(g.readings.map((r) => r[1])), g.priceCents, "the played readings' median is the played price");
});
