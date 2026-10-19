// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH SOCKET A FAILED FETCH RODE, AND WHETHER THE SERVER HAD ALREADY CLOSED IT (M3.3-27).
//
// The rehearsal's flake is `fetch failed: ECONNRESET` on the first provider of
// `Client.at`, after 6.5 s and 9.6 s idle, with the event loop not held. What
// the error cannot say is whether the request went out on a kept-alive socket
// or a new one, and what the daemon's side of that socket was doing. Node's
// fetch is undici, which publishes its sockets and requests on diagnostics
// channels; the daemons here run in this process, so their servers' sockets are
// visible too. Both halves are joined on the client's local port. Tools only.
import diagnostics_channel from 'node:diagnostics_channel';

export function watchSockets({ now = Date.now } = {}) {
  const sockets = new WeakMap();
  const byRequest = new WeakMap();
  const errors = [];
  let seq = 0;

  diagnostics_channel.subscribe('undici:client:connected', ({ socket }) => {
    sockets.set(socket, { id: ++seq, opened: now(), uses: 0, lastDone: null, localPort: socket.localPort });
  });
  diagnostics_channel.subscribe('undici:client:sendHeaders', ({ request, socket }) => {
    const s = sockets.get(socket);
    if (!s) return;
    byRequest.set(request, { s, sentAt: now(), reused: s.uses > 0,
      idleMs: s.lastDone === null ? null : now() - s.lastDone });
    s.uses++;
  });
  diagnostics_channel.subscribe('undici:request:trailers', ({ request }) => {
    const r = byRequest.get(request);
    if (r) r.s.lastDone = now();
  });
  diagnostics_channel.subscribe('undici:request:error', ({ request, error }) => {
    const r = byRequest.get(request);
    errors.push({
      at: now(), url: `${request.origin}${request.path}`, error: `${error.code || ''} ${error.message}`.trim(),
      socket: r ? { id: r.s.id, localPort: r.s.localPort, reused: r.reused, idleMs: r.idleMs,
        ageMs: r.sentAt - r.s.opened, usesBefore: r.s.uses - 1 } : null,
    });
  });

  const served = new Map();
  const watchServer = (name, server) => server.on('connection', (sock) => {
    const rec = { server: name, opened: now(), closed: null };
    served.set(sock.remotePort, rec);
    sock.on('close', () => { rec.closed = now(); });
  });

  /** Every failed request since `since`, with the server's side of its socket. */
  const report = (since) => errors.filter((e) => e.at >= since).map((e) => {
    const srv = e.socket ? served.get(e.socket.localPort) : null;
    return { ...e, server: srv
      ? { name: srv.server, socketOpenedMsBefore: e.at - srv.opened,
        closedMsBeforeTheError: srv.closed === null ? 'still open' : e.at - srv.closed }
      : (e.socket ? 'no server socket seen for that port' : 'no socket: it failed before sending') };
  });
  return { watchServer, report };
}
