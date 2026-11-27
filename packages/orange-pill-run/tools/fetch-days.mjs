// Saves the candles of the N UTC days before a given day into test/fixtures/candles-30d.json (kanban #3247).
// node tools/fetch-days.mjs [lastDay YYYY-MM-DD] [N]
import fs from "node:fs";
import { fetchDay, dayStartOf, dayName } from "../src/candles.mjs";
const last = process.argv[2] ? dayStartOf(process.argv[2]) : dayStartOf(Math.floor(Date.now() / 1000)) - 86400;
const n = +(process.argv[3] || 30), out = [];
for (let i = n - 1; i >= 0; i--) {
  const d = await fetchDay(dayName(last - i * 86400), { log: (m) => console.error(m) });
  out.push({ day: d.day, source: d.source, candles: d.candles });
  console.error(d.day, d.source, d.candles.length);
}
const file = new URL("../test/fixtures/candles-30d.json", import.meta.url);
fs.writeFileSync(file, JSON.stringify({ note: "BTC-USD 30-min candles, [t,o,h,l,c]; fetched by tools/fetch-days.mjs", days: out }) + "\n");
console.error("wrote", out.length, "days");
