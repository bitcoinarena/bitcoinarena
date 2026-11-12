// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A NODE RUNS ON, SAID TO THE NETWORK (kanban #984, the owner 2026-11-02: "Auch verfügbare cores configuration, ram, bandbreite regelmäßig scannen und erfassen und alles
// regelmäßig ans Netzwerk schicken damit andere nodes das wissen. Auch wenn die betroffene node offline ist").
//
// The owner 2026-11-02: "Bandbreite nur einmal messen, und land und Anzahl Cores. ram und load regelmaessig und ans Netzwerk schicken": cores, country and bandwidth are measured
// once and kept; RAM and load are read each hour. Each record is signed with the node key and handed to every seat it can name; a seat keeps the newest record of each bonded
// node and passes on what is new. So the record of a node that went offline stays readable at every other seat, with its age: GET /node-facts.
//
// A NODE'S WORD ABOUT ITSELF: the signature says who said it, not that it is true. It decides nothing: no draw, no seat, no slash. It is what operators and other nodes read.
// No addresses, paths, keys or wallet figures go in it.
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** How often a node reads its RAM and load and sends them. */
export const FACTS_EVERY_MS = 3600000;
/** What one bandwidth reading downloads from one peer. */
export const PROBE_BYTES = 1000000;
export const FACTS_MOST_BYTES = 1024;
/** A record dated further ahead than this is refused: a node cannot keep its record newest by dating it in the future. */
export const FACTS_AHEAD_MS = 300000;
/**
 * The least time between two kept records of one node (kanban #2425): a seat hands every kept record on to every seat it knows, so a node that dated its records 1 ms apart
 * had each one verified, written and fanned out S x S times across the network. A record dated less than this after the held one is not kept, so not passed on.
 */
export const FACTS_KEEP_GAP_MS = FACTS_EVERY_MS / 4;

const te = new TextEncoder();
/** The bytes signed: a tag, then the record's fields in one order. */
export const factsDigest = (r) => sha256(te.encode(`ARENA/v1/NodeFacts\n${JSON.stringify([r.node, r.atMs, r.facts])}`));

/** This machine, as a node can read it without asking anyone. */
export function measureFacts({ release = null, commit = null, roles = [], guardian = false, once = {}, osApi = os, versions = process.versions } = {}) {
  const cpus = osApi.cpus() || [];
  return { cores: once.cores ?? cpus.length, country: once.country ?? null, colo: once.colo ?? null, bandwidthMbps: once.bandwidthMbps ?? null, cpu: String((cpus[0] && cpus[0].model) || '').slice(0, 64), ramMb: Math.round(osApi.totalmem() / 1048576), freeRamMb: Math.round(osApi.freemem() / 1048576),
    load: osApi.loadavg().map((x) => Math.round(x * 100) / 100), platform: osApi.platform(), os: osName({ osApi }), kernel: String(osApi.release()).slice(0, 32), arch: osApi.arch(), node: versions.node, release: release ? String(release).slice(0, 32) : null, commit: commit ? String(commit).slice(0, 12) : null,
    roles: [...roles].map(String).slice(0, 8), guardian: !!guardian, uptimeS: Math.round(osApi.uptime()) };
}

/**
 * WHERE THIS MACHINE IS, FOUND HERE AND NEVER AS AN ADDRESS (the owner 2026-11-02: "herkunft, nicht ip senden aber selber erfassen und senden"): Cloudflare's trace names its country
 * and the data centre it reached. Only those two are read; the line with the address is dropped and goes nowhere. Null when unknown.
 */
export async function measureOrigin({ fetcher = fetch } = {}) {
  try {
    const r = await fetcher('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(10000) });
    const t = await r.text();
    const loc = /^loc=([A-Z]{2})$/m.exec(t), colo = /^colo=([A-Z]{3})$/m.exec(t);
    return loc ? { country: loc[1], colo: colo ? colo[1] : null } : null;
  } catch { return null; }
}

/** The operating system's name: its pretty name on Linux, else the type and release. */
export function osName({ osApi = os, read = readFileSync } = {}) {
  try { const m = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(String(read('/etc/os-release', 'utf8'))); if (m) return m[1].slice(0, 48); } catch { /* no such file: not Linux */ }
  return `${osApi.type()} ${osApi.release()}`.slice(0, 48);
}

/** The download speed from a few peers, Mbit/s, the middle reading; null with none answering. */
export async function measureBandwidth(peers, { fetcher = fetch, nowMs = () => Date.now(), most = 3 } = {}) {
  const got = [];
  for (const base of peers.slice(0, most)) {
    try {
      const t = nowMs();
      const r = await fetcher(`${base}/node-facts/probe`, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) continue;
      const bytes = (await r.arrayBuffer()).byteLength;
      const ms = nowMs() - t;
      if (bytes >= PROBE_BYTES && ms > 0) got.push(Math.round((bytes * 8) / (ms * 1000) * 10) / 10);
    } catch { /* that peer next time */ }
  }
  return got.length ? got.sort((a, b) => a - b)[Math.floor(got.length / 2)] : null;
}

/** One signed record: { record: { node, atMs, facts }, signature } as hex. */
export function signFacts({ node, atMs, facts, sign }) {
  const record = { node: toHex(node), atMs, facts };
  return { record, signature: toHex(sign(factsDigest(record))) };
}

/** The seat's book of what nodes said. `isBonded(hex)`: true, false, or null while unknown (taken: a seat that reads no census yet refuses nobody). */
export function createNodeFactsBook({ db, verify, isBonded = () => null, nowMs = () => Date.now() }) {
  db.exec('CREATE TABLE IF NOT EXISTS node_facts (node TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, said TEXT NOT NULL, seen_ms INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS node_facts_once (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  /** What this node measures once: kept, so a restart does not measure it again. `measure()` runs only for a value still missing. */
  async function once(key, measure) {
    const had = db.prepare('SELECT value FROM node_facts_once WHERE key = ?').get(key);
    if (had) return JSON.parse(had.value);
    const v = await measure();
    if (v !== null && v !== undefined) db.prepare('INSERT OR REPLACE INTO node_facts_once (key, value) VALUES (?, ?)').run(key, JSON.stringify(v));
    return v ?? null;
  }
  /** Keeps a record that stands and is at least FACTS_KEEP_GAP_MS newer than the one held. { ok, kept } or { ok: false, why }. */
  function offer(said) {
    const r = said && said.record;
    if (!r || !/^[0-9a-f]{64}$/.test(String(r.node)) || !Number.isSafeInteger(r.atMs) || !r.facts || typeof r.facts !== 'object') return { ok: false, why: 'a record is { record: { node, atMs, facts }, signature }' };
    const text = JSON.stringify(said);
    if (text.length > FACTS_MOST_BYTES) return { ok: false, why: 'that record is too large' };
    if (r.atMs > nowMs() + FACTS_AHEAD_MS) return { ok: false, why: 'that record is dated in the future' };
    if (isBonded(r.node) === false) return { ok: false, why: 'that node holds no bond' };
    const had = db.prepare('SELECT at_ms FROM node_facts WHERE node = ?').get(r.node);
    if (had && had.at_ms >= r.atMs) return { ok: true, kept: false };
    if (had && r.atMs - had.at_ms < FACTS_KEEP_GAP_MS) return { ok: true, kept: false }; // kanban #2425: at most one kept (and passed on) per FACTS_KEEP_GAP_MS
    let good = false;
    try { good = !!verify(fromHex(String(said.signature)), factsDigest(r), fromHex(r.node)); } catch { good = false; }
    if (!good) return { ok: false, why: 'that record is not signed by the node it names' };
    db.prepare('INSERT OR REPLACE INTO node_facts (node, at_ms, said, seen_ms) VALUES (?, ?, ?, ?)').run(r.node, r.atMs, text, nowMs());
    return { ok: true, kept: true };
  }
  /** Every record held, newest first, each with its age: a node's last word stays here after it went offline. */
  const list = () => db.prepare('SELECT said, at_ms FROM node_facts ORDER BY at_ms DESC').all().map((x) => ({ ...JSON.parse(x.said), ageS: Math.round((nowMs() - Number(x.at_ms)) / 1000) }));
  return { offer, list, once };
}
