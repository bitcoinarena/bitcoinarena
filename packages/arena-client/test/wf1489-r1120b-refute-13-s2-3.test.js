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

// kanban #1489 refute of #3153/#3165 (r1120b item 13, skeptic 2), the TAPE. One committee seat (key 6) signs its own 64 tape
// readings twice (same prices, two signatures) and posts one copy to a1..a3, the other to b1..b3; the tape is never exchanged
// between seats either (#tape5 reads heardTapes only), so all seven honest-looking tapes agree on the 64 medians while key 6 splits
// 3/3/1. The page drops key 6, the six tapes left have other medians, built() answers null - and every poll after gives the same
// answers, so P.tape is never set: the run's opening tape is denied for good.
const tape = (i, s = 0x10 + i) => ({ key: key(i), prices: Array(64).fill(VAL[i]), signature: sig(s) });
const tapeOf = (rs) => ({ tick: 0, prices: Array.from({ length: 64 }, (_, p) => medianOf(rs.map((r) => r.prices[p]))), readings: rs });
test("refute #3165 (tape): one committee seat double-signs its tape across the honest seats and the page never takes the tape", async () => {
  const nodes = ["http://evil", "http://a1", "http://a2", "http://a3", "http://b1", "http://b2", "http://b3"];
  const honest = [0, 1, 2, 3, 4, 5].map((i) => tape(i));
  const A = [...honest, tape(6, 0xa6)], B = [...honest, tape(6, 0xb6)], E = [...honest, tape(6, 0xe6)];
  const { P } = rig((u) => ({ status: 200, body: { feed: true, samples: [], tape: tapeOf(u.startsWith("http://evil") ? E : u.startsWith("http://a") ? A : B) } }));
  P.watch("ab".repeat(32), nodes); await settle();
  console.log("FACTS: tape every seat serves starts", tapeOf(A).prices[0], "P.tape", P.tape ? P.tape.prices[0] : null);
  assert.ok(P.tape, "six honest seats serve one tape with seven valid readings each; one seat's double signature denies it");
});
