// TOR FOR THE NODE'S LIGHTNING (kanban #471, the owner 2026-10-18: "find a way to connect to it via a tunnel" / "connect via tor to the
// other nodes as well"): Lightning peers speak their own protocol over TCP, which no web tunnel carries, and most nodes take no
// connection (no open port, a dynamic address). So the node runs Tor and its LND runs hybrid: a permanent onion address others dial,
// clearnet peers still dialled directly. The federation's channel ring and the gateway's outside channel reach every node this way.
// The release carries the Tor Project's expert bundle (runtime/tor/); a linux-arm64 machine uses the system's tor (none is built).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TOR_PORTS = Object.freeze({ socks: 19050, control: 19051 });

/** The tor to run: the release's own, else one in PATH (`which`), else null. */
export async function torBin({ release, platform = process.platform, which = null }) {
  const own = join(release, 'runtime', 'tor', platform === 'win32' ? 'tor.exe' : 'tor');
  if (existsSync(own)) return own;
  if (which) { const w = await which('tor'); if (w) return w; }
  return null;
}

/** The node's torrc in <home>/tor: SOCKS for LND's dialling, the control port LND makes its onion service with. Answers its path. */
export function writeTorrc({ home, ports = TOR_PORTS }) {
  const dir = join(home, 'tor');
  mkdirSync(join(dir, 'data'), { recursive: true, mode: 0o700 });
  const file = join(dir, 'torrc');
  writeFileSync(file, ['# The Arena node\'s Tor (kanban #471), written by the installer: LND dials and is dialled through it.',
    `SocksPort 127.0.0.1:${ports.socks}`, `ControlPort 127.0.0.1:${ports.control}`, 'CookieAuthentication 1',
    `DataDirectory ${join(dir, 'data')}`, ''].join('\n'), { mode: 0o600 });
  return file;
}

/** LND's [Tor] section for a running Tor: hybrid - an onion address (v3) for others, clearnet peers dialled directly. */
export const lndTorLines = (ports = TOR_PORTS) => ['[Tor]', 'tor.active=true', 'tor.v3=true', `tor.socks=127.0.0.1:${ports.socks}`,
  `tor.control=127.0.0.1:${ports.control}`, 'tor.streamisolation=false', 'tor.skip-proxy-for-clearnet-targets=true'];
