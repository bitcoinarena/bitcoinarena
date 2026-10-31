// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET IN THE MAKING (kanban #920, docs/MARKET-CREATOR.md): the templates the form starts from, what each step still lacks, and the
// reading of a source's answer. Plain functions, so the form, the tests and later the node's own check read one rule.

export const OUTCOMES_MIN = 2, OUTCOMES_MAX = 8, TITLE_MAX = 120, CATEGORY_MAX = 32;
export const EVERY = Object.freeze([['5m', '5 min', 300000], ['15m', '15 min', 900000], ['1h', '1 hour', 3600000], ['1d', '1 day', 86400000]]);
export const STEPS = Object.freeze([['start', 'Start'], ['question', 'Question'], ['result', 'Result'], ['test', 'Test'], ['schedule', 'Schedule'], ['sign', 'Sign']]);

const blank = { title: '', category: '', kind: 'choice', outcomes: ['Yes', 'No'], low: '', high: '',
  source: { url: '', read: 'json', path: '', rule: 'above', value: '' },
  schedule: { mode: 'once', resolveAt: '', closeBeforeMin: 60, every: '1d', rounds: 7, minStakeSat: 100 } };

export const TEMPLATES = Object.freeze([
  { id: 'price', name: 'Price above', hint: 'Is a price over a level?', icon: '↗', draft: { title: 'Is Bitcoin above $100,000?', category: 'Crypto', source: { read: 'json', path: 'data.amount', rule: 'above', value: '100000' } } },
  { id: 'updown', name: 'Up or down', hint: 'Higher or lower than at the start', icon: '⇅', draft: { title: 'Will Bitcoin close higher?', category: 'Crypto', outcomes: ['Up', 'Down'], source: { read: 'json', path: 'data.amount', rule: 'rises' }, schedule: { mode: 'repeat', every: '15m', rounds: 96 } } },
  { id: 'number', name: 'Number', hint: 'Pays by where a number lands', icon: '#', draft: { title: 'Where will the block height be?', category: 'Bitcoin', kind: 'number', outcomes: [], source: { read: 'text', rule: 'value' } } },
  { id: 'page', name: 'Yes or no from a page', hint: 'Does a page say it?', icon: '✓', draft: { title: '', category: 'News', source: { read: 'regex', path: '', rule: 'found' } } },
  { id: 'blank', name: 'Blank', hint: 'Start empty', icon: '+', draft: {} },
]);

export function fromTemplate(id) {
  const t = TEMPLATES.find((x) => x.id === id) || TEMPLATES[TEMPLATES.length - 1];
  return { template: t.id, ...blank, ...t.draft, outcomes: [...(t.draft.outcomes || blank.outcomes)], source: { ...blank.source, ...t.draft.source }, schedule: { ...blank.schedule, ...t.draft.schedule } };
}

/** The address a node may read: https, a name or public address, no port games, no login in it. Answers why not, or null. */
export function urlProblem(text) {
  let u; try { u = new URL(String(text).trim()); } catch { return 'Not a full address'; }
  if (u.protocol !== 'https:') return 'Only https';
  if (u.username || u.password) return 'No login in the address';
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return 'Only a public host';
  if (/^(10|127|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith('[')) return 'Only a public host';
  return null;
}

const number = (x) => (String(x).trim() !== '' && Number.isFinite(Number(x)));

/** What one step still lacks, field by field: { field: why }. Empty means the step is done. */
export function problemsOf(d, step) {
  const p = {};
  if (step === 'question') {
    if (!d.title.trim()) p.title = 'Ask a question'; else if (d.title.length > TITLE_MAX) p.title = `At most ${TITLE_MAX} characters`;
    if (!d.category.trim()) p.category = 'Name a category'; else if (d.category.length > CATEGORY_MAX) p.category = `At most ${CATEGORY_MAX} characters`;
    if (d.kind === 'number') {
      if (!number(d.low) || !number(d.high)) p.bounds = 'Two numbers'; else if (Number(d.low) >= Number(d.high)) p.bounds = 'The low bound comes first';
    } else {
      const names = d.outcomes.map((x) => x.trim());
      if (names.length < OUTCOMES_MIN || names.length > OUTCOMES_MAX) p.outcomes = `${OUTCOMES_MIN} to ${OUTCOMES_MAX} outcomes`;
      else if (names.some((x) => !x)) p.outcomes = 'Name every outcome';
      else if (new Set(names).size !== names.length) p.outcomes = 'Each outcome once';
    }
  }
  if (step === 'result') {
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

export const KEPT = 'arena-market-draft';
