// honest path (not a failure test): a 1 MiB body under the default 8 MiB limit is read; one byte past a small limit answers 413 or ends
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
const { openStore } = await import('../src/store.js');
const { serve } = await import('../src/server.js');
const post = (port, path, bytes) => new Promise((res) => {
  const r = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, (x) => {
    let t = ''; x.on('data', (c) => { t += c; }); x.on('end', () => res(`${x.statusCode} ${t.slice(0, 80)}`)); });
  r.on('error', (e) => res(`closed (${e.code || e.message})`)); r.end(bytes);
});
test('honest: 1 MiB JSON read at default limit; exactly 8 MiB read; 8 MiB+1 refused', async () => {
  const b = await serve(openStore(':memory:'), { plugins: [], port: 0 });
  try {
    const mk = (n) => { const s = Buffer.alloc(n, 0x20); s[0] = 0x7b; s[n - 1] = 0x7d; return s; };
    const one = await post(b.port, '/node-facts', mk(1024 * 1024));
    const exact = await post(b.port, '/node-facts', mk(8 * 1024 * 1024));
    const over = await post(b.port, '/node-facts', mk(8 * 1024 * 1024 + 1));
    const ann = await post(b.port, '/announce', Buffer.from('{"line":"x"}'));
    console.log('  FACTS (honest):', JSON.stringify({ one, exact, over, ann }));
    assert.doesNotMatch(one, /^413|^closed/); assert.doesNotMatch(exact, /^413|^closed/); assert.match(over, /^(413 |closed )/);
  } finally { await b.close(); }
});
