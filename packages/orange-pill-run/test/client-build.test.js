// kanban #3246: the client builds to one self-contained page that loads no script from elsewhere.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("client/build.mjs writes one html with the whole game inlined", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opr-build-")), "index.html");
  execFileSync(process.execPath, [new URL("../client/build.mjs", import.meta.url).pathname, "--out", out], { encoding: "utf8" });
  const html = fs.readFileSync(out, "utf8");
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /^\s*(import|export)\s/m);
  for (const s of ["function stepWorld", "function buildLevel", "function drawWorld", "window.OPR_DAY", "user-select: none", "touch-action", "Lightning address for prizes", "function saveLn", "/lnaddress"]) assert.ok(html.includes(s), s);
  const js = html.match(/<script>\n([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(js));
});

// #3251 (owner 2026-11-22): the replay's controls are not on the play field, and a replay has its own end card
test("the replay bar sits below the stage, outside the canvas's box; the replay end card exists", () => {
  const t = fs.readFileSync(new URL("../client/index.template.html", import.meta.url), "utf8");
  const stage = t.indexOf('<div id="stage">'), bar = t.indexOf('<div id="rbar"'), end = t.indexOf("<!--OPR_SCRIPT-->");
  assert.ok(stage > 0 && bar > stage && bar < end);
  const inner = t.slice(stage, bar);   // the stage's own markup closes before the bar
  assert.equal((inner.match(/<div/g) || []).length, (inner.match(/<\/div>/g) || []).length);
  for (const id of ["rend", "eBack", "eAgain"]) assert.ok(t.includes('id="' + id + '"'), id);
  assert.ok(t.includes(">⏸<") && t.includes(">2×<") && t.includes(">✕<"));
});
