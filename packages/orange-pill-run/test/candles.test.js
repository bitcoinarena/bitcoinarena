// kanban #3247: candle sources, retry and fallback, with a fake fetch (no network).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fetchDay, checkCandles, dayStartOf } from "../src/candles.mjs";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/candles-30d.json", import.meta.url)));
const d = fx.days[5], start = dayStartOf(d.day), now = start + 2 * 86400;
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const coinbaseBody = { candles: [...d.candles].reverse().map(([t, o, h, l, c]) => ({ start: String(t), open: String(o), high: String(h), low: String(l), close: String(c), volume: "1" })).concat([{ start: String(start + 86400), open: "1", high: "1", low: "1", close: "1" }]) };
const krakenBody = { error: [], result: { XXBTZUSD: d.candles.map(([t, o, h, l, c]) => [t, String(o), String(h), String(l), String(c), "0", "1", 1]), last: 0 } };

test("Coinbase answer is read, newest-first order and the next day's candle dropped", async () => {
  const r = await fetchDay(d.day, { nowS: now, fetch: async (u) => { assert.match(u, /api\.coinbase\.com.*THIRTY_MINUTE/); return ok(coinbaseBody); } });
  assert.equal(r.source, "coinbase"); assert.deepEqual(r.candles, d.candles); assert.equal(r.day, d.day);
});

test("Coinbase failing is retried, then Kraken is used", async () => {
  const calls = [];
  const r = await fetchDay(d.day, { nowS: now, retries: 2, retryDelayMs: 1, fetch: async (u) => { calls.push(u.split("/")[2]); if (u.includes("kraken")) return ok(krakenBody); if (u.includes("exchange")) return ok([]); return { ok: false, status: 503, json: async () => ({}) }; } });
  assert.equal(r.source, "kraken"); assert.deepEqual(r.candles, d.candles);
  assert.deepEqual(calls, ["api.coinbase.com", "api.coinbase.com", "api.exchange.coinbase.com", "api.exchange.coinbase.com", "api.kraken.com"]);
  assert.equal(r.tried.length, 4);
});

test("an incomplete answer is not accepted and all sources failing throws with the tries", async () => {
  const short = { candles: coinbaseBody.candles.slice(5) };
  await assert.rejects(fetchDay(d.day, { nowS: now, retries: 1, retryDelayMs: 1, fetch: async (u) => u.includes("api.coinbase.com") ? ok(short) : Promise.reject(new Error("down")) }), (e) => e.tried.length === 4 && /expected 48/.test(e.tried[0].error));
});

test("a day that has not ended is never fetched", async () => {
  await assert.rejects(fetchDay(d.day, { nowS: start + 86399, fetch: async () => { throw new Error("must not fetch"); } }), /not ended/);
});

test("checkCandles refuses gaps and impossible prices", () => {
  assert.equal(checkCandles(d.candles, start), null);
  const gap = d.candles.slice(); gap[10] = [gap[10][0] + 60, ...gap[10].slice(1)]; assert.match(checkCandles(gap, start), /candle 10/);
  const bad = d.candles.slice(); bad[3] = [bad[3][0], bad[3][1], bad[3][1] - 1, bad[3][3], bad[3][4]]; assert.match(checkCandles(bad, start), /impossible/);
  assert.match(checkCandles(d.candles.slice(1), start), /expected 48/);
});
