// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// DOES A ROUTER HERE FORWARD PORTS ON REQUEST? (kanban #730, measured 2026-10-29 in the Linux VM: lnd.conf with nat=true behind a network
// with no UPnP and no NAT-PMP - LND quit ~20 s after every start, "unable to discover a NAT-PMP enabled device on the local network: Timed
// out trying to contact gateway", and systemd restarted it into the same exit). LND's `nat` asks the router by UPnP, then by NAT-PMP, and
// stops when neither answers, so the installer asks both first, the way LND does, and writes nat=true only when one of them answered:
//   UPnP     an SSDP search for an Internet gateway device (UDP multicast 239.255.255.250:1900)
//   NAT-PMP  a public-address request (version 0, opcode 0) to the default gateway's UDP port 5351
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';

const SSDP_SEARCH = ['M-SEARCH * HTTP/1.1', 'HOST: 239.255.255.250:1900', 'MAN: "ssdp:discover"', 'MX: 2',
  'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1', '', ''].join('\r\n');

/** One UDP question and the first answer `good` accepts within `ms`: the answer's sender, or null. */
function ask({ host, port, payload, good, ms }) {
  return new Promise((done) => {
    let sock;
    try { sock = createSocket('udp4'); } catch { return done(null); }
    let over = false;
    const end = (v) => { if (over) return; over = true; clearTimeout(t); try { sock.close(); } catch { /* closed */ } done(v); };
    const t = setTimeout(() => end(null), ms);
    sock.on('error', () => end(null));
    sock.on('message', (msg, from) => { if (good(msg)) end(from.address); });
    sock.send(payload, port, host, (e) => { if (e) end(null); });
  });
}

/** The default gateway's IPv4 address, or null: Linux /proc/net/route, macOS `route -n get default`; elsewhere none (UPnP alone is asked). */
export async function defaultGateway({ platform = process.platform, readRoutes = () => readFileSync('/proc/net/route', 'utf8'),
  run = (cmd, args) => new Promise((ok) => execFile(cmd, args, { timeout: 3000 }, (e, out) => ok(e ? '' : String(out)))) } = {}) {
  if (platform === 'linux') {
    try {
      for (const line of readRoutes().split('\n').slice(1)) {
        const [, dest, gw] = line.trim().split(/\s+/);
        if (dest === '00000000' && gw && gw !== '00000000') return gw.match(/../g).reverse().map((h) => parseInt(h, 16)).join('.');   // little-endian hex
      }
    } catch { /* no routes file */ }
    return null;
  }
  if (platform === 'darwin') { const m = /gateway:\s*([0-9.]+)/.exec(await run('route', ['-n', 'get', 'default'])); return m ? m[1] : null; }
  return null;
}

/**
 * Answers { answered, by: 'UPnP' | 'NAT-PMP' | null, gateway, why }: whether LND's `nat` would find a router to ask. Both are asked at
 * once; `ms` each (LND itself gives up on NAT-PMP after about 10 s).
 */
export async function routerForwards({ ms = 3000, gateway = defaultGateway, askUdp = ask } = {}) {
  const gw = await gateway().catch(() => null);
  const [upnp, pmp] = await Promise.all([
    askUdp({ host: '239.255.255.250', port: 1900, payload: Buffer.from(SSDP_SEARCH), ms,
      good: (m) => /InternetGatewayDevice|WANIPConnection|WANPPPConnection/i.test(m.toString('latin1')) }),
    gw ? askUdp({ host: gw, port: 5351, payload: Buffer.from([0, 0]), ms,
      good: (m) => m.length >= 12 && m[0] === 0 && m[1] === 128 && m.readUInt16BE(2) === 0 }) : Promise.resolve(null),
  ]);
  if (upnp) return { answered: true, by: 'UPnP', gateway: gw, why: `a UPnP Internet gateway answered at ${upnp}` };
  if (pmp) return { answered: true, by: 'NAT-PMP', gateway: gw, why: `the router ${gw} answered NAT-PMP` };
  return { answered: false, by: null, gateway: gw, why: `no router here forwards ports on request: no UPnP Internet gateway answered, and ${gw ? `the router ${gw} did not answer NAT-PMP` : 'no default gateway was found to ask by NAT-PMP'}` };
}
