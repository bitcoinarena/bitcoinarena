// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// HOW MUCH THE NODE SAYS (kanban #693, 2026-10-26: "add a --debug and --verbose flag that shows more info on what its doing, what is
// going wrong etc"). One level for every program of a node - the bitcoinarena command, the installer, the update, the seat and its services:
//
//   info      what each program says today, line for line (the default: nothing here changes it)
//   verbose   each step as it runs: which URL, file, service or port it checks, what answered, how long it took
//   debug     verbose, and the insides: full error stacks, the status and a short body of a failed request, every child process's
//             command line, exit code and last stderr lines, the names (never the values) of the settings that decided something
//
// Where the level comes from: a flag (--verbose / -v, --debug, --log-level <level>) over ARENA_LOG_LEVEL over arena.conf log_level
// (that one only for the long-running services: `bitcoinarena config set log_level debug`, then a restart). A word that is no level is
// said once and read as info.
//
// NOTHING SECRET IS PRINTED, at any level: every verbose and debug line goes through redact() - by key name (password, macaroon,
// cookie, seed, token, owner key, ...) and by pattern (Basic/Bearer auth, user:pass@ in a URL, ?t= and ?token= in a link, a bitcoind
// cookie, a long hex run such as a macaroon, nsec / xprv / tprv keys, a PEM private key, 12 or more BIP-39 words in a row).
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConf } from './arena-conf.js';
import { BIP39_ENGLISH } from '../../arena-client/src/bip39-wordlist.js';

export const LEVELS = Object.freeze(['info', 'verbose', 'debug']);
const RANK = { info: 0, verbose: 1, debug: 2 };

/** A level's word, or null when it is none ('v' and 'trace' are not levels: the flags say -v and --debug). */
export const levelWord = (v) => { const w = String(v ?? '').trim().toLowerCase(); return RANK[w] !== undefined ? w : null; };

/**
 * The level flags taken out of a command line: { level (null when none given), rest (the arguments without them), bad }.
 * --debug wins over --verbose; --log-level <level> or --log-level=<level> names one.
 */
export function levelFlags(args) {
  let level = null, bad = null;
  const rest = [];
  const take = (w) => { const l = levelWord(w); if (!l) { bad = `"${w}" is no log level (${LEVELS.join(', ')})`; return; } if (level === null || RANK[l] > RANK[level]) level = l; };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--debug') take('debug');
    else if (a === '--verbose' || a === '-v') take('verbose');
    else if (a === '--log-level') take(args[++i]);
    else if (typeof a === 'string' && a.startsWith('--log-level=')) take(a.slice(12));
    else rest.push(a);
  }
  return { level, rest, bad };
}

/** The level that holds and where it came from: { level, from, bad }. `conf` arena.conf's values (the services' only). */
export function levelOf({ flag = null, env = process.env, conf = null } = {}) {
  if (flag) return { level: flag, from: `--${flag}`, bad: null };
  const e = env && env.ARENA_LOG_LEVEL;
  if (e !== undefined && e !== null && e !== '') {
    const l = levelWord(e);
    return l ? { level: l, from: 'ARENA_LOG_LEVEL', bad: null } : { level: 'info', from: 'default', bad: `ARENA_LOG_LEVEL "${e}" is no log level (${LEVELS.join(', ')}): info` };
  }
  const c = conf ? conf.log_level : undefined;
  if (c !== undefined && c !== null && c !== '') {
    const l = levelWord(c);
    return l ? { level: l, from: 'arena.conf log_level', bad: null } : { level: 'info', from: 'default', bad: `arena.conf log_level "${c}" is no log level (${LEVELS.join(', ')}): info` };
  }
  return { level: 'info', from: 'default', bad: null };
}

/** arena.conf's values at `home` ({} when it does not read). */
export const confValuesAt = (home) => { try { return parseConf(readFileSync(join(home, 'arena.conf'), 'utf8')).values || {}; } catch { return {}; } };

// ---- REDACTION -------------------------------------------------------------------------------------------------------------------
// A KEY NAME THAT HOLDS A SECRET: its value never printed (a value that is plainly a file's path is no secret: cookie paths, macaroon paths).
// The name is read in its parts (bitcoind_cookie, macaroonHex, owner-key), so a word that only holds the letters ("inside", "authority") is none
// (a strong word inside a part counts too: rpcpassword, macaroonpath - whose value, a path, is kept)
const SECRET_PART = /^(pass|pwd|seed|seeds|nsec|priv|private|privkey|prv|apikey|auth|authorization|credential|credentials|session|sessions|sid)$/;
const SECRET_INSIDE = /(password|passwd|passphrase|secret|token|macaroon|cookie|mnemonic)/;
const SECRET_JOINED = /(owner_key|api_key|private_key|seed_hex)/;
export function secretName(key) {
  const parts = String(key || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some((p) => SECRET_PART.test(p) || SECRET_INSIDE.test(p)) || SECRET_JOINED.test(parts.join('_'));
}
const PATHLIKE = /^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])[^\s]*$/;
const MASK = '***';
const WORDS = new Set(BIP39_ENGLISH);
const SEED_RUN = 12;
const keepValue = (v) => PATHLIKE.test(v) || /^\*+/.test(v) || /^(null|undefined|true|false|none|missing|set|unset|yes|no|0|1)$/i.test(v);

/** One value under its key: masked when the key names a secret (a file path kept). */
export function redactValue(key, value) {
  if (!secretName(key) || value === undefined || value === null || value === '') return value;
  return typeof value === 'string' && PATHLIKE.test(value) ? value : MASK;
}

/** An object with every secret-named key's value masked, deep (for a debug dump). */
export function redactObject(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return typeof v === 'string' ? redact(v) : v;
  if (Array.isArray(v)) return v.map((x) => redactObject(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = x !== null && typeof x === 'object' ? redactObject(x, depth + 1) : secretName(k) ? redactValue(k, x) : redactObject(x, depth + 1);
  return out;
}

/** 12 or more BIP-39 words in a row (a seed phrase, numbered or not), masked. */
function redactSeedRuns(text) {
  const words = []; const re = /[A-Za-z]+/g; let m;
  while ((m = re.exec(text))) words.push({ w: m[0].toLowerCase(), s: m.index, e: m.index + m[0].length });
  const spans = [];
  let start = null, prev = null, count = 0;
  for (const x of words) {
    const listed = WORDS.has(x.w);
    if (listed && start && /^[\s\d.,;()"'[\]-]*$/.test(text.slice(prev.e, x.s))) { count++; prev = x; continue; }
    if (start && count >= SEED_RUN) spans.push([start.s, prev.e]);
    start = listed ? x : null; count = listed ? 1 : 0; prev = x;
  }
  if (start && count >= SEED_RUN) spans.push([start.s, prev.e]);
  let t = text;
  for (const [s, e] of spans.reverse()) t = `${t.slice(0, s)}${MASK}(seed words)${t.slice(e)}`;
  return t;
}

/** A line with every secret in it masked: by key name and by pattern. */
export function redact(text) {
  // the seed words first: a phrase under a key is masked whole, not only its first word
  let t = redactSeedRuns(String(text ?? ''));
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, `-----PRIVATE KEY ${MASK}-----`);
  t = t.replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{4,}/g, `$1 ${MASK}`);
  t = t.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`);
  t = t.replace(/__cookie__:[^\s"',;]+/g, `__cookie__:${MASK}`);
  t = t.replace(/([?&#](?:t|token|key|secret|sid|session|macaroon|password|pass|auth|seed)=)[^&\s#"']+/gi, `$1${MASK}`);
  t = t.replace(/\b(nsec1[02-9ac-hj-np-z]{20,}|[xtyzuv]prv[1-9A-HJ-NP-Za-km-z]{50,})/g, MASK);
  // key=value, key: value, "key":"value with spaces" (all of a quoted value, to its closing quote or the line's end) - the key naming a secret
  // A key that is no secret gives up only itself, so its value is read again as a key ("release: token=..." masks the token)
  {
    const re = /(["']?)([A-Za-z][A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(?:"([^"]*)("|$)|'([^']*)('|$)|([^\s"',;&}\]]+))/g;
    let out = '', at = 0, m;
    while ((m = re.exec(t))) {
      const [all, q1, k, sep, dq, dqEnd, sq, sqEnd, bare] = m;
      const v = dq ?? sq ?? bare ?? '';
      if (!secretName(k) || keepValue(v)) { re.lastIndex = m.index + q1.length + k.length + sep.length; continue; }
      out += t.slice(at, m.index) + (dq !== undefined ? `${q1}${k}${sep}"${MASK}${dqEnd}` : sq !== undefined ? `${q1}${k}${sep}'${MASK}${sqEnd}` : `${q1}${k}${sep}${MASK}`);
      at = m.index + all.length;
    }
    t = out + t.slice(at);
  }
  // --key value: a command line's flag naming a secret
  t = t.replace(/(--[A-Za-z][A-Za-z0-9_.-]*)(\s+)(["']?)([^\s"'-][^\s"']*)/g, (m, k, sp, q, v) => (secretName(k) && !keepValue(v) ? `${k}${sp}${q}${MASK}` : m));
  t = t.replace(/\b[0-9a-fA-F]{96,}\b/g, (h) => `${MASK}(${h.length} hex)`);
  return t;
}

/** A command line, printable: each argument after a secret-named flag masked, then the whole redacted. */
export function redactArgs(args) {
  const out = [];
  for (let i = 0; i < (args || []).length; i++) {
    const a = String(args[i]);
    out.push(i > 0 && /^--?[A-Za-z]/.test(String(args[i - 1])) && !String(args[i - 1]).includes('=') && secretName(String(args[i - 1]).replace(/^--?/, '')) && !PATHLIKE.test(a) ? MASK : a);
  }
  return redact(out.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' '));
}

// ---- THE LOG -------------------------------------------------------------------------------------------------------------------

/**
 * A log at `level`: { level, at(l), verbose(line), debug(line), fail(what, error), env(names, why), tag(t), since(t0) }.
 * `write` takes each line (stderr by default: what a command prints on stdout stays as it is). Lines are `[tag] text`, redacted.
 */
export function createLog({ level = 'info', tag = '', write = (l) => process.stderr.write(`${l}\n`) } = {}) {
  const lvl = levelWord(level) || 'info';
  const at = (l) => RANK[lvl] >= RANK[l];
  const line = (t, text) => write(redact(t ? `[${t}] ${text}` : String(text)));
  const make = (t) => ({
    level: lvl,
    at,
    get verboseOn() { return at('verbose'); },
    get debugOn() { return at('debug'); },
    verbose: (text) => { if (at('verbose')) line(t, typeof text === 'function' ? text() : text); },
    debug: (text) => { if (at('debug')) line(t, typeof text === 'function' ? text() : text); },
    /** A failure: its message at verbose, its stack (and cause) at debug. */
    fail: (what, e) => {
      if (!at('verbose')) return;
      const msg = e && e.message ? e.message : String(e);
      line(t, `${what}: ${msg}`);
      if (at('debug') && e && e.stack) {
        line(t, `${what}, stack:\n${String(e.stack).split('\n').slice(1).join('\n')}`);
        if (e.cause) line(t, `${what}, cause: ${e.cause.code || ''} ${e.cause.message || e.cause}`.trim());
      }
    },
    /** The names of the settings that decided something, and whether each was set - never their values. */
    env: (names, why, env = process.env) => { if (at('debug')) line(t, `${why}: ${names.map((n) => `${n} ${env[n] !== undefined && env[n] !== '' ? '(set)' : '(not set)'}`).join(', ')}`); },
    tag: (x) => make(x),
    since: (t0) => `${Math.round(performance.now() - t0)} ms`,
  });
  return make(tag);
}
/** The log that says nothing beyond info (the default everywhere a log is not handed in). */
export const QUIET = createLog({ level: 'info', write: () => {} });

// ---- WHAT THE PROGRAM DOES, TRACED ---------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
// redacted whole before it is cut: a secret cut in half would no longer match its pattern
const lastLines = (s, n = 3) => redact(String(s || '')).trim().split(/\r?\n/).filter(Boolean).slice(-n).map((l) => l.slice(0, 240)).join(' | ');
const shortUrl = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}${x.search}`; } catch { return String(u); } };

/** A short body of a failed answer: its first 4 KB read from a clone (the caller's response is left as it was), redacted, then cut to 300 characters. */
async function shortBody(res) {
  try {
    const c = res.clone();
    if (!c.body || typeof c.body.getReader !== 'function') return '';
    const reader = c.body.getReader();
    const chunks = []; let n = 0;
    while (n < 4096) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
    reader.cancel().catch(() => {});
    return redact(Buffer.concat(chunks.map((x) => Buffer.from(x))).toString('utf8').slice(0, 4096)).slice(0, 300).replace(/\s+/g, ' ').trim();
  } catch { return ''; }
}

/**
 * EVERY REQUEST AND CHILD PROCESS OF THIS PROGRAM, SAID (the one hook, rather than a check in every module): the global fetch and
 * node:child_process (execFile, spawn, execFileSync - the ES modules' imports follow through syncBuiltinESMExports) wrapped.
 *   fetch  'all' (each request: method, URL, status, time), 'failed' (only those that failed), or null
 *   exec   true: each child process's command line, its exit code and time, and its last stderr lines when it failed
 * A failed request's short body is said at debug. Answers a function that takes the wrapping off again.
 */
export function traceRuntime(log, { fetch: fetchMode = log.at('verbose') ? 'all' : null, exec = log.at('debug') } = {}) {
  const undo = [];
  const lf = log.tag('fetch'), lx = log.tag('exec');
  if (fetchMode && typeof globalThis.fetch === 'function') {
    const orig = globalThis.fetch;
    globalThis.fetch = async function tracedFetch(input, init) {
      const url = shortUrl(typeof input === 'string' ? input : input && input.url ? input.url : String(input));
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const t0 = performance.now();
      try {
        const r = await orig.call(this, input, init);
        const bad = r.status >= 400;
        if (bad || fetchMode === 'all') lf.verbose(`${method} ${url} -> ${r.status} in ${lf.since(t0)}`);
        if (bad && log.at('debug')) { const b = await shortBody(r); if (b) lf.debug(`${method} ${url} answered ${r.status}: ${b}`); }
        return r;
      } catch (e) {
        const why = e && e.cause ? `${e.cause.code || e.cause.message || e.cause}` : e && e.name === 'TimeoutError' ? 'timed out' : e && e.message;
        lf.verbose(`${method} ${url} failed after ${lf.since(t0)}: ${why}`);
        if (log.at('debug') && e && e.stack) lf.debug(`${method} ${url}, stack:\n${String(e.stack).split('\n').slice(1, 6).join('\n')}`);
        throw e;
      }
    };
    undo.push(() => { globalThis.fetch = orig; });
  }
  if (exec) {
    const cp = require('node:child_process');
    const { execFile, spawn, execFileSync } = cp;
    const cmdline = (file, args) => redactArgs([file, ...(Array.isArray(args) ? args : [])]);
    cp.execFile = function tracedExecFile(file, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const t0 = performance.now();
      const at = rest.findIndex((x) => typeof x === 'function');
      const said = cmdline(file, args);
      if (at >= 0) {
        const cb = rest[at];
        rest[at] = function (err, out, errOut) {
          const code = err ? (err.code ?? (err.killed ? `killed (${err.signal})` : '?')) : 0;
          lx.debug(`${said} -> exit ${code} in ${lx.since(t0)}${err && lastLines(errOut) ? `; stderr: ${lastLines(errOut)}` : ''}`);
          return cb.apply(this, arguments);
        };
        return execFile.call(this, file, ...rest);
      }
      const child = execFile.call(this, file, ...rest);
      child.once('close', (code, signal) => lx.debug(`${said} -> exit ${code ?? signal} in ${lx.since(t0)}`));
      return child;
    };
    cp.spawn = function tracedSpawn(file, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const t0 = performance.now();
      const said = cmdline(file, args);
      const child = spawn.call(this, file, ...rest);
      lx.debug(`started ${said}${child.pid ? ` (pid ${child.pid})` : ''}`);
      child.once('error', (e) => lx.debug(`${said} did not start: ${e.code || e.message}`));
      child.once('exit', (code, signal) => lx.debug(`${said} -> exit ${code ?? signal} after ${lx.since(t0)}`));
      return child;
    };
    cp.execFileSync = function tracedExecFileSync(file, ...rest) {
      const args = Array.isArray(rest[0]) ? rest[0] : [];
      const t0 = performance.now();
      const said = cmdline(file, args);
      try { const r = execFileSync.call(this, file, ...rest); lx.debug(`${said} -> exit 0 in ${lx.since(t0)}`); return r; }
      catch (e) { lx.debug(`${said} -> exit ${e.status ?? e.code ?? '?'} in ${lx.since(t0)}${lastLines(e.stderr) ? `; stderr: ${lastLines(e.stderr)}` : ''}`); throw e; }
    };
    syncBuiltinESMExports();
    undo.push(() => { cp.execFile = execFile; cp.spawn = spawn; cp.execFileSync = execFileSync; syncBuiltinESMExports(); });
  }
  return () => { for (const u of undo.reverse()) u(); };
}

/**
 * A LONG-RUNNING SERVICE'S LOG (the seat, the custody agent, the workers keeper, the chain bridge, the liquidity provider): its level from
 * ARENA_LOG_LEVEL, else arena.conf log_level at `home`, read once at its start; above info its first line says so, and its requests and
 * child processes are traced (failed requests and child processes at verbose, every request at debug). `write` its log line.
 */
export function serviceLog({ home = null, env = process.env, tag = 'log', write = (l) => console.log(l), trace = true } = {}) {
  const lv = levelOf({ env, conf: home ? confValuesAt(home) : null });
  const log = createLog({ level: lv.level, write });
  if (lv.bad) write(`[${tag}] ${lv.bad}`);
  if (lv.level !== 'info') {
    write(`[${tag}] log level ${lv.level} (${lv.from})`);
    if (trace) traceRuntime(log, { fetch: lv.level === 'debug' ? 'all' : 'failed', exec: lv.level === 'debug' });
  }
  return log;
}
