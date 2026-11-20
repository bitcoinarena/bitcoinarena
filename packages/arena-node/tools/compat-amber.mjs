#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Real Amber on a dedicated, disposable Android emulator (#2952). No SDK provisioning here.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { verifyEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { checkSigner } from './compat-check.mjs';

/** Loopback-only NIP-46 transport. No keys, signatures or RPC responses are synthesized here. */
export async function amberRelay() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 256 * 1024 });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const subscriptions = new Map();
  server.on('connection', (socket) => {
    subscriptions.set(socket, new Map());
    socket.on('error', () => {});
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!Array.isArray(message)) return;
      const [type, value] = message;
      if (type === 'REQ' && typeof value === 'string') {
        const filters = message.slice(2);
        if (!filters.length || filters.length > 8 || filters.some((f) => !f || typeof f !== 'object'
          || Object.entries(f).some(([key, v]) => (['ids', 'authors', 'kinds'].includes(key) || key.startsWith('#')) && !Array.isArray(v)))) return;
        subscriptions.get(socket)?.set(value, filters);
        socket.send(JSON.stringify(['EOSE', value]));
      } else if (type === 'CLOSE') subscriptions.get(socket)?.delete(value);
      else if (type === 'EVENT') {
        let valid = false;
        try { valid = value.kind === 24133 && verifyEvent(value); } catch {}
        socket.send(JSON.stringify(['OK', value?.id || '', valid, valid ? '' : 'invalid: only signed NIP-46 events accepted']));
        if (!valid) return;
        for (const [peer, subs] of subscriptions) for (const [id, filters] of subs) {
          if (filters.some((f) => (!f.ids || f.ids.includes(value.id))
            && (!f.since || value.created_at >= f.since) && (!f.until || value.created_at <= f.until)
            && (!f.kinds || f.kinds.includes(value.kind))
            && (!f.authors || f.authors.includes(value.pubkey))
            && (!f['#p'] || value.tags.some((t) => t[0] === 'p' && f['#p'].includes(t[1]))))) {
            if (peer.readyState === 1) peer.send(JSON.stringify(['EVENT', id, value]));
          }
        }
      }
    });
  });
  return { url: `ws://127.0.0.1:${server.address().port}`, port: server.address().port,
    close: () => new Promise((resolve) => { for (const socket of server.clients) socket.terminate(); server.close(resolve); }) };
}

const execute = promisify(execFile);
const PACKAGE = 'com.greenart7c3.nostrsigner';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decodeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function amberUi(xml) {
  return [...xml.matchAll(/<node\s+([^>]+)>/g)].map(([, attributes]) => Object.fromEntries(
    [...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeXml(value)])));
}

/** Requires an explicitly selected AVD named arena-compat-amber; its app data is erased. */
export async function checkAmber({ serial = process.env.COMPAT_AMBER_SERIAL, adb = process.env.COMPAT_ADB || 'adb',
  apk = process.env.COMPAT_AMBER_APK } = {}) {
  if (!/^emulator-\d+$/.test(serial || '')) throw new Error('select a dedicated emulator using COMPAT_AMBER_SERIAL');
  // Avoid passing wallet connections and host credentials to Android subprocesses.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COMPAT_|GH_TOKEN$|GITHUB_TOKEN$|KANBAN_)/.test(key)));
  const command = async (...args) => {
    try { return (await execute(adb, ['-s', serial, ...args], { timeout: 30000, maxBuffer: 1024 * 1024, env })).stdout.trim(); }
    catch { throw new Error('Android command failed or timed out'); } // execFile errors include arguments (possibly a test key).
  };
  const avd = await command('emu', 'avd', 'name');
  if (avd.split(/\r?\n/)[0] !== 'arena-compat-amber') throw new Error('refusing to erase app data outside AVD arena-compat-amber');
  let stage = 'install', version, relay, outcome;
  const shell = (...args) => command('shell', ...args);
  const snapshot = async () => {
    await shell('rm', '-f', '/sdcard/arena-compat-ui.xml');
    await shell('uiautomator', 'dump', '/sdcard/arena-compat-ui.xml');
    const xml = await command('exec-out', 'cat', '/sdcard/arena-compat-ui.xml');
    return xml.startsWith('<?xml') ? amberUi(xml) : [];
  };
  const tapNode = async (node) => {
    const b = node?.bounds?.match(/\d+/g)?.map(Number);
    if (!b || b.length !== 4) throw new Error('missing UI element');
    await shell('input', 'tap', String(Math.round((b[0] + b[2]) / 2)), String(Math.round((b[1] + b[3]) / 2)));
  };
  const find = async (label, attempts = 25) => {
    for (let i = 0; i < attempts; i++) {
      const node = (await snapshot()).find((n) => n.text === label || n['content-desc'] === label);
      if (node) return node;
      await pause(500);
    }
    throw new Error(`missing UI label: ${label}`);
  };
  const tap = async (label) => { await tapNode(await find(label)); await pause(400); };
  try {
    if (apk && !(await command('install', '-r', apk)).includes('Success')) throw new Error('APK install failed');
    version = (await shell('dumpsys', 'package', PACKAGE)).match(/versionName=([^\s]+)/)?.[1];
    if (!version) throw new Error('online Amber is not installed');
    stage = 'onboard';
    if (!(await shell('pm', 'clear', PACKAGE)).includes('Success')) throw new Error('could not clear test app');
    await shell('pm', 'grant', PACKAGE, 'android.permission.POST_NOTIFICATIONS');
    await shell('am', 'start', '-n', `${PACKAGE}/.MainActivity`);
    await tap('Use your private key');
    const keyField = (await snapshot()).find((n) => n.class === 'android.widget.EditText');
    await tapNode(keyField);
    const testKey = generateSecretKey();
    await shell('input', 'text', Buffer.from(testKey).toString('hex'));
    await shell('input', 'keyevent', '4');
    await tap('Next');
    await tap('Finish');
    stage = 'create connection';
    await tap('Connect app');
    await tap('Add a nsecbunker');
    // Remove shipped defaults: the test connection uses only our loopback relay.
    for (let i = 0; i < 12; i++) {
      const remove = (await snapshot()).find((n) => n['content-desc'] === 'Delete');
      if (!remove) break;
      await tapNode(remove);
    }
    const fill = async (index, value) => {
      await tapNode((await snapshot()).filter((n) => n.class === 'android.widget.EditText')[index]);
      await shell('input', 'text', value);
      await shell('input', 'keyevent', '4'); // KEYCODE_ESCAPE leaves the soft keyboard covering the next screen.
    };
    await fill(0, 'Arena-compat');
    relay = await amberRelay();
    const androidRelay = `ws://10.0.2.2:${relay.port}/`;
    await fill(1, androidRelay);
    const field = (await snapshot()).filter((n) => n.class === 'android.widget.EditText')[1];
    const [x1, y1, x2, y2] = field.bounds.match(/\d+/g).map(Number);
    // Amber 6.6.9's add-relay icon has no accessibility label. Anchor to its actual field bounds.
    await shell('input', 'tap', String(Math.round(x2 - (x2 - x1) / 16)), String(Math.round((y1 + y2) / 2)));
    await find(androidRelay);
    await tap('Create');
    let bunker;
    for (let i = 0; i < 5 && !bunker; i++) {
      bunker = (await snapshot()).find((n) => n.text?.startsWith('bunker://'))?.text;
      if (!bunker) await pause(500);
    }
    if (!bunker) throw new Error('created connection URI missing');
    const parsed = new URL(bunker);
    if (parsed.searchParams.getAll('relay').length !== 1 || parsed.searchParams.get('relay') !== androidRelay) throw new Error('connection includes an unexpected relay');
    parsed.searchParams.delete('relay');
    parsed.searchParams.append('relay', relay.url);
    stage = 'approve connection';
    const checking = checkSigner(parsed.href, { ms: 90000, expectedPubkey: getPublicKey(testKey) }).catch(() => ({ connect: 'signer check failed' }));
    try {
      await tap('I fully trust this application');
      await tap('Connect');
    } catch (error) {
      // Drain the bounded verifier before deleting the app state it uses.
      await checking;
      throw error;
    }
    stage = 'verify NIP-46';
    return outcome = { version, checks: await checking };
  } catch (error) {
    return outcome = { version, checks: { emulator: `${stage}: ${error.message}` } };
  } finally {
    await relay?.close();
    await shell('am', 'force-stop', PACKAGE).catch(() => {});
    const erased = await shell('pm', 'clear', PACKAGE).catch(() => null);
    if (erased !== 'Success' && outcome) outcome.checks.cleanup = 'could not erase test app data';
    await shell('rm', '-f', '/sdcard/arena-compat-ui.xml').catch(() => {});
  }
}
