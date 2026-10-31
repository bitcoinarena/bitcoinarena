// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET IN THE MAKING (kanban #920, docs/MARKET-CREATOR.md): the templates the form starts from, what each step still lacks, and the
// reading of a source's answer. Plain functions, so the form, the tests and later the node's own check read one rule.
import { CHECK_VERSION, marketHostProblem, marketUrlProblem } from '../../../arena-protocol/src/market-check.js';
import { MARKET_READ, MARKET_RULE, MARKET_SOURCE_KIND } from '../../../arena-protocol/src/manifest.js';
import { SOURCE_HOSTS_VERSION } from '../../../arena-protocol/src/constants.js';

export const OUTCOMES_MIN = 2, OUTCOMES_MAX = 8, TITLE_MAX = 120, READS_MAX = 3;
// FIXED, AS POLYMARKET'S TOP BAR IS (the owner 2026-10-31: "Tu die Kategorie hart verdrahten kein textfeld"): a filter needs the same word on every market
export const CATEGORIES = Object.freeze(['Crypto', 'Politics', 'Sports', 'Finance', 'Economy', 'Geopolitics', 'Tech', 'Culture', 'Climate & Science', 'World']);
export const EVERY = Object.freeze([['5m', '5 min', 300000], ['15m', '15 min', 900000], ['1h', '1 hour', 3600000], ['1d', '1 day', 86400000]]);
export const STEPS = Object.freeze([['start', 'Start'], ['question', 'Question'], ['result', 'Result'], ['test', 'Test'], ['schedule', 'Schedule'], ['sign', 'Sign']]);

const blank = { title: '', category: '', kind: 'choice', outcomes: ['Yes', 'No'], low: '', high: '',
  source: { kind: 'url', url: '', read: 'json', path: '', rule: 'above', value: '', code: '', reads: [] },
  schedule: { mode: 'once', resolveAt: '', closeBeforeMin: 60, every: '1d', rounds: 7, minStakeSat: 100 } };

export const TEMPLATES = Object.freeze([
  { id: 'price', name: 'Price above', hint: 'Is a price over a level?', icon: '↗', draft: { title: 'Is Bitcoin above $100,000?', category: 'Crypto', source: { read: 'json', path: 'data.amount', rule: 'above', value: '100000' } } },
  { id: 'updown', name: 'Up or down', hint: 'Higher or lower than at the start', icon: '⇅', draft: { title: 'Will Bitcoin close higher?', category: 'Crypto', outcomes: ['Up', 'Down'], source: { read: 'json', path: 'data.amount', rule: 'rises' }, schedule: { mode: 'repeat', every: '15m', rounds: 96 } } },
  { id: 'number', name: 'Number', hint: 'Pays by where a number lands', icon: '#', draft: { title: 'Where will the block height be?', category: 'Crypto', kind: 'number', outcomes: [], source: { read: 'text', rule: 'value' } } },
  { id: 'page', name: 'Yes or no from a page', hint: 'Does a page say it?', icon: '✓', draft: { title: '', category: 'World', source: { read: 'regex', path: '', rule: 'found' } } },
  { id: 'blank', name: 'Blank', hint: 'Start empty', icon: '+', draft: {} },
]);

// WHAT CODE CAN DO, AS EXAMPLES (the owner 2026-10-31): the node does the reading, the code decides
export const EXAMPLES = Object.freeze([
  { id: 'page', name: 'Read a page', reads: [{ id: 'btc', kind: 'http', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', subscribe: '' }],
    code: `// reads.btc is what the node read
function decide(reads, market) {
  const price = Number(reads.btc.data.amount);
  return price >= 100000 ? market.outcomes[0] : market.outcomes[1];
}
` },
  { id: 'socket', name: 'Read a socket', reads: [{ id: 'feed', kind: 'ws', url: 'wss://ws-feed.exchange.coinbase.com', subscribe: '{"type":"subscribe","product_ids":["BTC-USD"],"channels":["ticker"]}' }],
    code: `// reads.feed is the list of messages the node took from the socket
function decide(reads, market) {
  const ticks = reads.feed.filter((m) => m.type === 'ticker');
  if (!ticks.length) return market.outcomes[1];
  const last = Number(ticks[ticks.length - 1].price);
  return last >= 100000 ? market.outcomes[0] : market.outcomes[1];
}
` },
  { id: 'compute', name: 'Compute', reads: [{ id: 'coinbase', kind: 'http', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', subscribe: '' }, { id: 'binance', kind: 'http', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', subscribe: '' }],
    code: `// the average of two exchanges, rounded so every node gets the same number
function decide(reads, market) {
  const a = Number(reads.coinbase.data.amount);
  const b = Number(reads.binance.price);
  const average = Math.round((a + b) / 2 / 100) * 100;
  return average >= 100000 ? market.outcomes[0] : market.outcomes[1];
}
` },
]);

export function fromTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id) || TEMPLATES[TEMPLATES.length - 1];
  return { template: t.id, ...blank, ...t.draft, outcomes: [...(t.draft.outcomes || blank.outcomes)], source: { ...blank.source, ...t.draft.source }, schedule: { ...blank.schedule, ...t.draft.schedule } };
}

// the node's own rule for an address, so the form says what a node will say
export const urlProblem = (text, socket = false) => marketUrlProblem(text, socket) || marketHostProblem(text);

const number = (x) => (String(x).trim() !== '' && Number.isFinite(Number(x)));

/** What one step still lacks, field by field: { field: why }. Empty means the step is done. */
export function problemsOf(d, step, check = null) {
  const p = {};
  if (step === 'question') {
    if (!d.title.trim()) p.title = 'Ask a question'; else if (d.title.length > TITLE_MAX) p.title = `At most ${TITLE_MAX} characters`;
    if (!CATEGORIES.includes(d.category)) p.category = 'Pick a category';
    if (d.kind === 'number') {
      if (!number(d.low) || !number(d.high)) p.bounds = 'Two numbers'; else if (Number(d.low) >= Number(d.high)) p.bounds = 'The low bound comes first';
    } else {
      const names = d.outcomes.map((x) => x.trim());
      if (names.length < OUTCOMES_MIN || names.length > OUTCOMES_MAX) p.outcomes = `${OUTCOMES_MIN} to ${OUTCOMES_MAX} outcomes`;
      else if (names.some((x) => !x)) p.outcomes = 'Name every outcome';
      else if (new Set(names).size !== names.length) p.outcomes = 'Each outcome once';
    }
  }
  if (step === 'result' && d.source.kind === 'code') {
    const s = d.source;
    if (s.reads.length > READS_MAX) p.reads = `At most ${READS_MAX} reads`;
    for (const r of s.reads) { const bad = urlProblem(r.url, r.kind === 'ws'); if (bad) p.reads = `${r.id}: ${bad}`; if (!/^[a-z][a-zA-Z0-9]*$/.test(r.id)) p.reads = 'Name each read in letters'; }
    if (!s.code.trim()) p.code = 'Write the code'; else if (check && !check.ok) p.code = 'Fix what the check names';
  } else if (step === 'result') {
    const s = d.source; const bad = urlProblem(s.url); if (bad) p.url = bad;
    if (s.read !== 'text' && !s.path.trim()) p.path = s.read === 'json' ? 'Name the field' : 'Write the pattern';
    if (s.read === 'regex') { try { new RegExp(s.path); } catch { p.path = 'Not a valid pattern'; } }
    if ((s.rule === 'above' || s.rule === 'below') && !number(s.value)) p.value = 'A number';
  }
  if (step === 'schedule') {
    const s = d.schedule;
    if (s.mode === 'once') { if (!s.resolveAt || !(Date.parse(s.resolveAt) > Date.now())) p.resolveAt = 'A time in the future'; if (!(Number(s.closeBeforeMin) >= 1)) p.closeBeforeMin = 'At least 1 minute'; } else if (!(Number(s.rounds) >= 2 && Number(s.rounds) <= 960)) p.rounds = '2 to 960 rounds';
    if (!(Number(s.minStakeSat) >= 1)) p.minStakeSat = 'At least 1 sat';
  }
  return p;
}

/** Reads the value a source names from the answer's text. Answers { value } or { why }. */
export function readAnswer(source, text) {
  const t = String(text);
  if (source.read === 'text') return { value: t.trim() };
  if (source.read === 'regex') {
    let m; try { m = new RegExp(source.path).exec(t); } catch { return { why: 'Not a valid pattern' }; }
    if (!m) return source.rule === 'found' ? { value: '' } : { why: 'The pattern finds nothing' };
    return { value: m[1] !== undefined ? m[1] : m[0] };
  }
  let v; try { v = JSON.parse(t); } catch { return { why: 'The answer is not JSON' }; }
  for (const k of source.path.trim().split('.').filter(Boolean)) { if (v === null || typeof v !== 'object' || !(k in v)) return { why: `No field ${k}` }; v = v[k]; }
  return typeof v === 'object' ? { why: 'That field holds more than one value' } : { value: String(v) };
}

/** The fields an answer holds, as paths with their values: what the Result step offers to pick. Empty when the answer is not JSON. */
export function fieldsOf(text, most = 24) {
  let v; try { v = JSON.parse(String(text)); } catch { return []; }
  const out = [];
  const walk = (x, at, depth) => {
    if (out.length >= most || depth > 6) return;
    if (x !== null && typeof x === 'object') { for (const k of Object.keys(x)) walk(x[k], at ? `${at}.${k}` : k, depth + 1); } else if (at) out.push([at, String(x).slice(0, 40)]);
  };
  walk(v, '', 0);
  return out;
}

/** The outcome a value gives under the draft's rule. `start` is the value at the window's start, for "rises". */
export function outcomeOf(d, value, start = null) {
  const s = d.source; const [a, b] = d.outcomes;
  if (d.kind === 'number') { const n = Number(value); if (!Number.isFinite(n)) return { why: 'The value is no number' }; return { outcome: String(Math.min(Number(d.high), Math.max(Number(d.low), n))) }; }
  if (s.rule === 'found') return { outcome: value !== '' ? a : b };
  if (s.rule === 'equals') return d.outcomes.includes(String(value).trim()) ? { outcome: String(value).trim() } : { why: `${value} is no outcome` };
  const n = Number(value); if (!Number.isFinite(n)) return { why: 'The value is no number' };
  if (s.rule === 'above') return { outcome: n >= Number(s.value) ? a : b };
  if (s.rule === 'below') return { outcome: n < Number(s.value) ? a : b };
  if (s.rule === 'rises') return start === null ? { outcome: a, note: 'Compared to itself here; a round compares to its start' } : { outcome: n > Number(start) ? a : b };
  return { why: 'No rule' };
}

/** What code returned, as an outcome: an outcome's name or index, or for a number market a number within the bounds. */
export function outcomeOfCode(d, out) {
  if (d.kind === 'number') { const n = Number(out); return Number.isFinite(n) ? { outcome: String(Math.min(Number(d.high), Math.max(Number(d.low), n))) } : { why: 'The code must return a number' }; }
  if (Number.isInteger(out) && d.outcomes[out] !== undefined) return { outcome: d.outcomes[out] };
  return d.outcomes.includes(out) ? { outcome: out } : { why: `The code returned ${JSON.stringify(out)}, which is no outcome` };
}

export const KEPT = 'arena-market-draft';

const READ_OF = { json: MARKET_READ.JSON, regex: MARKET_READ.PATTERN, text: MARKET_READ.TEXT };
const RULE_OF = { above: MARKET_RULE.ABOVE, below: MARKET_RULE.BELOW, rises: MARKET_RULE.RISES, equals: MARKET_RULE.EQUALS, found: MARKET_RULE.FOUND };

/** The draft's source as a manifest carries it. */
export function manifestSource(s) {
  if (s.kind === 'code') return { kind: MARKET_SOURCE_KIND.CODE, reads: s.reads.map((r) => ({ id: r.id, socket: r.kind === 'ws', url: r.url, subscribe: r.kind === 'ws' ? r.subscribe || '' : '' })), code: s.code, checkVersion: CHECK_VERSION };
  return { kind: MARKET_SOURCE_KIND.URL, reads: [{ id: 'page', socket: false, url: s.url, subscribe: '' }], read: READ_OF[s.read], path: s.read === 'text' ? '' : s.path, rule: RULE_OF[s.rule], level: String(s.value ?? '') };
}

/** THE MANIFEST BODY OF A FINISHED DRAFT, as `signManifest` takes it. A market's nodes are drawn per round, and a number between bounds is not drawn yet, so it cannot be signed. */
export function manifestOfDraft(d, { donationSetId }) {
  if (d.kind === 'number') throw new Error('A market on a number cannot be published yet');
  const question = d.title.trim().slice(0, 64), outcomes = d.outcomes.map((o) => o.trim());
  return { gameName: question, version: 1, resultType: 'ATTESTED', cores: [], runTicksMax: 0, roundPeriodMs: '0',
    payoutRule: 'PARI_MUTUEL', rankNumerator: 0, rankDenominator: 0, minScore: 0, clients: [], gameDonationSetId: donationSetId, outcomes,
    marketTerms: { nodeFeeBps: 40, donationBps: 60, reserveBps: 20, question, resolveAfterCloseMs: '0', deadlineAfterResolveMs: '3600000', sourceRule: 'The source in this market' },
    template: { category: d.category, maxOutcomes: outcomes.length, resolveWithinMs: '2592000000' },
    attestors: [], attestThreshold: 0, attestDraw: { count: 7, threshold: 5 }, requiredProtocolVersion: SOURCE_HOSTS_VERSION, source: manifestSource(d.source) };
}
