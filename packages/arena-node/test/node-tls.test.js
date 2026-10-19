// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WSS FROM THE NODE ITSELF (spec §25.3): serve({ tls }) answers its doors over https and takes the players'
// socket (/play) as wss on the same port; a renewed certificate is taken by setSecureContext without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';

const selfSigned = (dir, name) => {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', `/CN=${name}`,
    '-addext', `subjectAltName=DNS:${name}`, '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`)], { stdio: 'ignore' });
  return { cert: readFileSync(join(dir, `${name}.pem`)), key: readFileSync(join(dir, `${name}.key`)) };
};
const get = (port, ca, servername) => new Promise((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, path: '/identity', ca, servername, method: 'GET', agent: false }, (res) => {
    const cert = res.socket.getPeerCertificate().subject.CN; const parts = [];
    res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, bytes: Buffer.concat(parts).length, cert }));
  });
  r.on('error', reject); r.end();
});

test('a node given a certificate answers https and upgrades /play to wss; a new certificate is taken without a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-tls-'));
  const a = selfSigned(dir, 'seat-a.example'), b = selfSigned(dir, 'seat-b.example');
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, tls: a });
  try {
    const port = s.http.address().port;
    const one = await get(port, a.cert, 'seat-a.example');
    assert.equal(one.status, 200);
    assert.equal(one.cert, 'seat-a.example');
    assert.ok(one.bytes > 0, 'the identity door answers over https');
    // THE PLAYERS' SOCKET OVER TLS: the upgrade answered 101 on the same port
    const upgraded = await new Promise((resolve, reject) => {
      const t = connect({ host: '127.0.0.1', port, ca: a.cert, servername: 'seat-a.example' }, () => {
        t.write('GET /play HTTP/1.1\r\nHost: seat-a.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      let got = ''; t.on('data', (d) => { got += d; if (got.includes('\r\n\r\n')) { t.destroy(); resolve(got.split('\r\n')[0]); } }); t.on('error', reject);
    });
    assert.equal(upgraded, 'HTTP/1.1 101 Switching Protocols');
    // A RENEWAL: the next connection is served the new certificate
    s.http.setSecureContext(b);
    assert.equal((await get(port, b.cert, 'seat-b.example')).cert, 'seat-b.example');
  } finally { await s.close(); }
});
