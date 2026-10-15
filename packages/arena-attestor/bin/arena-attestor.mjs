#!/usr/bin/env node
// THE ATTESTOR DAEMON (kanban #236): one attestor of one period market, run as a unit.
//
//   node packages/arena-attestor/bin/arena-attestor.mjs --name A --key <pkcs8 or 32-byte seed file> \
//     --sources coinbase,kraken,bitstamp --game btc-updown-15m --seats <url,url> --peers <url,url> \
//     --attestors <hex,hex,hex> --threshold 2 --port 21661 --log <file.jsonl>
//
// Every 10 s: a reading of its sources (their median, whole cents). Every 5 s: the seats' rounds of the game; each round
// whose window ended (the period before its entry close) gets this attestor's word once - signed or "signs nothing" -
// served at GET /attestation?round=; the other attestors' words are pulled, and with the threshold of signatures over one
// body the attestation goes to every seat (POST /outcome), again until each seat holds it. One line per event in the log.
//   --mode value: a SCALAR market's attestor (kanban #362 feature 8): it signs the value it observed - the 60 s average at the
//   window's end, whole cents (the market's unit must be cents) - as a value attestation, and POST /outcome takes that kind too.
import http from 'node:http';
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { readSources } from '../src/sources.js';
import { attestorKey, attestWindow, attestValue, combine, wordToJson, wordFromJson } from '../src/attestor.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 1 ? process.argv[i + 1] : dflt; };
const NAME = arg('name', 'A');
const attestor = attestorKey(readFileSync(arg('key')));
const SOURCES = String(arg('sources', 'coinbase,kraken,bitstamp')).split(',');
const GAME = arg('game', 'btc-updown-15m');
// the market by its id (hex) - its name alone also matches an older manifest of the same name
// --game-id: one id, or several comma-separated - the v1 and v2 markets of one game side by side (2026.0.2, kanban #348)
const GAME_IDS = String(arg('game-id') || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const PERIOD_MS = BigInt(arg('period-ms', '900000'));
const SEATS = String(arg('seats', '')).split(',').filter(Boolean);
const PEERS = String(arg('peers', '')).split(',').filter(Boolean);
const ATTESTORS = String(arg('attestors', '')).split(',').filter(Boolean);
const THRESHOLD = Number(arg('threshold', '2'));
const MODE = arg('mode', 'outcome');
if (MODE !== 'outcome' && MODE !== 'value') throw new Error('--mode outcome (an Up/Down market) or value (a scalar market)');
const PORT = Number(arg('port', '21661'));
const LOG = arg('log');
const SAMPLE_MS = Number(arg('sample-ms', '10000'));
const KEEP_MS = 2 * 3600 * 1000;
// THE READINGS ON DISK (kanban #293, measured 2026-10-13: a restart at 10:02:58Z signed nothing for the window that began at 10:00Z -
// "no reading a minute before the window's start" - its start reading lived only in the old process's memory): every median is
// kept in --samples-file (default: the log beside it, .samples), and read back at start, so a restart loses no window
const SAMPLES_FILE = arg('samples-file', LOG ? `${LOG}.samples` : null);

const log = (o) => { const line = JSON.stringify({ at: new Date().toISOString(), attestor: NAME, ...o }, (k, v) => (typeof v === 'bigint' ? String(v) : v)); console.log(line); if (LOG) appendFileSync(LOG, line + '\n'); };
if (!ATTESTORS.includes(toHex(attestor.pubkey))) { log({ step: 'refused', why: `this key ${toHex(attestor.pubkey).slice(0, 16)} is not one of the market's attestors` }); process.exit(2); }

const samples = [];                    // { atMs, price } - this attestor's medians
let samplesFromDisk = 0;
if (SAMPLES_FILE && existsSync(SAMPLES_FILE)) {
  try {
    const now = BigInt(Date.now());
    for (const x of JSON.parse(readFileSync(SAMPLES_FILE, 'utf8'))) {
      const atMs = BigInt(x.atMs);
      if (Number(now - atMs) <= KEEP_MS) samples.push({ atMs, price: x.big ? BigInt(x.price) : Number(x.price) });
    }
    samplesFromDisk = samples.length;
  } catch (e) { console.error(`[attestor] the readings on disk did not read: ${e.message}`); }
}
const keepSamples = () => {
  if (!SAMPLES_FILE) return;
  try {
    writeFileSync(`${SAMPLES_FILE}.tmp`, JSON.stringify(samples.map((x) => ({ atMs: String(x.atMs), price: String(x.price), big: typeof x.price === 'bigint' }))));
    renameSync(`${SAMPLES_FILE}.tmp`, SAMPLES_FILE);
  } catch (e) { console.error(`[attestor] the readings were not kept on disk: ${e.message}`); }
};
const words = new Map();               // round hex -> this attestor's word (or { none: why })
const posted = new Map();              // round hex -> Set of seats that hold its attestation
const sample = async () => {
  const r = await readSources(SOURCES);
  const atMs = BigInt(Date.now());
  if (r.median !== null) samples.push({ atMs, price: r.median });
  while (samples.length && Number(atMs - samples[0].atMs) > KEEP_MS) samples.shift();
  if (r.median !== null) keepSamples();
  if (r.median === null) log({ step: 'no reading', sources: r.sources });
};

const roundsOfGame = async () => {
  for (const seat of SEATS) {
    try {
      // THE NEXT 16 OF EACH SERIES, NOT EVERY ROUND (kanban #350, the owner 2026-10-12 "Bring down test-host CPU usage back to 12"):
      // the full listing every 5 s made a seat sign all its ~2,400 rows each 45 s window - 4,800 signatures a window, its
      // listing-sign worker at ~42 % (measured 16:02Z on seat 3). A market's rounds whose window ended within the hour are a
      // handful, kept in the listing's closed tally.
      const r = await fetch(`${seat}/rounds?next=16`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const rows = Array.isArray(j) ? j : j.rounds || [];
      // entryCloseMs is decimal ms (a string on the wire)
      return rows.filter((x) => x.game && (GAME_IDS.length ? GAME_IDS.includes(String(x.game.id).toLowerCase()) : x.game.name === GAME) && /^[0-9]{1,16}$/.test(String(x.entryCloseMs))).map((x) => ({ id: x.id, closeMs: BigInt(x.entryCloseMs) }));
    } catch { /* the next seat */ }
  }
  return [];
};

const tick = async () => {
  const now = BigInt(Date.now());
  for (const r of await roundsOfGame()) {
    const window = { startMs: r.closeMs - PERIOD_MS, endMs: r.closeMs };
    // ONE WORD PER ROUND, once its window ended and the reading at its end is in (one sample period after it)
    if (!words.has(r.id) && now >= window.endMs + BigInt(SAMPLE_MS) && now < window.endMs + 3600000n) {
      const w = (MODE === 'value' ? attestValue : attestWindow)({ samples, roundId: fromHex(r.id), window, attestor });
      words.set(r.id, w.ok ? w : { none: w.why });
      log(w.ok ? { step: 'signed', round: r.id, window: { start: new Date(Number(window.startMs)).toISOString(), end: new Date(Number(window.endMs)).toISOString() },
        ...(MODE === 'value' ? { value: w.value } : { priceToBeat: w.priceToBeat, endPrice: w.endPrice, outcome: w.label }),
        samples: samples.filter((s) => s.atMs >= window.startMs - 60000n && s.atMs < window.endMs).length }
        : { step: 'signs nothing', round: r.id, why: w.why });
    }
    const mine = words.get(r.id);
    if (!mine || mine.none) continue;
    const held = posted.get(r.id) || new Set();
    if (held.size >= SEATS.length) continue;
    // THE OTHER ATTESTORS' WORDS, and the attestation once the threshold of them sign one body
    const theirs = await Promise.all(PEERS.map(async (p) => {
      try { const x = await fetch(`${p}/attestation?round=${r.id}`, { signal: AbortSignal.timeout(5000) }); return x.ok ? wordFromJson(await x.json()) : null; } catch { return null; }
    }));
    const all = [mine, ...theirs.filter(Boolean)];
    const att = combine(all, { attestors: ATTESTORS, threshold: THRESHOLD });
    if (!att) continue;
    for (const seat of SEATS) {
      if (held.has(seat)) continue;
      try {
        const x = await fetch(`${seat}/outcome?round=${r.id}`, { method: 'POST', body: att.bytes, signal: AbortSignal.timeout(8000) });
        const text = (await x.text()).trim();
        if (x.status === 201 || x.status === 200) { held.add(seat); log({ step: 'posted', round: r.id, seat, status: x.status, signers: att.signers, ...(MODE === 'value' ? { value: att.body.value } : { outcome: att.body.outcome }),
          words: all.map((w) => ({ key: w.key.slice(0, 8), ...(MODE === 'value' ? { value: w.body.value } : { outcome: w.body.outcome }) })) }); }
        else log({ step: 'post refused', round: r.id, seat, status: x.status, why: text.slice(0, 200) });
      } catch (e) { log({ step: 'post failed', round: r.id, seat, why: e.message }); }
    }
    posted.set(r.id, held);
  }
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/attestation') {
    const w = words.get(String(url.searchParams.get('round') || ''));
    if (!w || w.none) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end(w ? `signs nothing: ${w.none}` : 'no word on that round yet'); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(wordToJson(w)));
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const last = samples[samples.length - 1];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ attestor: NAME, key: toHex(attestor.pubkey), sources: SOURCES, samples: samples.length, last: last ? { at: new Date(Number(last.atMs)).toISOString(), cents: String(last.price) } : null, words: words.size }));
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => log({ step: 'up', port: PORT, mode: MODE, key: toHex(attestor.pubkey), sources: SOURCES, gameIds: GAME_IDS, readingsFromDisk: samplesFromDisk, seats: SEATS, peers: PEERS }));

await sample();
setInterval(() => sample().catch((e) => log({ step: 'sample failed', why: e.message })), SAMPLE_MS);
setInterval(() => tick().catch((e) => log({ step: 'tick failed', why: e.message })), 5000);
