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

export async function checkExtension(product, { site = SITE, relay = RELAY, packageFile = null, executablePath = process.env.COMPAT_CHROMIUM } = {}) {
  if (!['nos2x', 'sidecar'].includes(product.adapter)) throw new Error('no tested setup adapter for this extension');
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
    await bounded(worker.evaluate(async ({ secret, host, adapter, pubkey }) => {
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
