#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ATTESTOR DAEMON: one attestor of one period market, run as a unit.
//
//   node packages/arena-attestor/bin/arena-attestor.mjs --name A --key <pkcs8 or 32-byte seed file> \
//     --sources coinbase,kraken,bitstamp --game btc-updown-15m --seats <url,url> --peers <url,url> \
//     --attestors <hex,hex,hex> --threshold 2 --port 21661 --log <file.jsonl>
//
// Every 10 s: a reading of its sources (their median, whole cents). Every 5 s: the seats' rounds of the game; each round
// whose window ended (the period before its entry close) gets this attestor's word once - signed or "signs nothing" -
// served at GET /attestation?round=; the other attestors' words are pulled, and with the threshold of signatures over one
// body the attestation goes to every seat (POST /outcome), again until each seat holds it. One line per event in the log.
//   --mode value: a SCALAR market's attestor (feature 8): it signs the value it observed - the 60 s average at the
//   window's end, whole cents (the market's unit must be cents) - as a value attestation, and POST /outcome takes that kind too.
import http from 'node:http';
import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { readSources } from '../src/sources.js';
import { attestorKey, attestWindow, attestValue, combine, wordToJson, wordFromJson, marketsToAttest, marketVersions } from '../src/attestor.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';

const arg = (name, dflt = null) => { const i = process.argv.indexOf(`--${name}`); return i > 1 ? process.argv[i + 1] : dflt; };
const NAME = arg('name', 'A');
const attestor = attestorKey(readFileSync(arg('key')));
const SOURCES = String(arg('sources', 'coinbase,kraken,bitstamp')).split(',');
const GAME = arg('game', 'btc-updown-15m');
// the market by its id (hex) - its name alone also matches an older manifest of the same name
// --game-id: one id, or several comma-separated - the v1 and v2 markets of one game side by side (2026.0.2); every other version a
// seat hosts whose manifest names this attestor's key is attested too (marketsToAttest)
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
// THE READINGS ON DISK (measured 2026-10-13: a restart at 10:02:58Z signed nothing for the window that began at 10:00Z -
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
const words = new Map();               // `${round hex}@${window end ms}` -> this attestor's word (or { none: why }) - kanban #1995
const posted = new Map();              // round hex -> Set of seats that hold its attestation
// A SEAT THAT HOLDS NO SUCH ROUND (2026-10-20 "Also fix this" - measured: the test host-only rounds went to the 7 second-host seats every
// 5 s, 7,834 refusals "404 this node holds no such round" in attestor A's log): asked again only after NO_ROUND_RETRY_MS, logged once
const NO_ROUND_RETRY_MS = Number(arg('no-round-retry-ms', '300000'));
const noRound = new Map();             // round hex -> Map seat -> ms it is asked again
const sample = async () => {
  const r = await readSources(SOURCES);
  const atMs = BigInt(Date.now());
  if (r.median !== null) samples.push({ atMs, price: r.median });
  while (samples.length && Number(atMs - samples[0].atMs) > KEEP_MS) samples.shift();
  if (r.median !== null) keepSamples();
  if (r.median === null) log({ step: 'no reading', sources: r.sources });
};

// EVERY VERSION OF THE MARKET THAT NAMES THIS KEY (marketsToAttest): the seats' /games, read again each minute - with --game-id
// the listed ids are kept beside them; without it and before the first read, the game's name alone matches, as before
let marketIds = new Set(GAME_IDS);
let marketsReadMs = 0;
const MARKETS_EVERY_MS = Number(arg('markets-every-ms', '60000'));
let versions = [];                     // [{ id, version }] of the seats' listing, oldest first
let listed = false;
const readMarkets = async () => {
  if (Date.now() - marketsReadMs < MARKETS_EVERY_MS) return;
  const games = [];
  let read = 0;
  for (const seat of SEATS) {
    try {
      const r = await fetch(`${seat}/games`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      games.push(...((await r.json()).games || [])); read++;
    } catch { /* the next seat */ }
  }
  if (!read) return;
  marketsReadMs = Date.now();
  const key = toHex(attestor.pubkey);
  const next = marketsToAttest({ games, name: GAME, key, mode: MODE, ids: GAME_IDS });
  versions = marketVersions({ games, name: GAME, key, mode: MODE });
  const added = [...next].filter((id) => !marketIds.has(id));
  const dropped = [...marketIds].filter((id) => !next.has(id));
  // THE WHOLE LIST at the first read and on every change, the latest version named
  if (added.length || dropped.length || !listed) log({ step: 'markets', of: next.size, latest: versions.at(-1) || null, added, dropped, versions });
  listed = true;
  marketIds = next;
};
const ofThisMarket = (x) => (marketIds.size ? marketIds.has(String(x.game.id).toLowerCase()) : x.game.name === GAME);

// NO SEAT'S CLOSE IS TAKEN ON ITS WORD (kanban #1995, #1515, #1489 v1-refute-31): this read took each round's entryCloseMs from the
// FIRST seat that answered GET /rounds and kept one word per round id for good, so one lying seat first in --seats listed the real round
// with a shifted close: this attestor signed the shifted window, every honest seat refused it (409, server.js holdOutcome), and the
// round's own window was never signed - every round of the market VOIDed at its deadline. Now every seat's listing is read (the first
// answering one each tick, all of them every --list-all-ms), each close a seat names for a round is a candidate (the first a seat names for it,
// once - a seat cannot fill the list by naming another close each tick), each gets its own word (keyed by round and window end), and a seat that refuses one is
// offered the next: a close on the grid first, then the one most seats name. An honest seat holds only the round's own window end, so a wrong word blocks nothing.
const LIST_ALL_MS = Number(arg('list-all-ms', '30000'));
let listedAllMs = 0;
const closesOf = new Map();            // round hex -> Map closeMs(string) -> Set of seats that list it
const listingOf = async (seat) => {
  // THE NEXT 16 OF EACH SERIES, NOT EVERY ROUND (2026-10-12 "Bring down test-host CPU usage back to 12"):
  // the full listing every 5 s made a seat sign all its ~2,400 rows each 45 s window - 4,800 signatures a window, its
  // listing-sign worker at ~42 % (measured 16:02Z on seat 3). A market's rounds whose window ended within the hour are a
  // handful, kept in the listing's closed tally.
  const r = await fetch(`${seat}/rounds?next=16`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json();
  const rows = Array.isArray(j) ? j : j.rounds || [];
  // entryCloseMs is decimal ms (a string on the wire)
  return rows.filter((x) => x.game && ofThisMarket(x) && /^[0-9a-f]{64}$/.test(String(x.id).toLowerCase()) && /^[0-9]{1,16}$/.test(String(x.entryCloseMs))).map((x) => ({ id: String(x.id).toLowerCase(), closeMs: BigInt(x.entryCloseMs) }));
};
const heard = (seat, rows) => {
  const seen = new Set();
  for (const x of rows) {
    if (seen.has(x.id)) continue;      // one close per seat per round: a seat listing a round twice names its first close
    seen.add(x.id);
    const m = closesOf.get(x.id) || new Map();
    if ([...m.values()].some((by) => by.has(seat))) continue;   // and the first close it ever named: a round's close never moves
    const k = String(x.closeMs);
    const by = m.get(k) || new Set(); by.add(seat); m.set(k, by); closesOf.set(x.id, m);
  }
};
const roundsOfGame = async () => {
  await readMarkets();
  const all = Date.now() - listedAllMs >= LIST_ALL_MS;
  let read = 0;
  for (const seat of SEATS) {
    try {
      const rows = await listingOf(seat);
      if (!rows) continue;
      heard(seat, rows); read++;
      if (!all) break;
    } catch { /* the next seat */ }
  }
  if (all && read) listedAllMs = Date.now();
  // forget rounds whose every window is past the hour this attestor signs in
  const now = BigInt(Date.now());
  for (const [id, m] of closesOf) if ([...m.keys()].every((k) => now >= BigInt(k) + 3600000n + PERIOD_MS)) closesOf.delete(id);
  // each round with its closes in order (closeOrder)
  return [...closesOf].map(([id, m]) => ({ id, closes: closeOrder(m).map((k) => BigInt(k)) }));
};
// a close on the market's UTC grid first (a seat refuses a round off it, marketWindowOf), then the one most seats name, then the first heard
function closeOrder(m) {
  const onGrid = (k) => (BigInt(k) % PERIOD_MS === 0n ? 1 : 0);
  return [...m].sort((p, q) => (onGrid(q[0]) - onGrid(p[0])) || (q[1].size - p[1].size)).map(([k]) => k);
}
const wordKey = (id, endMs) => `${id}@${endMs}`;
const refusedAt = new Map();           // `${round}@${end} seat` -> why it last said, logged once per reason

const tick = async () => {
  const now = BigInt(Date.now());
  for (const r of await roundsOfGame()) {
    const held = posted.get(r.id) || new Set();
    const absent = noRound.get(r.id) || new Map();
    for (const closeMs of r.closes) {
      const window = { startMs: closeMs - PERIOD_MS, endMs: closeMs };
      const key = wordKey(r.id, window.endMs);
      // ONE WORD PER ROUND AND WINDOW, once its window ended and the reading at its end is in (one sample period after it)
      if (!words.has(key) && now >= window.endMs + BigInt(SAMPLE_MS) && now < window.endMs + 3600000n) {
        const w = (MODE === 'value' ? attestValue : attestWindow)({ samples, roundId: fromHex(r.id), window, attestor });
        words.set(key, w.ok ? w : { none: w.why });
        log(w.ok ? { step: 'signed', round: r.id, window: { start: new Date(Number(window.startMs)).toISOString(), end: new Date(Number(window.endMs)).toISOString() },
          ...(MODE === 'value' ? { value: w.value } : { priceToBeat: w.priceToBeat, endPrice: w.endPrice, outcome: w.label }),
          samples: samples.filter((s) => s.atMs >= window.startMs - 60000n && s.atMs < window.endMs).length, ...(r.closes.length > 1 ? { closesListed: r.closes.length } : {}) }
          : { step: 'signs nothing', round: r.id, why: w.why });
      }
      const mine = words.get(key);
      if (!mine || mine.none) continue;
      if (SEATS.every((seat) => held.has(seat) || (absent.get(seat) || 0) > Date.now())) break;
      // THE OTHER ATTESTORS' WORDS ON THIS WINDOW, and the attestation once the threshold of them sign one body
      const theirs = await Promise.all(PEERS.map(async (p) => {
        try { const x = await fetch(`${p}/attestation?round=${r.id}&end=${window.endMs}`, { signal: AbortSignal.timeout(5000) }); return x.ok ? wordFromJson(await x.json()) : null; } catch { return null; }
      }));
      const all = [mine, ...theirs.filter(Boolean)];
      const att = combine(all, { attestors: ATTESTORS, threshold: THRESHOLD });
      if (!att) continue;
      for (const seat of SEATS) {
        if (held.has(seat) || (absent.get(seat) || 0) > Date.now()) continue;
        try {
          const x = await fetch(`${seat}/outcome?round=${r.id}`, { method: 'POST', body: att.bytes, signal: AbortSignal.timeout(8000) });
          const text = (await x.text()).trim();
          if (x.status === 201 || x.status === 200) { held.add(seat); log({ step: 'posted', round: r.id, seat, status: x.status, signers: att.signers, end: new Date(Number(window.endMs)).toISOString(), ...(MODE === 'value' ? { value: att.body.value } : { outcome: att.body.outcome }),
            words: all.map((w) => ({ key: w.key.slice(0, 8), ...(MODE === 'value' ? { value: w.body.value } : { outcome: w.body.outcome }) })) }); }
          else if (x.status === 404) {
            if (!absent.has(seat)) log({ step: 'seat holds no such round', round: r.id, seat, again: `in ${NO_ROUND_RETRY_MS / 1000} s` });
            absent.set(seat, Date.now() + NO_ROUND_RETRY_MS); noRound.set(r.id, absent);
          } else {
            const why = text.slice(0, 200), rk = `${key} ${seat}`;
            if (refusedAt.get(rk) !== why) { refusedAt.set(rk, why); if (refusedAt.size > 4096) refusedAt.delete(refusedAt.keys().next().value); log({ step: 'post refused', round: r.id, seat, end: new Date(Number(window.endMs)).toISOString(), status: x.status, why }); }
          }
        } catch (e) { log({ step: 'post failed', round: r.id, seat, why: e.message }); }
      }
    }
    posted.set(r.id, held);
  }
};
// this attestor's word on a round: on the window that ends at `end` when asked (kanban #1995), else (an older peer asks by round alone)
// the first signed word in closeOrder
const wordOn = (id, end) => {
  if (end) return words.get(wordKey(id, end));
  const m = closesOf.get(id);
  const ends = m ? closeOrder(m) : [...words.keys()].filter((k) => k.startsWith(`${id}@`)).map((k) => k.slice(id.length + 1));
  const ok = ends.map((e) => words.get(wordKey(id, e))).filter((w) => w && !w.none);
  return ok[0] || ends.map((e) => words.get(wordKey(id, e))).find(Boolean);
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/attestation') {
    const end = url.searchParams.get('end');
    const w = wordOn(String(url.searchParams.get('round') || '').toLowerCase(), end && /^[0-9]{1,16}$/.test(end) ? end : null);
    if (!w || w.none) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end(w ? `signs nothing: ${w.none}` : 'no word on that round yet'); }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(wordToJson(w)));
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const last = samples[samples.length - 1];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ attestor: NAME, key: toHex(attestor.pubkey), sources: SOURCES, samples: samples.length, last: last ? { at: new Date(Number(last.atMs)).toISOString(), cents: String(last.price) } : null, words: words.size,
      markets: { ids: [...marketIds], latest: versions.at(-1) || null, versions, readAt: marketsReadMs ? new Date(marketsReadMs).toISOString() : null } }));
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => log({ step: 'up', port: PORT, mode: MODE, key: toHex(attestor.pubkey), sources: SOURCES, gameIds: GAME_IDS, readingsFromDisk: samplesFromDisk, seats: SEATS, peers: PEERS }));

await sample();
setInterval(() => sample().catch((e) => log({ step: 'sample failed', why: e.message })), SAMPLE_MS);
setInterval(() => tick().catch((e) => log({ step: 'tick failed', why: e.message })), 5000);
