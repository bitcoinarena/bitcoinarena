#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE NIGHTLY COMPATIBILITY RUN (kanban #2950, follow-up of #2917): keeps bitcoinarena.io/compatibility/ current by machine.
 *
 *   node tools/compat-run.mjs [--out=<dir>] [--pay] [--only=<name>]
 *
 * For every product of src/website/www/compatibility/planned.json:
 *   - its newest version is read where it is published (Chrome Web Store package, GitHub's latest release, the App Store);
 *   - check "signer" / "nwc": compat-check.mjs runs against the product's pairing, the secret named by `secret` (a bunker:// or
 *     nostr+walletconnect:// link; COMPAT_SECRETS holds them all as JSON, or each is its own environment variable). With --pay a
 *     wallet also pays 1 sat to our wallet (COMPAT_PAY_WALLET, an NWC link) and our wallet pays the same back to the wallet's own invoice;
 *   - check "extension": the browser extension logs in to the real page (#2951; skipped until a runner is given);
 *   - check "manual": nothing runs; a newer version than the one tested by hand is a re-test reminder.
 * A product that works gets its row in results.json (how: automatic) when it has none, the version changed, the row was manual or
 * failing, or the row is older than REFRESH_DAYS. A product that fails gets its failing row (result "problems") at once, so the page
 * never says "works" for a product whose check fails (owner 11-18, kanban #2971: the page follows the checks by itself); the failure
 * is also reported (report.json, report.md in --out) for triage (a bug on our side: our ticket; in the product: the team is told
 * before anything goes on its GitHub). .github/workflows/compatibility.yml commits results.json to main and opens the issues.
 * No secret is ever printed or written.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { manifestFromCrx, crxUrl } from './compat-package.mjs';
export { manifestFromCrx, crxUrl } from './compat-package.mjs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultRow, withRow, checkNwc, checkSigner, parseNwc, nwcAsk } from './compat-check.mjs';

const SITE = fileURLToPath(new URL('../../../src/website/www/compatibility/', import.meta.url));
export const REFRESH_DAYS = 30;
const TIMEOUT = 20000;

/** The newest published version of a product, or its fixed label ("hosted"), or null when it is not published anywhere we read. */
export async function latestVersion(p, { fetcher = fetch, githubToken = null } = {}) {
  const from = p.versionFrom || {};
  const get = async (url, headers = {}) => {
    const r = await fetcher(url, { headers: { 'user-agent': 'bitcoin-arena-compat-run', ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
    return r;
  };
  if (from.chrome) return String(manifestFromCrx(await (await get(crxUrl(from.chrome))).arrayBuffer()).version);
  if (from.github) {
    const h = { accept: 'application/vnd.github+json', ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}) };
    return String((await (await get(`https://api.github.com/repos/${from.github}/releases/latest`, h)).json()).tag_name).replace(/^v/, '');
  }
  if (from.appstore) {
    const r = (await (await get(`https://itunes.apple.com/lookup?id=${encodeURIComponent(from.appstore)}`)).json()).results || [];
    if (!r[0] || !r[0].version) throw new Error('the App Store does not list it');
    return String(r[0].version);
  }
  return p.version || null;
}

/** What to do with one product tonight: run it, remind a person, or skip it (and why). */
export function plan(p, row, latest, { secrets, extension, amber }) {
  if (p.check === 'android') {
    if (amber) return { act: 'run' };
    if (row && latest && latest !== row.version) return { act: 'remind', why: `version ${latest} is out; local Amber emulator is not configured here` };
    return { act: 'skip', why: 'no dedicated Amber emulator selected (COMPAT_AMBER_SERIAL)' };
  }
  if (p.check === 'manual') {
    if (row && latest && latest !== row.version) return { act: 'remind', why: `version ${latest} is out; ${row.version} was tested by hand on ${row.date}` };
    return { act: 'skip', why: row ? (latest ? `tested by hand, ${row.version} is still the newest` : 'tested by hand; newest version could not be determined') : 'tested by hand only, not tested yet' };
  }
  if (p.check === 'extension' && !p.adapter) {
    if (row && latest && latest !== row.version) return { act: 'remind', why: `version ${latest} is out; browser setup is manual for this product` };
    return { act: 'skip', why: p.manualReason || 'browser setup is manual for this product' };
  }
  if (p.check === 'extension') return extension ? { act: 'run' } : { act: 'skip', why: 'no extension runner here (kanban #2951)' };
  if (p.check === 'signer' || p.check === 'nwc') return secrets[p.secret] ? { act: 'run' } : { act: 'skip', why: `no pairing: the secret ${p.secret} is not set` };
  return { act: 'skip', why: `unknown check "${p.check}"` };
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Whether a working row replaces the old one (so the page does not get a new PR every night for the same result). */
export function worthWriting(old, row, today) {
  return !old || old.result !== 'works' || old.how !== 'automatic' || old.version !== row.version
    || JSON.stringify(Object.keys(old.checks || {}).sort()) !== JSON.stringify(Object.keys(row.checks || {}).sort())
    || daysBetween(old.date, today) >= REFRESH_DAYS;
}

/** Whether a failing row replaces the old one: always over a working row; otherwise only when the version or what fails changed. */
export function failureWorthWriting(old, row) {
  return !old || old.result === 'works' || old.how !== 'automatic' || old.version !== row.version
    || JSON.stringify(old.checks || {}) !== JSON.stringify(row.checks || {});
}

/** 1 sat from the wallet to us and back: our wallet makes the invoice the product pays, then pays the product's own invoice. */
async function payRound(ourLink, { pool }) {
  const ours = parseNwc(ourLink);
  const made = await nwcAsk(ours, pool, 'make_invoice', { amount: 1000, description: 'Bitcoin Arena compatibility check (paid back)' }, TIMEOUT);
  return { invoice: String(made.invoice), payBack: (invoice) => nwcAsk(ours, pool, 'pay_invoice', { invoice }, TIMEOUT) };
}

/**
 * One night. `checkers` are injected for the tests: { signer(link), nwc(link, opts), extension(product) }, each answering { checks, version? }.
 * Returns the new results list and the report; writes nothing.
 */
export async function run({ products, results, secrets = {}, today = new Date().toISOString().slice(0, 10), pay = false, only = null,
  checkers = {}, versionOf = latestVersion, payWallet = null, releasesOnly = false }) {
  const report = { date: today, works: [], failed: [], reminders: [], skipped: [] };
  let list = results.slice();
  for (const p of products) {
    if (only && p.name !== only) continue;
    const old = list.find((r) => r.name === p.name && r.kind === p.kind) || null;
    let latest = null, versionWhy = null;
    try { latest = await versionOf(p); } catch (e) { versionWhy = String(e?.message ?? e).slice(0, 160); }
    if (releasesOnly) {
      let why;
      const same = (a, b) => String(a).replace(/^v/, '') === String(b).replace(/^v/, '');
      if (!Object.keys(p.versionFrom || {}).length) why = 'unversioned product: manual checks only';
      else if (!latest) why = 'release version unavailable; no release-triggered check';
      else if (old && same(old.version, latest)) why = `release ${latest} already checked`;
      else if (['signer', 'nwc'].includes(p.check) && secrets[p.secret] && !same(secrets[`${p.secret}_VERSION`] || '', latest)) why = `upgrade the paired installation and its version to release ${latest} before checking`;
      if (why) { report.skipped.push({ name: p.name, kind: p.kind, why, ...(versionWhy ? { versionWhy } : {}) }); continue; }
    }
    const step = plan(p, old, latest, { secrets, extension: !!checkers.extension, amber: !!checkers.amber });
    const base = { name: p.name, kind: p.kind, ...(versionWhy ? { versionWhy } : {}) };
    if (step.act === 'skip') { report.skipped.push({ ...base, why: step.why }); continue; }
    if (step.act === 'remind') { report.reminders.push({ ...base, why: step.why, latest, tested: old.version }); continue; }
    let out;
    const clean = (value) => {
      let text = String(value?.message ?? value);
      for (const secret of Object.values(secrets)) if (secret) text = text.split(secret).join('[redacted]');
      return text.replace(/(?:bunker|nostr\+walletconnect):\/\/[^\s]+/g, '[redacted pairing]').slice(0, 160);
    };
    try {
      if (p.check === 'android') out = await checkers.amber(p);
      else if (p.check === 'signer') out = { checks: await checkers.signer(secrets[p.secret]) };
      else if (p.check === 'nwc') {
        const kept = {};
        let round = null;
        if (pay && !payWallet) throw new Error('payment requested but COMPAT_PAY_WALLET is not configured');
        if (pay) round = await payWallet();
        out = { checks: await checkers.nwc(secrets[p.secret], { pay: round ? round.invoice : null, kept, requireReturnInvoice: !!round }) };
        if (round && out.checks.pay_invoice === 'ok' && kept.invoice) {
          try { await round.payBack(kept.invoice); out.paidBack = true; } catch (e) { out.paidBack = false; out.payBackWhy = clean(e); }
        }
      } else out = await checkers.extension(p);
    } catch (e) { out = { checks: { run: clean(e) } }; }
    out.checks = Object.fromEntries(Object.entries(out.checks || {}).map(([k, v]) => [k, v === 'ok' ? v : clean(v)]));
    if (out.paidBack === false) out.checks.pay_back = out.payBackWhy;
    // A remote pairing does not prove that the latest available release is installed.
    const version = out.version || secrets[`${p.secret}_VERSION`] || p.version || (p.check === 'extension' ? latest : null) || 'unknown';
    const row = resultRow({ name: p.name, version, kind: p.kind, checks: out.checks, date: today, url: p.url || null, platform: p.platform || null, how: 'automatic' });
    if (row.result === 'works') {
      const write = worthWriting(old, row, today);
      if (write) list = withRow(list, row);
      report.works.push({ ...base, version, written: write, ...(out.paidBack === false ? { payBackWhy: out.payBackWhy } : {}) });
    } else {
      const failing = Object.fromEntries(Object.entries(row.checks).filter(([, v]) => v !== 'ok'));
      const write = failureWorthWriting(old, row);
      if (write) list = withRow(list, row);
      report.failed.push({ ...base, version, failing, written: write, hadRow: !!old });
    }
  }
  return { results: list, report };
}

/** The report as Markdown, for the run's summary, the PR and the issues. */
export function reportMarkdown(r) {
  const lines = [`## Compatibility run ${r.date}`, ''];
  const table = (title, rows, cols) => {
    if (!rows.length) return;
    lines.push(`### ${title}`, '', `| ${cols.map((c) => c[0]).join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
    for (const x of rows) lines.push(`| ${cols.map((c) => String(c[1](x)).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`);
    lines.push('');
  };
  table('Fails', r.failed, [['Product', (x) => x.name], ['Kind', (x) => x.kind], ['Version', (x) => x.version], ['Failing', (x) => Object.entries(x.failing).map(([k, v]) => `${k}: ${v}`).join('; ')]]);
  table('Re-test by hand', r.reminders, [['Product', (x) => x.name], ['Kind', (x) => x.kind], ['Why', (x) => x.why]]);
  table('Works', r.works, [['Product', (x) => x.name], ['Kind', (x) => x.kind], ['Version', (x) => x.version], ['Row', (x) => (x.written ? 'updated' : 'unchanged')]]);
  table('Skipped', r.skipped, [['Product', (x) => x.name], ['Why', (x) => x.why + (x.versionWhy ? ` (version: ${x.versionWhy})` : '')]]);
  for (const x of [...r.works, ...r.failed, ...r.reminders]) if (x.versionWhy) lines.push(`Version lookup for ${x.name}: ${x.versionWhy}`, '');
  return lines.join('\n');
}

/** The secrets: COMPAT_SECRETS JSON plus the environment's own COMPAT_* variables. */
export function secretsFrom(env) {
  let all = {};
  try { all = JSON.parse(env.COMPAT_SECRETS || '{}') || {}; } catch { all = {}; }
  for (const [k, v] of Object.entries(env)) if (/^COMPAT_[A-Z0-9_]+$/.test(k) && k !== 'COMPAT_SECRETS' && v) all[k] = v;
  return Object.fromEntries(Object.entries(all).filter(([k, v]) => /^COMPAT_/.test(k) && typeof v === 'string' && v));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || null;
  const out = arg('out') || '.', resultsFile = join(SITE, 'results.json');
  const products = JSON.parse(readFileSync(join(SITE, 'planned.json'), 'utf8'));
  const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : [];
  const secrets = secretsFrom(process.env);
  let extension = null;
  const extensionModule = new URL('./compat-extension.mjs', import.meta.url);
  if (!process.argv.includes('--no-extensions') && existsSync(extensionModule)) {
    extension = (await import(extensionModule.href)).checkExtension;
  }
  const amber = process.env.COMPAT_AMBER_SERIAL ? (await import('./compat-amber.mjs')).checkAmber : null;
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  const got = await run({
    products, results, secrets, pay: process.argv.includes('--pay'), only: arg('only'), releasesOnly: process.argv.includes('--releases-only'),
    checkers: { ...(amber ? { amber: () => amber() } : {}), signer: (l) => checkSigner(l), nwc: (l, o) => checkNwc(l, o), ...(extension ? { extension } : {}) },
    versionOf: (p) => latestVersion(p, { githubToken: process.env.GITHUB_TOKEN || null }),
    payWallet: secrets.COMPAT_PAY_WALLET ? () => payRound(secrets.COMPAT_PAY_WALLET, { pool }) : null,
  });
  pool.destroy?.();
  mkdirSync(out, { recursive: true });
  const changed = JSON.stringify(got.results) !== JSON.stringify(results);
  if (changed) writeFileSync(resultsFile, `${JSON.stringify(got.results, null, 1)}\n`);
  writeFileSync(join(out, 'report.json'), `${JSON.stringify({ ...got.report, resultsChanged: changed }, null, 1)}\n`);
  writeFileSync(join(out, 'report.md'), `${reportMarkdown(got.report)}\n`);
  console.log(reportMarkdown(got.report));
  process.exit(0);
}
