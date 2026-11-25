// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3720 (owner 2026-11-25: "die Bounty Details (Payout-Adresse, Twitter-Verification-Prozess) an das Ende des Spiels ... verschieben und klar
// machen, dass diese voll optional sind"): the intro asks for neither; the result's bounty box does, marked optional.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prizeLine } from "../client/src/screens.js";
import { RULES } from "../client/src/rules.js";

const page = readFileSync(new URL("../client/index.template.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../client/src/main.js", import.meta.url), "utf8");
const sheet = (id) => { const a = page.indexOf(`<div class="sheet" id="${id}"`); return page.slice(a, page.indexOf('<div class="sheet"', a + 10)); };

test("#3720 the intro has no X handle or Lightning address field; the result's bounty box has both, marked optional", () => {
  const intro = sheet("intro"), result = sheet("result");
  for (const id of ["iX", "iXf", "iXfIn", "iLn", "iLnIn"]) assert.equal(intro.includes(`id="${id}"`), false, id);
  const box = result.slice(result.indexOf('id="rBounty"'));
  for (const id of ["rXfIn", "rLnIn", "rBChange", "rNotText"]) assert.ok(box.includes(`id="${id}"`), id);
  assert.match(box, /\(optional\)/);
  assert.match(box, /Only needed to take part in the bounty.*Playing and the leaderboard work without them\./);
  assert.equal(/\$\("i(X|Xf|Ln)\w*"\)/.test(main), false, "main.js paints no intro X/Lightning field");
});

test("#3720 the box shows only after a run of the round on the player's record, never in practice or a replay", () => {
  assert.match(main, /paintBounty\(m === "play" && !!run && !!api && !!S\.me && !!after,/);
  // the follow requirement and the house-account refusal stay the service's (POST /x), the same field code as before
  assert.match(main, /api\.post\("\/x", \{ x: typed \}\)/);
  assert.match(main, /api\.post\("\/lnaddress"/);
});

test("#3720 the prize line and the rules say the bounty details are optional and asked after a run", () => {
  assert.equal(prizeLine({ bountySats: 2500, entrySats: 0 }, Date.UTC(2026, 10, 25)).small, "optional: X (follow @bitcoinarena_io) + Lightning address, after a run");
  const pb = RULES.find((r) => r[0] === "Play bounty")[1], xr = RULES.find((r) => r[0] === "X account")[1];
  assert.match(pb, /Taking part is optional: playing and the leaderboard work without an X account or a Lightning address/);
  assert.match(xr, /bounty box, shown after a run/);
  assert.match(xr, /saved before your first run of that round; saved later, it counts from your next round/);
  assert.match(xr, /follow @bitcoinarena_io on X/);
});
