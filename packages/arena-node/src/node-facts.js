// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A NODE RUNS ON, SAID TO THE NETWORK (kanban #984, the owner 2026-11-02: "Auch verfügbare cores configuration, ram, bandbreite regelmäßig scannen und erfassen und alles
// regelmäßig ans Netzwerk schicken damit andere nodes das wissen. Auch wenn die betroffene node offline ist").
//
// Each node measures itself on a schedule, signs one small record with its node key and hands it to every seat it can name; a seat keeps the newest record of each bonded
// node and passes on what is new. So the record of a node that went offline stays readable at every other seat, with its age: GET /node-facts.
//
// A NODE'S WORD ABOUT ITSELF: the signature says who said it, not that it is true. It decides nothing: no draw, no seat, no slash. It is what operators and other nodes read.
// No addresses, paths, keys or wallet figures go in it.
import os from 'node:os';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

/** How often a node measures and sends: hourly; the bandwidth, which moves real bytes, four times a day. */
export const FACTS_EVERY_MS = 3600000;
export const BANDWIDTH_EVERY_MS = 6 * 3600000;
/** What one bandwidth reading downloads from one peer. */
export const PROBE_BYTES = 1000000;
export const FACTS_MOST_BYTES = 1024;
/** A record dated further ahead than this is refused: a node cannot keep its record newest by dating it in the future. */
export const FACTS_AHEAD_MS = 300000;

const te = new TextEncoder();
/** The bytes signed: a tag, then the record's fields in one order. */
export const factsDigest = (r) => sha256(te.encode(`ARENA/v1/NodeFacts\n${JSON.stringify([r.node, r.atMs, r.facts])}`));

/** This machine, as a node can read it without asking anyone. */
export function measureFacts({ release = null, roles = [], guardian = false, bandwidthMbps = null, osApi = os, versions = process.versions } = {}) {
  const cpus = osApi.cpus() || [];
  return { cores: cpus.length, cpu: String((cpus[0] && cpus[0].model) || '').slice(0, 64), ramMb: Math.round(osApi.totalmem() / 1048576), freeRamMb: Math.round(osApi.freemem() / 1048576),
    load: osApi.loadavg().map((x) => Math.round(x * 100) / 100), platform: osApi.platform(), arch: osApi.arch(), node: versions.node, release: release ? String(release).slice(0, 32) : null,
    roles: [...roles].map(String).slice(0, 8), guardian: !!guardian, uptimeS: Math.round(osApi.uptime()), bandwidthMbps };
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
  /** Keeps a record that stands and is newer than the one held. { ok, kept } or { ok: false, why }. */
  function offer(said) {
    const r = said && said.record;
    if (!r || !/^[0-9a-f]{64}$/.test(String(r.node)) || !Number.isSafeInteger(r.atMs) || !r.facts || typeof r.facts !== 'object') return { ok: false, why: 'a record is { record: { node, atMs, facts }, signature }' };
    const text = JSON.stringify(said);
    if (text.length > FACTS_MOST_BYTES) return { ok: false, why: 'that record is too large' };
    if (r.atMs > nowMs() + FACTS_AHEAD_MS) return { ok: false, why: 'that record is dated in the future' };
    if (isBonded(r.node) === false) return { ok: false, why: 'that node holds no bond' };
    const had = db.prepare('SELECT at_ms FROM node_facts WHERE node = ?').get(r.node);
    if (had && had.at_ms >= r.atMs) return { ok: true, kept: false };
    let good = false;
    try { good = !!verify(fromHex(String(said.signature)), factsDigest(r), fromHex(r.node)); } catch { good = false; }
    if (!good) return { ok: false, why: 'that record is not signed by the node it names' };
    db.prepare('INSERT OR REPLACE INTO node_facts (node, at_ms, said, seen_ms) VALUES (?, ?, ?, ?)').run(r.node, r.atMs, text, nowMs());
    return { ok: true, kept: true };
  }
  /** Every record held, newest first, each with its age: a node's last word stays here after it went offline. */
  const list = () => db.prepare('SELECT said, at_ms FROM node_facts ORDER BY at_ms DESC').all().map((x) => ({ ...JSON.parse(x.said), ageS: Math.round((nowMs() - Number(x.at_ms)) / 1000) }));
  return { offer, list };
}
