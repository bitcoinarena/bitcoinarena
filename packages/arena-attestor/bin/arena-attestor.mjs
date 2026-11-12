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
import { attestorKey, attestWindow, attestValue, combine, wordToJson, wordFromJson, marketsToAttest, marketVersions, roundCloseOf } from '../src/attestor.js';
import { fromHex, toHex } from '../../arena-protocol/src/hash.js';
import { decodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

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
const words = new Map();               // round hex -> this attestor's word (or { none: why })
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
const periods = new Map();             // market id hex -> its manifest's roundPeriodMs (0n: no grid)
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
  // each version's own grid (its manifest's roundPeriodMs) - a close off it is no round of the market (kanban #1705)
  for (const g of games) { try { const m = decodeManifest(fromHex(String(g.manifest))); const id = toHex(gameIdOf(m)); if (next.has(id)) periods.set(id, m.roundPeriodMs); } catch { /* not a manifest */ } }
  const added = [...next].filter((id) => !marketIds.has(id));
  const dropped = [...marketIds].filter((id) => !next.has(id));
  // THE WHOLE LIST at the first read and on every change, the latest version named
  if (added.length || dropped.length || !listed) log({ step: 'markets', of: next.size, latest: versions.at(-1) || null, added, dropped, versions });
  listed = true;
  marketIds = next;
};
const ofThisMarket = (x) => (marketIds.size ? marketIds.has(String(x.game.id).toLowerCase()) : x.game.name === GAME);

// THE ROUND'S CLOSE IS ITS CONTRACT'S, NEVER ONE SEAT'S WORD (kanban #1489 / #1705, refute of fix:attest:3 9a2c0df4c): every seat's
// listing is read (not the first that answers - one seat omitting a round no longer keeps it from its word either), and a round's
// close is taken from contract bytes some seat serves that hash to the round's id (attestor.js roundCloseOf - for a series round,
// the template's derivation too). Before, the FIRST seat's unsigned entryCloseMs fixed the window, the word was signed ONCE per
// round and never redone: a seat listing a shifted close made this attestor sign another window, every seat refused it (observed_at
// is not the window's end), and the round went VOID - a refund the lying seat could choose after watching the price. Only when no
// seat serves the round's contract is a listed close used - and then only while every seat listing the round names the same one,
// and the word is SIGNED AGAIN whenever that close changes: a lie can no longer fix the round's word for good.
const CONTRACT_RETRY_MS = Number(arg('contract-retry-ms', '30000'));
const closes = new Map();              // round hex -> { closeMs } believed from its contract (never changes: the bytes are the round)
const closeTried = new Map();          // round hex -> ms its contract was last asked for, while none verified
const noClose = new Set();             // round hex: logged once as having no close to sign
const getJson = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(8000) }); if (!r.ok) return null; return r.json(); };
const roundsOfGame = async () => {
  await readMarkets();
  const byId = new Map();              // round hex -> Map seat -> listed close
  await Promise.all(SEATS.map(async (seat) => {
    try {
      // THE NEXT 16 OF EACH SERIES, NOT EVERY ROUND (2026-10-12 "Bring down test-host CPU usage back to 12"):
      // the full listing every 5 s made a seat sign all its ~2,400 rows each 45 s window - 4,800 signatures a window, its
      // listing-sign worker at ~42 % (measured 16:02Z on seat 3). A market's rounds whose window ended within the hour are a
      // handful, kept in the listing's closed tally.
      const j = await getJson(`${seat}/rounds?next=16`);
      if (!j) return;
      const rows = Array.isArray(j) ? j : j.rounds || [];
      // entryCloseMs is decimal ms (a string on the wire)
      for (const x of rows) {
        if (!x || !x.game || !ofThisMarket(x) || !/^[0-9a-f]{64}$/i.test(String(x.id)) || !/^[0-9]{1,16}$/.test(String(x.entryCloseMs))) continue;
        const id = String(x.id).toLowerCase();
        if (!byId.has(id)) byId.set(id, { listedBy: new Map(), gameId: String(x.game.id || '').toLowerCase() });
        byId.get(id).listedBy.set(seat, BigInt(x.entryCloseMs));
      }
    } catch { /* the next seat */ }
  }));
  return [...byId].map(([id, v]) => ({ id, ...v }));
};
// the round's close: its contract's, else the one close every seat listing it agrees on, else none (signs nothing yet)
const closeOfRound = async (r, nowMs) => {
  const known = closes.get(r.id);
  if (known) return { closeMs: known.closeMs, gameId: known.gameId, from: 'contract' };
  const listedCloses = [...new Set([...r.listedBy.values()].map(String))];
  // only a round whose window may have ended is worth asking about: its listed closes are all this attestor has before
  const due = [...r.listedBy.values()].some((c) => nowMs >= c + BigInt(SAMPLE_MS));
  if (due && Date.now() - (closeTried.get(r.id) || 0) >= CONTRACT_RETRY_MS) {
    closeTried.set(r.id, Date.now());
    const order = [...r.listedBy.keys(), ...SEATS.filter((s) => !r.listedBy.has(s))];
    for (const seat of order) {
      try {
        const x = await fetch(`${seat}/round?id=${r.id}`, { signal: AbortSignal.timeout(8000) });
        if (!x.ok) continue;
        const bytes = new Uint8Array(await x.arrayBuffer());
        let got = roundCloseOf({ id: r.id, contract: bytes, marketIds });
        if (!got.ok && got.seriesId) {
          let line = null;
          for (const s2 of [seat, ...SEATS.filter((s) => s !== seat)]) {
            try { const y = await fetch(`${s2}/series-template?id=${got.seriesId}`, { signal: AbortSignal.timeout(8000) }); if (y.ok) { line = await y.text(); break; } } catch { /* the next seat */ }
          }
          if (line !== null) got = roundCloseOf({ id: r.id, contract: bytes, seriesLine: line, marketIds });
        }
        if (got.ok) {
          const p = periods.get(got.gameId) || 0n;
          if (p > 0n && got.closeMs % p !== 0n) { log({ step: 'contract off the grid', round: r.id, seat, closeMs: got.closeMs, periodMs: p }); continue; }
          closes.set(r.id, { closeMs: got.closeMs, gameId: got.gameId }); closeTried.delete(r.id);
          const liars = [...r.listedBy].filter(([, c]) => c !== got.closeMs).map(([s]) => s);
          if (liars.length) log({ step: 'listed close is not the contract\'s', round: r.id, contract: got.closeMs, seats: liars });
          return { closeMs: got.closeMs, gameId: got.gameId, from: 'contract' };
        }
        log({ step: 'contract not believed', round: r.id, seat, why: got.why });
      } catch { /* the next seat */ }
    }
  }
  if (listedCloses.length !== 1) return { closeMs: null, why: `the seats list ${listedCloses.length} closes for it and none serves its contract` };
  return { closeMs: BigInt(listedCloses[0]), gameId: r.gameId, from: 'listing' };
};

let ticking = false;
const tick = async () => {
  if (ticking) return;
  ticking = true;
  try { await tickOnce(); } finally { ticking = false; }
  if (closes.size > 5000) closes.clear();
  if (closeTried.size > 5000) closeTried.clear();
  if (noClose.size > 5000) noClose.clear();
};
const tickOnce = async () => {
  const now = BigInt(Date.now());
  for (const r of await roundsOfGame()) {
    const c = await closeOfRound(r, now);
    if (c.closeMs === null) {
      if (!noClose.has(r.id)) { noClose.add(r.id); log({ step: 'no close', round: r.id, why: c.why }); }
      // a word signed for a close the seats no longer agree on is not served on as this round's
      if (words.has(r.id) && words.get(r.id).from !== 'contract') { words.delete(r.id); posted.delete(r.id); }
      continue;
    }
    noClose.delete(r.id);
    // THE MARKET'S OWN GRID, when its manifest names one; else --period-ms as before
    const gp = periods.get(c.gameId);
    const period = typeof gp === 'bigint' && gp > 0n ? gp : PERIOD_MS;
    if (c.from === 'listing' && typeof gp === 'bigint' && gp > 0n && c.closeMs % gp !== 0n) {
      if (!noClose.has(r.id)) { noClose.add(r.id); log({ step: 'listed close off the grid', round: r.id, closeMs: c.closeMs, periodMs: gp }); }
      continue;
    }
    const window = { startMs: c.closeMs - period, endMs: c.closeMs };
    // a word signed for ANOTHER close (one seat's listing, since corrected or since read from the contract) is signed again
    const had = words.get(r.id);
    if (had && had.closeMs !== c.closeMs) {
      log({ step: 'signs again', round: r.id, was: had.closeMs, close: c.closeMs, from: c.from });
      words.delete(r.id); posted.delete(r.id);
    }
    // ONE WORD PER ROUND AND CLOSE, once its window ended and the reading at its end is in (one sample period after it)
    if (!words.has(r.id) && now >= window.endMs + BigInt(SAMPLE_MS) && now < window.endMs + 3600000n) {
      const w = (MODE === 'value' ? attestValue : attestWindow)({ samples, roundId: fromHex(r.id), window, attestor });
      words.set(r.id, w.ok ? { ...w, closeMs: c.closeMs, from: c.from } : { none: w.why, closeMs: c.closeMs, from: c.from });
      log(w.ok ? { step: 'signed', round: r.id, from: c.from, window: { start: new Date(Number(window.startMs)).toISOString(), end: new Date(Number(window.endMs)).toISOString() },
        ...(MODE === 'value' ? { value: w.value } : { priceToBeat: w.priceToBeat, endPrice: w.endPrice, outcome: w.label }),
        samples: samples.filter((s) => s.atMs >= window.startMs - 60000n && s.atMs < window.endMs).length }
        : { step: 'signs nothing', round: r.id, why: w.why });
    }
    const mine = words.get(r.id);
    if (!mine || mine.none) continue;
    const held = posted.get(r.id) || new Set();
    const absent = noRound.get(r.id) || new Map();
    if (SEATS.every((seat) => held.has(seat) || (absent.get(seat) || 0) > Date.now())) continue;
    // THE OTHER ATTESTORS' WORDS, and the attestation once the threshold of them sign one body
    const theirs = await Promise.all(PEERS.map(async (p) => {
      try { const x = await fetch(`${p}/attestation?round=${r.id}`, { signal: AbortSignal.timeout(5000) }); return x.ok ? wordFromJson(await x.json()) : null; } catch { return null; }
    }));
    const all = [mine, ...theirs.filter(Boolean)];
    const att = combine(all, { attestors: ATTESTORS, threshold: THRESHOLD });
    if (!att) continue;
    for (const seat of SEATS) {
      if (held.has(seat) || (absent.get(seat) || 0) > Date.now()) continue;
      try {
        const x = await fetch(`${seat}/outcome?round=${r.id}`, { method: 'POST', body: att.bytes, signal: AbortSignal.timeout(8000) });
        const text = (await x.text()).trim();
        if (x.status === 201 || x.status === 200) { held.add(seat); log({ step: 'posted', round: r.id, seat, status: x.status, signers: att.signers, ...(MODE === 'value' ? { value: att.body.value } : { outcome: att.body.outcome }),
          words: all.map((w) => ({ key: w.key.slice(0, 8), ...(MODE === 'value' ? { value: w.body.value } : { outcome: w.body.outcome }) })) }); }
        else if (x.status === 404) {
          if (!absent.has(seat)) log({ step: 'seat holds no such round', round: r.id, seat, again: `in ${NO_ROUND_RETRY_MS / 1000} s` });
          absent.set(seat, Date.now() + NO_ROUND_RETRY_MS); noRound.set(r.id, absent);
        } else {
          log({ step: 'post refused', round: r.id, seat, status: x.status, why: text.slice(0, 200) });
          // a seat that says the word is of another window: its contract is asked for again at once (never a reason to stop)
          if (/another window/.test(text) && !closes.has(r.id)) closeTried.delete(r.id);
        }
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
    return res.end(JSON.stringify({ attestor: NAME, key: toHex(attestor.pubkey), sources: SOURCES, samples: samples.length, last: last ? { at: new Date(Number(last.atMs)).toISOString(), cents: String(last.price) } : null, words: words.size,
      markets: { ids: [...marketIds], latest: versions.at(-1) || null, versions, readAt: marketsReadMs ? new Date(marketsReadMs).toISOString() : null } }));
  }
  res.writeHead(404); res.end();
}).listen(PORT, '0.0.0.0', () => log({ step: 'up', port: PORT, mode: MODE, key: toHex(attestor.pubkey), sources: SOURCES, gameIds: GAME_IDS, readingsFromDisk: samplesFromDisk, seats: SEATS, peers: PEERS }));

await sample();
setInterval(() => sample().catch((e) => log({ step: 'sample failed', why: e.message })), SAMPLE_MS);
setInterval(() => tick().catch((e) => log({ step: 'tick failed', why: e.message })), 5000);
