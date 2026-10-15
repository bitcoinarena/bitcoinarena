// v5check.mjs <seat url> <round id>: kanban #312 - a protocol-5 round's RoundResult is the median of the committee's signed readings.
// Reads the seat's GET /round-result and GET /price-samples; for the opening and closing samples and every served sample: the readings'
// keys are distinct members of the committee, each signature verifies (BIP340 over priceReadingId), at least 5 of them, and the
// price is their median (protocol price-sample.js priceSampleStands5). Prints a Markdown table.
import { schnorr } from '@noble/curves/secp256k1.js';
import { priceSampleStands5 } from '../../arena-protocol/src/price-sample.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
const [seat, round] = process.argv.slice(2);
const get = async (p) => { const r = await fetch(`${seat.replace(/\/$/, '')}${p}`, { signal: AbortSignal.timeout(30000) }); if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`); return r.json(); };
const res = await get(`/round-result?round=${round}`);
const committee = (res.committee || res.nodes || []).map((k) => (typeof k === 'string' ? fromHex(k) : k));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const rows = [];
const check = (name, tick, readings, claimed) => {
  const list = (readings || []).map((x) => ({ key: x.key, priceCents: Number(x.priceCents), signature: x.signature }));
  const st = committee.length ? priceSampleStands5({ roundId: fromHex(round), tick, readings: list, committee, threshold: 5, verify })
    : { ok: false, why: 'the answer names no committee' };
  rows.push(`| ${name} | ${tick} | ${list.length} | ${list.map((x) => x.priceCents).join(' ')} | ${st.ok ? st.priceCents : '-'} | ${claimed ?? '-'} | ${st.ok && (claimed === undefined || Number(claimed) === st.priceCents) ? 'yes' : `NO${st.ok ? '' : ': ' + st.why}`} |`);
};
console.log(`round ${round.slice(0, 16)}, seat ${seat}: front ${res.front}, open ${res.openCents}, close ${res.closeCents}, committee ${committee.length}\n`);
console.log('| sample | tick | readings | prices (cents) | median | claimed | stands |\n|---|---|---|---|---|---|---|');
// the result names its ends' ticks and prices and counts their readings; the readings themselves are the served samples'
const s = await get(`/price-samples?round=${round}`);
const at = new Map((s.samples || []).map((x) => [x.tick, x]));
for (const [name, tick, cents] of [['open', res.openTick, res.openCents], ['close', res.closeTick, res.closeCents]]) {
  const x = at.get(tick);
  if (x) check(name, tick, x.readings, cents); else rows.push(`| ${name} | ${tick} | - | - | - | ${cents} | not served by this seat |`);
}
for (const x of s.samples || []) if (x.tick !== res.openTick && x.tick !== res.closeTick) check(`k ${x.k ?? '?'}`, x.tick, x.readings, x.priceCents);
console.log(rows.join('\n'));
