// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET'S CODE MUST BE READABLE (kanban #920, the owner 2026-10-31: "alles was verschleiert wird oder was Code verbirgt oder komprimiert etc. ist
// verboten"; docs/MARKET-CREATOR.md). One rule for the editor and every node, so all of them answer alike. It reads the parsed tree, never the text
// alone. It does not prove code safe: the sandbox does that. It keeps code a person can read, and one failed rule refuses the market.
// `parse` is acorn's, handed in: this file stays free of imports and runs in the page and on a node.

export const CHECK_VERSION = 1;
export const CODE_MAX_BYTES = 32768, LINE_MAX = 200, STRING_MAX = 200;

const FORBIDDEN = new Set(['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'globalThis', 'window', 'self', 'global', 'process', 'require', 'module', 'exports',
  'WebAssembly', 'Proxy', 'Reflect', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'importScripts', 'constructor', 'prototype', '__proto__', '__defineGetter__', '__defineSetter__',
  'setTimeout', 'setInterval', 'queueMicrotask', 'atob', 'btoa', 'fromCharCode', 'fromCodePoint', 'unescape', 'decodeURIComponent', 'decodeURI', 'Buffer', 'TextDecoder', 'Date', 'performance', 'crypto']);
const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

/** Shannon entropy of a text, in bits per character. */
function entropy(text) {
  const n = new Map(); for (const c of text) n.set(c, (n.get(c) || 0) + 1);
  let h = 0; for (const v of n.values()) { const p = v / text.length; h -= p * Math.log2(p); }
  return h;
}

function packedText(s) {
  if (s.length > STRING_MAX) return `a string over ${STRING_MAX} characters`;
  if (s.length >= 40 && /^[A-Za-z0-9+/_=-]+$/.test(s)) return 'packed text (Base64 or hex)';
  if (s.length >= 40 && !/\s/.test(s) && !/^https?:/.test(s) && entropy(s) > 4.6) return 'text that looks packed';
  return null;
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') walk(x, visit, node); } else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

/** The market's code against every rule: { ok, version, problems: [{ rule, line, why }] }. */
export function checkMarketCode(code, parse, entry = 'decide') {
  const problems = []; const say = (rule, line, why) => { if (problems.length < 30) problems.push({ rule, line, why }); };
  const text = String(code);
  if (new TextEncoder().encode(text).length > CODE_MAX_BYTES) say('size', 1, `Over ${CODE_MAX_BYTES / 1024} KB`);
  text.split('\n').forEach((l, i) => {
    if (l.length > LINE_MAX) say('minified', i + 1, `Line over ${LINE_MAX} characters`);
    if (HIDDEN_CHARS.test(l)) say('hidden', i + 1, 'Invisible characters');
  });
  let tree;
  try { tree = parse(text, { ecmaVersion: 2022, sourceType: 'script', locations: true }); } catch (e) { say('parse', (e.loc && e.loc.line) || 1, 'Does not parse: ' + String(e.message).replace(/ \(\d+:\d+\)$/, '')); return { ok: false, version: CHECK_VERSION, problems }; }
  const top = tree.body.filter((n) => n.type === 'FunctionDeclaration' && n.id.name === entry);
  if (top.length !== 1) say('decide', 1, entry === 'decide' ? 'Needs one function decide(reads, market)' : `Needs one function ${entry}`);
  for (const n of tree.body) if (!['FunctionDeclaration', 'VariableDeclaration'].includes(n.type)) say('top', n.loc.start.line, 'Only functions and constants at the top');
  let names = 0, short = 0;
  walk(tree, (n, parent) => {
    const line = n.loc.start.line;
    if (n.type === 'Identifier' || n.type === 'PrivateIdentifier') {
      const propertyName = parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed;
      const keyName = parent && parent.type === 'Property' && parent.key === n && !parent.computed;
      if (FORBIDDEN.has(n.name)) { if (!keyName || n.name === '__proto__') say('forbidden', line, `${n.name} is not allowed`); }
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n.name)) say('hidden', line, 'Names in plain letters only');
      if (text.slice(n.start, n.end) !== n.name) say('hidden', line, 'Escapes in a name');
      if (!propertyName && !keyName) { names++; if (n.name.length === 1) short++; }
    }
    if (n.type === 'Literal' && typeof n.value === 'string') {
      if (/\\[xu0-7]/.test(n.raw)) say('hidden', line, 'Escapes in a string');
      if (FORBIDDEN.has(n.value)) say('forbidden', line, `${n.value} is not allowed`);
      const p = packedText(n.value); if (p) say('packed', line, p);
    }
    if (n.type === 'TemplateElement') { if (/\\[xu0-7]/.test(n.value.raw)) say('hidden', line, 'Escapes in a string'); const p = packedText(n.value.cooked || ''); if (p) say('packed', line, p); }
    if (n.type === 'Literal' && n.regex && n.regex.pattern.length > 100) say('packed', line, 'A very long pattern');
    if (n.type === 'ImportExpression' || n.type === 'MetaProperty') say('forbidden', line, 'Loading code is not allowed');
    if (n.type === 'WithStatement' || n.type === 'DebuggerStatement') say('forbidden', line, `${n.type === 'WithStatement' ? 'with' : 'debugger'} is not allowed`);
    if (n.type === 'TaggedTemplateExpression') say('forbidden', line, 'Tagged templates are not allowed');
    if (n.type === 'ThisExpression') say('forbidden', line, 'this is not allowed');
    if (n.type === 'AwaitExpression' || n.type === 'YieldExpression' || ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && (n.async || n.generator))) say('forbidden', line, 'Async code is not allowed');
    // list[list.length - 1] is arithmetic; only text put together to name a property hides anything
    if (n.type === 'MemberExpression' && n.computed && n.property.type !== 'Literal') {
      let text2 = false;
      walk(n.property, (x) => { if (x.type === 'TemplateLiteral' || (x.type === 'Literal' && typeof x.value === 'string')) text2 = true; });
      if (text2) say('hidden', line, 'A property named by a computed text');
    }
    if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === 'Math' && n.property.name === 'random') say('forbidden', line, 'Math.random gives each node another answer');
  });
  if (names >= 20 && short / names > 0.6) say('minified', 1, 'Mostly one-letter names');
  return { ok: problems.length === 0, version: CHECK_VERSION, problems };
}

// ONLY LISTED SOURCES (the owner 2026-10-31: "Ein attacker kann eine beliebige Seite angeben die ein manipuliertes Ergebnis bereitstellt"): 5 of 7 is no defence when all seven read
// one page its author controls, so a market may read only hosts that no market creator runs. This is the list's start; the bonded nodes change it by ballot
// (class SOURCES, ballot.js), each change a full new list, and a round is judged by the list live at its census height, so every seat judges it alike.
// From docs/MARKET-SOURCES.md, with the owner's ruling of 2026-10-31: "Tu Coinbase und und bit stamp ein. Das Projekt ist nicht kommerziell also Binance rein. Polymarket auch rein"
export const MARKET_HOSTS = Object.freeze([
  'api.coinbase.com', 'api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com', 'www.bitstamp.net', 'api.binance.com', 'data-api.binance.vision', 'gamma-api.polymarket.com',
  'mempool.space', 'blockstream.info', 'api.blockchain.info',
  'data-api.ecb.europa.eu', 'markets.newyorkfed.org', 'api.fiscaldata.treasury.gov', 'ec.europa.eu', 'api.beta.ons.gov.uk', 'www.ons.gov.uk', 'api.bls.gov',
  'api.weather.gov', 'aviationweather.gov', 'data.geo.admin.ch', 'www.bundeswahlleiterin.de']);
export function marketHostProblem(text, hosts = MARKET_HOSTS) {
  let h; try { h = new URL(String(text).trim()).hostname.toLowerCase(); } catch { return 'Not a full address'; }
  return hosts.includes(h) ? null : `${h} is not a listed source`;
}

// NO HOST WITHOUT AN EXAMPLE (the owner 2026-10-31: "Die Votings für neue Quellen müssen auch ein example beinhalten und das wird live in der ui validiert und getestet, ohne gehts nicht raus"):
// the list a proposal carries names, per host, a working read and its documentation, so a voter can try what is voted on and a node can refuse what does not answer.
// A SOCKET THAT NEEDS STARTING (the owner 2026-10-31: "braucht es eine code section im Voting dass es korrekt initialisiert wird. Hier wieder die sandbox und Blockierung von
// malicious code"): `init`, one line of JSON text in the list, is code under the same check and in the same sandbox as a market's. Voted with the host, it starts every socket read of that host.
const FIELDS = ['host', 'url', 'read', 'path', 'docs', 'init'];
const fieldOut = (e, k) => (k === 'init' ? (e.init ? JSON.stringify(String(e.init)) : '') : String(e[k] ?? '').replace(/[\t\r\n]+/g, ' '));
const fieldIn = (x, k) => (k === 'init' ? (x ? JSON.parse(x) : '') : x);
/** The list as a proposal carries it: sorted by host, each host once, its fields tab-separated, so one list has one hash. */
export const encodeSourceList = (entries) => new TextEncoder().encode([...new Map(entries.map((e) => [e.host, e])).values()].sort((a, b) => (a.host < b.host ? -1 : 1))
  .map((e) => FIELDS.map((k) => fieldOut(e, k)).join('\t')).join('\n'));
export const decodeSourceList = (bytes) => new TextDecoder().decode(bytes).split('\n').filter(Boolean).map((l) => Object.fromEntries(l.split('\t').map((x, i) => [FIELDS[i], fieldIn(x, FIELDS[i])])));
export const decodeHostList = (bytes) => decodeSourceList(bytes).map((e) => e.host);
/** Why these bytes are no list of hosts a market may read, or null. */
export function hostListProblem(bytes) {
  let list; try { list = decodeSourceList(bytes); } catch { return 'A list is sorted, each host once'; }
  if (!list.length) return 'A list names at least one host';
  if (list.length > 256) return 'A list names at most 256 hosts';
  const canonical = encodeSourceList(list);
  if (canonical.length !== bytes.length || canonical.some((x, i) => x !== bytes[i])) return 'A list is sorted, each host once';
  for (const e of list) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e.host) || marketUrlProblem(`https://${e.host}/`)) return `${e.host} is not a public host name`;
    const socket = String(e.url).startsWith('wss:');
    if (marketUrlProblem(e.url, socket) || new URL(e.url).hostname !== e.host) return `${e.host} needs an example address on that host`;
    if (!['json', 'regex', 'text'].includes(e.read) || (e.read !== 'text' && !e.path)) return `${e.host} needs an example that names what it reads`;
    if (!/^https:\/\/\S+$/.test(String(e.docs))) return `${e.host} needs a link to its documentation`;
    if (e.init && !socket) return `${e.host} starts no socket, so it takes no init code`;
  }
  return null;
}

/** THE ADDRESS A NODE MAY READ FOR A MARKET: https (wss for a socket), a public host, no login in it. Answers why not, or null. */
export function marketUrlProblem(text, socket = false) {
  let u; try { u = new URL(String(text).trim()); } catch { return 'Not a full address'; }
  if (u.protocol !== (socket ? 'wss:' : 'https:')) return socket ? 'Only wss' : 'Only https';
  if (u.username || u.password) return 'No login in the address';
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.ts.net') || !h.includes('.') || h.startsWith('[') || privateAddress(h)) return 'Only a public host';
  return null;
}

/** Is this resolved address a machine of ours rather than the public internet: loopback, private, link-local, carrier-grade NAT, metadata? */
export function privateAddress(ip) {
  const a = String(ip).toLowerCase().replace(/^::ffff:/, '');
  if (a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 100 && y >= 64 && y < 128) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168);
}
