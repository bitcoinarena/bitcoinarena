// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET IN THE MAKING (kanban #920, docs/MARKET-CREATOR.md): the templates the form starts from, what each step still lacks, and the
// reading of a source's answer. Plain functions, so the form, the tests and later the node's own check read one rule.

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

// KNOWN ADDRESSES THAT ANSWER (the owner 2026-10-31: "samples ... vom Bekannten funktionieren URLs z.B. Coinbase Binance Kraken"): each measured from a browser on the site
export const SAMPLES = Object.freeze([
  { name: 'Coinbase', hint: 'BTC/USD', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', read: 'json', path: 'data.amount' },
  { name: 'Binance', hint: 'BTC/USDT', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', read: 'json', path: 'price' },
  { name: 'Kraken', hint: 'BTC/USD', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', read: 'json', path: 'result.XXBTZUSD.c.0' },
  { name: 'Bitstamp', hint: 'BTC/USD', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', read: 'json', path: 'last' },
  { name: 'mempool.space', hint: 'Block height', url: 'https://mempool.space/api/blocks/tip/height', read: 'text', path: '' },
  { name: 'blockchain.info', hint: 'Market price', url: 'https://api.blockchain.info/stats', read: 'json', path: 'market_price_usd' },
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

/** The address a node may read: https, a name or public address, no port games, no login in it. Answers why not, or null. */
export function urlProblem(text, socket = false) {
  let u; try { u = new URL(String(text).trim()); } catch { return 'Not a full address'; }
  if (u.protocol !== (socket ? 'wss:' : 'https:')) return socket ? 'Only wss' : 'Only https';
  if (u.username || u.password) return 'No login in the address';
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return 'Only a public host';
  if (/^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith('[')) return 'Only a public host';
  return null;
}

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
