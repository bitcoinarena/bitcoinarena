// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE THE INSTALLER RUNS (2026-10-19: "When executed on Linux with no display (the installer), it shouldn't show a
// gui but do the initial setup text based and show a browser url, already tunnels if nescesary. Same on macOS", "ie when executed remotely").
// A remote session - an ssh login, or a Linux machine without a display - has no screen of its own to open the setup page on, and the
// page's 127.0.0.1 link opens nowhere else: the installer then opens the temporary Cloudflare link by itself and only prints it.
// `--local` keeps the 127.0.0.1 link (an ssh port forward, say); `--tunnel` asks for the tunnel anywhere.

/** { remote, why }: remote when this is an ssh session, or Linux with no display. */
export function remoteSession({ env = process.env, platform = process.platform } = {}) {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return { remote: true, why: 'this is a remote (ssh) session' };
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { remote: true, why: 'this machine has no display' };
  return { remote: false, why: null };
}

/** How the setup page is reached: { tunnel, why } - the flags first, then the session. */
export function setupLinkMode(args, opts = {}) {
  if (args.includes('--local')) return { tunnel: false, why: '--local' };
  if (args.includes('--tunnel')) return { tunnel: true, why: '--tunnel' };
  const s = remoteSession(opts);
  return { tunnel: s.remote, why: s.why };
}
