#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE KEY'S SIGNATURE OVER A RELEASE (kanban #3920, 2-of-3). Signs a file with ONE Ed25519 release key and writes its signature beside
// it as <file>.sig-<first 16 hex of the public key> (base64, one line). Each key holder runs it on his own machine with his own key;
// tools/release/combine-sigs.mjs then checks the parts and writes SHA256SUMS.sigs (+ SHA256SUMS.sig for pre-#3920 updaters).
//
//     node tools/release/sign-part.mjs <file: SHA256SUMS | latest.json> <private key pem>
//     node tools/release/sign-part.mjs --keyset <KEYSET-<seq>.json> <private key pem>     a key-set change (rotation)
//
// The pem is PKCS#8. An ENCRYPTED pem ("BEGIN ENCRYPTED PRIVATE KEY", e.g. openssl pkey -aes256, or `node sign-part.mjs --encrypt`)
// asks for its passphrase on the terminal, without echo; the passphrase is never stored or printed. An unencrypted pem must be mode
// 0600. Plain Node crypto only: works on macOS (whose openssl is LibreSSL without Ed25519) and on Linux. Prints only public values.
//
//     node tools/release/sign-part.mjs --encrypt <plain pem> <out encrypted pem>      encrypt a key with a passphrase (asked twice)
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, openSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ReadStream } from 'node:tty';
import { basename } from 'node:path';
import { PINNED_KEYSET, keysetBody, validKeyset } from '../../packages/arena-installer/src/release-verify.js';

const die = (m) => { console.error(m); process.exit(2); };

/** Ask on the terminal without echo (never from a pipe: a passphrase is typed). */
export async function askHidden(prompt) {
  let fd;
  try { fd = openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r'); } catch { die('no terminal to ask the passphrase on'); }
  const tty = new ReadStream(fd);
  tty.setRawMode(true);   // before the prompt: nothing typed after it is ever echoed
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let s = '';
    tty.on('data', (b) => {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { tty.setRawMode(false); tty.destroy(); process.stderr.write('\n'); resolve(s); return; }
        if (ch === '\u0003') { tty.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1); else s += ch;
      }
    });
  });
}

/** The private key of a pem file: asks for a passphrase only when the pem is encrypted. */
export async function loadKey(pemFile, { ask = askHidden } = {}) {
  const pem = readFileSync(pemFile, 'utf8');
  if (/BEGIN ENCRYPTED PRIVATE KEY/.test(pem)) {
    const passphrase = await ask(`passphrase for ${basename(pemFile)}: `);
    try { return createPrivateKey({ key: pem, format: 'pem', passphrase }); } catch { die('wrong passphrase (or not an encrypted PKCS#8 key)'); }
  }
  if (process.platform !== 'win32' && (statSync(pemFile).mode & 0o077)) die(`${pemFile} is not encrypted and must be mode 600`);
  try { return createPrivateKey({ key: pem, format: 'pem' }); } catch { die(`${pemFile} is not a private key pem`); }
}

export const pubHexOf = (priv) => createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

/** The bytes the signature covers: a release file's own bytes, or a key-set change's body. */
export function bytesToSign(file, { keyset = false } = {}) {
  if (!keyset) return readFileSync(file);
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const v = c && c.arenaReleaseKeyset === 1 ? validKeyset(c) : null;
  if (!v) die(`${file} is not a well-formed key-set change ({ "arenaReleaseKeyset": 1, "seq", "threshold" >= 2, "keys": distinct 64-hex })`);
  return keysetBody(v);
}

async function main(argv) {
  if (argv[0] === '--encrypt') {
    const [, inPem, outPem] = argv;
    if (!inPem || !outPem) die('usage: sign-part.mjs --encrypt <plain pem> <out encrypted pem>');
    if (existsSync(outPem)) die(`${outPem} exists: not overwritten`);
    const priv = await loadKey(inPem);
    const a = await askHidden('new passphrase: '), b = await askHidden('again: ');
    if (a !== b || a.length < 12) die(a !== b ? 'the two passphrases differ' : 'use at least 12 characters');
    writeFileSync(outPem, priv.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: a }), { mode: 0o600 });
    console.log(`${outPem}: encrypted, public key ${pubHexOf(priv)}`);
    return;
  }
  const keyset = argv[0] === '--keyset';
  const [file, pemFile] = keyset ? argv.slice(1) : argv;
  if (!file || !pemFile) die('usage: sign-part.mjs [--keyset] <file> <private key pem>');
  const bytes = bytesToSign(file, { keyset });
  const priv = await loadKey(pemFile);
  const pub = pubHexOf(priv);
  const sig = sign(null, bytes, priv).toString('base64');
  if (!verify(null, bytes, createPublicKey(priv), Buffer.from(sig, 'base64'))) die('the signature does not verify');
  const out = `${file}.sig-${pub.slice(0, 16)}`;
  writeFileSync(out, sig + '\n');
  const pinned = PINNED_KEYSET.keys.indexOf(pub);
  console.log(`${out}: signed by ${pub}${pinned >= 0 ? ` (key ${pinned + 1} of the pinned set)` : ' - NOT a key of the pinned set: combine-sigs ignores it'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main(process.argv.slice(2));
