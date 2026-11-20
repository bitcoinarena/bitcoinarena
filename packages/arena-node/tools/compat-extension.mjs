#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2951: use the installed store package, a disposable key/profile, and the real login.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { npubEncode } from 'nostr-tools/nip19';
import * as nip44 from 'nostr-tools/nip44';
import { crxUrl, manifestFromCrx } from './compat-package.mjs';

const SITE = 'https://testnet.bitcoinarena.io/';
const RELAY = 'wss://relay.bitcoinarena.io';
const bounded = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('extension did not answer in 30 s')), 30000); })]); }
  finally { clearTimeout(timer); }
};

// Alby's own message router encrypts the account and its separate Nostr key.
// No bundle rewriting or fabricated encrypted storage is involved.
async function configureAlby(context, worker, secret, pubkey, host) {
  // Finish the first-install tab before opening the test site: Alby's welcome
  // page redirects the active tab when it observes a newly added account.
  const welcome = context.pages().find(p => p.url().includes('/welcome.html'))
    || await context.waitForEvent('page', { predicate: p => p.url().includes('/welcome.html') });
  await welcome.close();
  // Only the Nostr enable prompt for this run's site may be approved.
  const approve = async (page) => {
    try {
      await page.waitForURL((url) => url.protocol === 'chrome-extension:' && url.host === new URL(worker.url()).host && url.pathname === '/prompt.html');
      const url = new URL(page.url());
      const origin = JSON.parse(url.searchParams.get('origin') || '{}');
      if (url.searchParams.get('action') !== 'public/nostr/enable' || origin.host !== host) return;
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
    } catch { /* The main check reports an unanswered or refused request. */ }
  };
  context.on('page', approve);
  const setup = await context.newPage();
  // A static extension resource avoids the options UI's onboarding redirects.
  await setup.goto(new URL('/manifest.json', worker.url()).href);
  try {
    await bounded(setup.evaluate(async ({ secret, pubkey, host }) => {
      const call = async (action, args = {}) => {
        const result = await chrome.runtime.sendMessage({ application: 'LBE', prompt: true, action, args });
        if (!result || result.error) throw new Error(`Alby setup failed: ${action}`);
        return result.data;
      };
      const password = crypto.randomUUID() + crypto.randomUUID();
      await call('setPassword', { password });
      const account = await call('addAccount', {
        name: 'Arena disposable Nostr test', connector: 'lndhub',
        config: { url: 'http://127.0.0.1:1', login: crypto.randomUUID(), password: crypto.randomUUID() },
      });
      if (!account?.accountId) throw new Error('Alby did not create a test account');
      await call('nostr/setPrivateKey', { id: account.accountId, privateKey: secret });
      if (await call('nostr/getPublicKey', { id: account.accountId }) !== pubkey) throw new Error('Alby test key mismatch');
      const { accounts } = await chrome.storage.sync.get('accounts');
      const stored = accounts?.[account.accountId];
      if (typeof stored?.config !== 'string' || typeof stored?.nostrPrivateKey !== 'string'
        || stored.nostrPrivateKey === secret || stored.config.includes('127.0.0.1')) {
        throw new Error('Alby did not encrypt the disposable account and Nostr key');
      }
      await call('addAllowance', { host, name: 'Arena compatibility', totalBudget: 0 });
      for (const method of ['nostr/getPublicKey', 'nostr/signMessage/30078', 'nostr/signMessage/27235', 'nostr/encrypt', 'nostr/decrypt']) {
        await call('addPermission', { host, method, enabled: true, blocked: false });
      }
    }, { secret, pubkey, host }));
  } finally { await setup.close(); }
}

export async function checkExtension(product, { site = SITE, relay = RELAY, packageFile = null, executablePath = process.env.COMPAT_CHROMIUM } = {}) {
  if (!['nos2x', 'sidecar', 'alby'].includes(product.adapter)) throw new Error('no tested setup adapter for this extension');
  const dir = mkdtempSync(join(tmpdir(), 'arena-compat-extension-'));
  const key = generateSecretKey(), pubkey = getPublicKey(key), checks = {};
  let context;
  let version, stage = 'download';
  try {
    const response = packageFile ? null : await fetch(crxUrl(product.versionFrom.chrome), { signal: AbortSignal.timeout(30000) });
    if (response && !response.ok) throw new Error(`extension download answered ${response.status}`);
    const pkg = packageFile ? readFileSync(packageFile) : Buffer.from(await response.arrayBuffer());
    version = manifestFromCrx(pkg).version;
    if (pkg.readUInt32LE(4) !== 3) throw new Error('expected a CRX3 package');
    const zipFile = join(dir, 'extension.zip'), extensionDir = join(dir, 'extension');
    writeFileSync(zipFile, pkg.subarray(12 + pkg.readUInt32LE(8)));
    mkdirSync(extensionDir);
    const entries = execFileSync('unzip', ['-Z1', zipFile], { encoding: 'utf8' }).trim().split('\n');
    if (entries.some((e) => e.startsWith('/') || e.split(/[\\/]/).includes('..'))) throw new Error('unsafe extension archive path');
    execFileSync('unzip', ['-q', zipFile, '-d', extensionDir]);
    // Browser subprocesses do not inherit wallet pairings or the CI GitHub token.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COMPAT_|GITHUB_TOKEN$|GH_TOKEN$)/.test(k)));
    stage = 'launch Chromium';
    context = await chromium.launchPersistentContext(join(dir, 'profile'), {
      channel: 'chromium', headless: true, env, ...(executablePath ? { executablePath } : {}),
      args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
    });
    context.setDefaultTimeout(90000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    stage = 'configure test account';
    const host = new URL(site).host;
    if (product.adapter === 'alby') {
      await configureAlby(context, worker, Buffer.from(key).toString('hex'), pubkey, host);
    } else await bounded(worker.evaluate(async ({ secret, host, adapter, pubkey }) => {
      if (adapter === 'sidecar') {
        await self.SidecarKeystore.initialize('Arena-test-' + secret.slice(0, 20));
        await self.SidecarKeystore.importSecret(secret, 'Arena compatibility');
        await self.SidecarPermissions.setLevel(pubkey, host, 'trusted');
        return;
      }
      const allow = Object.fromEntries(['getPublicKey', 'signEvent', 'nip44.encrypt', 'nip44.decrypt'].map((type) => [type, { conditions: {}, created_at: Math.floor(Date.now() / 1000) }]));
      await chrome.storage.local.set({ private_key: secret, policies: { [host]: { true: allow } } });
    }, { secret: Buffer.from(key).toString('hex'), host, adapter: product.adapter, pubkey }));
    stage = 'open login';
    const page = await context.newPage();
    await page.goto(site, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /^Login with Nostr/ }).click();
    await page.getByRole('button', { name: /^Browser extension/ }).click();
    stage = 'read wallet seed';
    await page.waitForFunction((pk) => {
      const why = document.querySelector('#ws-nostr-pane .ws-why')?.textContent?.trim();
      if (why) throw new Error(why);
      try { return JSON.parse(localStorage.getItem('arena.nostr') || '{}').npub === pk && /^[0-9a-f]{64}$/.test(sessionStorage.getItem('arena.player.seed') || ''); } catch { return false; }
    }, npubEncode(pubkey));
    stage = 'wallet reload';
    // Login restores the seed and reloads. Wait for that new document and its injected provider.
    await page.waitForFunction(() => window.ARENA_WALLET_SCREEN?.shown === false && !!window.nostr?.nip44?.decrypt);
    checks.login = 'ok';
    stage = 'read seed from relay';
    // Read the signed event back from our relay rather than just trusting local storage.
    const pool = new SimplePool();
    let event;
    try { event = await pool.get([relay], { kinds: [30078], authors: [pubkey], '#d': ['bitcoin-arena/seed'] }, { maxWait: 15000 }); }
    finally { pool.destroy(); }
    if (!event || event.pubkey !== pubkey || !verifyEvent(event)) throw new Error('our relay did not return the signed seed event');
    const plain = nip44.decrypt(event.content, nip44.getConversationKey(key, pubkey));
    const seed = JSON.parse(plain).seed;
    const local = await page.evaluate(() => sessionStorage.getItem('arena.player.seed'));
    if (seed !== local) throw new Error('the published seed differs from the wallet that opened');
    checks.seed = 'ok';
    stage = 'decrypt seed';
    const decrypted = await bounded(page.evaluate(async ({ pk, content }) => window.nostr.nip44.decrypt(pk, content), { pk: pubkey, content: event.content }));
    if (decrypted !== plain) throw new Error('the extension could not decrypt the published seed');
    checks.decrypt = 'ok';
    stage = 'sign auth event';
    const signed = await bounded(page.evaluate(async () => window.nostr.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['u', location.origin + '/'], ['method', 'GET']], content: '' })));
    if (signed.pubkey !== pubkey || !verifyEvent(signed)) throw new Error('the extension returned an invalid auth signature');
    checks.sign = 'ok';
    return { checks, version };
  } catch (error) {
    // Avoid browser dumps, which may include page state; diagnostics stay generic and bounded.
    const why = String(error?.message ?? error).split('\n')[0].replaceAll(Buffer.from(key).toString('hex'), '[redacted]').slice(0, 160);
    return { version, checks: { ...checks, browser: `${stage}: ${why}` } };
  } finally {
    try { await context?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const product = { adapter: 'nos2x', versionFrom: { chrome: 'kpgefcfmnafjgpblomihpgmejjdanjjp' } };
  const result = await checkExtension(product);
  console.log(JSON.stringify(result));
  process.exitCode = Object.values(result.checks).every((v) => v === 'ok') ? 0 : 1;
}
