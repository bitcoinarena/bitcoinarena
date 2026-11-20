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

// kanban #1489 refute of #3033/#3153/#3159/#3165 (r1120b item 13, skeptic 2). Attacker: ONE committee seat (key 6), acting as a
// READING SIGNER, not as a served page answer. It signs its own reading of sample k twice with the SAME cents (BIP-340 aux rand:
// two valid signatures) and posts one to seats a1..a3, the other to b1..b3. Each seat's reading() dedups by price, so each honest
// seat holds ONE reading of key 6 and counts it; mid-run samples are never exchanged (#fetchReadings asks the ends only), all seven
// readings are in, so every honest seat serves at once, on the same price (median 400). The seat itself serves a third copy.
// The page's per-key merge sees key 6 as 3 vs 3 vs 1: no variant wins, key 6 is dropped, the six readings left have the median
// 300, not the voted 400 - built() answers null. The page retries on the next poll and gets the same answers (nothing converges),
// and once tick 4 is held since passes tick 2: lost for good. Done every tick, the page holds no price at all.
test("refute #3165: one committee seat double-signs its own reading (same cents) across the honest seats and denies the tick", async () => {
  const nodes = ["http://evil", "http://a1", "http://a2", "http://a3", "http://b1", "http://b2", "http://b3"];
  const honest = [0, 1, 2, 3, 4, 5].map((i) => reading(i));
  const A = [...honest, reading(6, 0xa6)], B = [...honest, reading(6, 0xb6)], E = [...honest, reading(6, 0xe6)];
  const later = { tick: 4, priceCents: 400, readings: [0, 1, 2, 3, 4, 5, 6].map((i) => reading(i)) };
  const { P, core, client } = rig((u) => {
    const rs = u.startsWith("http://evil") ? E : u.startsWith("http://a") ? A : B;
    return { status: 200, body: { feed: true, samples: [sample(rs), later] } };
  });
  P.watch("ab".repeat(32), nodes); await settle();
  for (let i = 0; i < 6; i++) core.step({});
  console.log("FACTS: price at tick 2 every seat serves", sample(A).priceCents, "samples held", [...P.samples.keys()], "applied", client.got.map((x) => x.tick));
  assert.ok(P.samples.has(2), "six honest seats serve one price (400) with seven valid readings each; one seat's double signature denies the tick");
});
