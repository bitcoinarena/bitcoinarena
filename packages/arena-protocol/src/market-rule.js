// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A URL SOURCE AS CODE (kanban #920): a market that names a field and a rule runs the same way as one that brings code, in the same sandbox, stopped at the same limit,
// because a pattern from a stranger can hang a node as well as a loop can. The function below is fixed; the market only fills in its values, as JSON text.
import { MARKET_SOURCE_KIND, MARKET_READ, MARKET_RULE } from './manifest.js';

/** The code a source runs: its own, or the fixed function for its field and rule. */
export function codeOfSource(s) {
  if (s.kind === MARKET_SOURCE_KIND.CODE) return s.code;
  return `const SOURCE = ${JSON.stringify({ id: s.reads[0].id, read: s.read, path: s.path, rule: s.rule, level: s.level })};
function valueOf(answer) {
  if (SOURCE.read === ${MARKET_READ.TEXT}) return String(answer).trim();
  if (SOURCE.read === ${MARKET_READ.PATTERN}) {
    const m = new RegExp(SOURCE.path).exec(typeof answer === 'string' ? answer : JSON.stringify(answer));
    if (!m) return '';
    return m[1] !== undefined ? m[1] : m[0];
  }
  let v = answer;
  for (const k of SOURCE.path.split('.')) {
    if (v === null || typeof v !== 'object') throw new Error('no field ' + k);
    v = v[k];
  }
  return String(v);
}
function decide(reads, market) {
  const value = valueOf(reads[SOURCE.id]);
  const n = Number(value), [yes, no] = market.outcomes || [];
  if (SOURCE.rule === ${MARKET_RULE.VALUE}) return n;
  if (SOURCE.rule === ${MARKET_RULE.FOUND}) return value !== '' ? yes : no;
  if (SOURCE.rule === ${MARKET_RULE.EQUALS}) return value;
  if (!Number.isFinite(n)) throw new Error('the value is no number');
  if (SOURCE.rule === ${MARKET_RULE.ABOVE}) return n >= Number(SOURCE.level) ? yes : no;
  if (SOURCE.rule === ${MARKET_RULE.BELOW}) return n < Number(SOURCE.level) ? yes : no;
  return n > Number(market.start) ? yes : no;
}
`;
}

/** What code returned, as the outcome's index, or null when it names none. */
export function outcomeIndex(out, outcomes) {
  if (Number.isInteger(out) && out >= 0 && out < outcomes.length) return out;
  const i = outcomes.indexOf(out);
  return i >= 0 ? i : null;
}
