// HOW A SIGNER NODE IS REACHED (the owner 2026-09-26 13:44): one parameter, three values - direct, trycloudflare,
// tailscale - and every public address, the copied replay link's included, is the one that mode produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachFor, REACH_MODES } from '../src/reach.js';

// Tailscale's own answers, as `tailscale status --json` and `tailscale funnel status --json` give them
const TS = () => ({
  status: { Self: { DNSName: 'host.example.ts.net.' } },
  funnel: {
    AllowFunnel: { 'host.example.ts.net:443': true },
    Web: {
      'host.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://localhost:3001' },
        '/node-a': { Proxy: 'http://100.64.0.9:18080' }, '/node-b': { Proxy: 'http://100.64.0.9:18081' } } },
      'host.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18082' } } },   // tailnet only
    },
  },
});

test('three modes and nothing else', () => {
  assert.deepEqual([...REACH_MODES], ['direct', 'trycloudflare', 'tailscale']);
  assert.throws(() => reachFor({ mode: 'funnel', host: 'h', port: 1 }), /one of direct, trycloudflare, tailscale/);
  assert.throws(() => reachFor({ host: 'h', port: 1 }), /unset/);
});

test('direct: the node on its own address, no tunnel', () => {
  assert.deepEqual(reachFor({ mode: 'direct', host: '203.0.113.7', port: 18080 }),
    { ws: 'ws://203.0.113.7:18080', https: 'http://203.0.113.7:18080' });
});

test('trycloudflare: the quick tunnel the keeper named, and only a quick tunnel', () => {
  const env = { BLWP_WSS_18080: 'wss://some-words-here-now.trycloudflare.com' };
  assert.deepEqual(reachFor({ mode: 'trycloudflare', host: 'h', port: 18080, env }),
    { ws: 'wss://some-words-here-now.trycloudflare.com', https: 'https://some-words-here-now.trycloudflare.com' });
  assert.throws(() => reachFor({ mode: 'trycloudflare', host: 'h', port: 18081, env }), /names no quick tunnel/);
  assert.throws(() => reachFor({ mode: 'trycloudflare', host: 'h', port: 1, env: { BLWP_WSS_1: 'wss://host.example.ts.net/a' } }),
    /names no quick tunnel/);
});

test('tailscale: the Funnel path that proxies to this port, on this machine\'s own name, public only', () => {
  assert.deepEqual(reachFor({ mode: 'tailscale', host: 'h', port: 18080, tailscale: TS }),
    { ws: 'wss://host.example.ts.net/node-a', https: 'https://host.example.ts.net/node-a' });
  assert.deepEqual(reachFor({ mode: 'tailscale', host: 'h', port: 18081, tailscale: TS }).https, 'https://host.example.ts.net/node-b');
  // 18082 is served only on the tailnet (8443 is not in AllowFunnel): no public address, refused by name
  assert.throws(() => reachFor({ mode: 'tailscale', host: 'h', port: 18082, tailscale: TS }), /no Funnel path/);
});
