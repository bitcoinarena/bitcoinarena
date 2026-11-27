// kanban #3289 (owner 2026-11-22: "Das Laden des Leaderboards dauert auch zu lang"): the Leaderboard sheet emptied itself and waited for a
// fresh GET /board (0.8-5 s on the stage) although the intro already held the board, read with the round and again every 15 s. The sheet
// draws the held rows at once and the fresh answer over them; an older opening's late answer does not draw over a newer one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../client/src/main.js", import.meta.url), "utf8");
const show = src.slice(src.indexOf("async function showBoard() {"), src.indexOf("async function watchReplay(path) {"));

test("the held board is drawn before the fresh one is asked", () => {
  const paint = show.indexOf("if (kept) { paintBoard();"), ask = show.indexOf('await api.get("/board"');
  assert.ok(paint > 0 && ask > paint, "drawn first, asked after");
  assert.match(show, /const kept = S\.loaded && S\.board\.length > 0;/);
  assert.match(show, /if \(ask !== boardAsk\) return;/);
  assert.match(show, /S\.board = b\.board \|\| \[\];[^\n]*\n[^\n]*\n\s*paintBoard\(\);/);
});

test("the built page carries it", () => {
  const html = fs.readFileSync(new URL("../client/dist/index.html", import.meta.url), "utf8");
  assert.ok(html.includes("function paintBoard()") && html.includes("let boardAsk = 0;"));
});
