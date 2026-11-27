// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// "CHECK MY NODE" (kanban #3798, the owner 2026-11-26: "eine eigene Test/Diagnose-Seite, ob der Tunnel von aussen erreichbar ist, und im
// Dashboard auch etwas anzeigen, wenn wir ein Problem entdecken. Einfach zu bedienen und intuitiv."). One button, five lines, each green or
// red with one sentence on what to do:
//   1 your address now         what the node serves (POST /owner/reach)
//   2 the network's address    what the seats' census names for this key (GET /reach-probe on each seat) - and the update on its way (#3565)
//   3 reachable from outside   three seats dial the census and announced addresses (GET /reach-probe): the name, the certificate, time, HTTP
//   4 response time            over 3 s is a warning (seen: bitcoind's RPC queue full, 8-13 s)
//   5 drawn into rounds        the last 24 h (GET /owner/rounds)
// The check runs by itself on the page every few minutes too; onResult hands the worst line to the Overview (the page's need()).
import React from 'react';
import { Button } from '../design/components.jsx';

export const SLOW_MS = 3000;
export const EVERY_MS = 5 * 60000;
const norm = (u) => String(u || '').trim().replace(/\/+$/, '').replace(/^ws(s?):/i, 'http$1:').toLowerCase();
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** One sentence for why an address could not be reached (reach-probe.js kinds). */
export function whyNot(r) {
  if (!r) return 'No seat could reach it.';
  switch (r.kind) {
    case 'dns': return 'This address does not exist on the internet (any more). A quick tunnel gets a new name at every restart: choose a stable address under Services.';
    case 'tls': return 'The address answers, but its security certificate is broken. Check the settings of your tunnel or domain.';
    case 'timeout': return 'Nothing answered within 8 seconds. Make sure the tunnel is running. A Tailscale Funnel address can be unreachable from some regions: a Cloudflare address works everywhere.';
    case 'refused': return 'The connection was refused: nothing listens there, or a firewall blocks it.';
    case 'blocked': return 'The address points into a private network, so nobody outside can use it.';
    case 'other-node': return 'A different node answers at this address.';
    case 'http':
      if ([502, 503, 504, 530].includes(r.status)) return `The tunnel answers, but your node behind it does not (error ${r.status}). Restart your node and its tunnel.`;
      if (r.status === 404) return 'Something answers there, but not an Arena node (error 404).';
      return `The address answers with error ${r.status}.`;
    default: return 'The connection failed. Check the tunnel and the internet connection of your node.';
  }
}

/** The most common failure among results (for one sentence of advice). */
const commonFailure = (rs) => {
  const by = new Map();
  for (const r of rs) if (!r.reached) { const k = `${r.kind}:${r.status || ''}`; by.set(k, [...(by.get(k) || []), r]); }
  return [...by.values()].sort((a, b) => b.length - a.length)[0]?.[0] || null;
};

/**
 * THE FIVE LINES from what was read. `reach` the POST /owner/reach answer (or null), `pageBase` the address this page reached the node at,
 * `probes` [{ seat, body }] (body null: the seat did not answer the check), `rounds` the GET /owner/rounds answer (or null), `nowMs`.
 * Each line { id, level: ok | warn | bad | unknown, title, says, fix }.
 */
export function diagnose({ reach = null, pageBase = null, probes = [], rounds = null, nowMs = Date.now() } = {}) {
  const lines = [];
  // public_url edited by hand (kanban #3885): the node runs on it, whatever the installer set up
  const edited = reach && reach.ok && reach.follow && reach.follow.mismatch && reach.follow.mismatch.confDiffers ? reach.follow.mismatch.conf : null;
  const current = edited || (reach && reach.ok && (reach.url || reach.serving)) || (/^https?:\/\//.test(pageBase || '') && !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(pageBase) ? pageBase : null);
  // 1 THE ADDRESS NOW
  lines.push(current ? { id: 'address', level: 'ok', title: 'Your node\'s address', says: current, fix: null }
    : { id: 'address', level: 'bad', title: 'Your node\'s address', says: 'Your node has no public address.', fix: 'Choose how others reach your node under Services, Address.' });
  // 2 WHAT THE NETWORK NAMES
  const answered = probes.filter((p) => p && p.body && (p.body.ok || p.body.census));
  const census = [...new Set(answered.flatMap((p) => p.body.census || []).map(String))];
  const fromNode = reach && reach.follow && Array.isArray(reach.follow.advertised) ? reach.follow.advertised : [];
  const named = census.length ? census : fromNode;
  const f = reach && reach.follow, bonded = !!(f && f.bonded);
  const matches = !!current && named.some((u) => norm(u) === norm(current));
  if (!answered.length && !fromNode.length) lines.push({ id: 'census', level: 'unknown', title: 'Address the network has', says: 'The network could not be asked right now.', fix: 'Try again in a minute.' });
  else if (matches) lines.push({ id: 'census', level: 'ok', title: 'Address the network has', says: 'The network has your current address.', fix: null });
  else if (!named.length) lines.push({ id: 'census', level: bonded ? 'bad' : 'warn', title: 'Address the network has', says: bonded ? 'The network has no address for your node.' : 'Your node has no bond yet, so the network only knows it from its own announcement.', fix: bonded ? 'Your node sends its address by itself within 10 minutes. If this stays red, restart the node.' : 'Set up the bond under Bond.' });
  else {
    const old = named.join(', ');
    let fix;
    if (f && f.update && f.update.txid) fix = `The update naming your new address was sent (${String(f.update.txid).slice(0, 12)}…). The network takes it about ${f.takesBlocks || 12} blocks after it is sent (about ${Math.round(((f.takesMinutes || 120) / 60))} hours). Nothing to do but wait.`;
    else if (f && f.update && f.update.fee && f.update.fee.enough === false) fix = `Your node's wallet cannot pay the update naming your new address: send at least ${f.update.fee.sendSats} sat to ${f.update.fee.deposit}. It posts the update by itself within 10 minutes of the deposit.`;   // kanban #3888
    else if (f && f.update && f.update.why) fix = `The update naming your new address could not be sent: ${f.update.why}. Your node tries again every 10 minutes; most often it needs a few thousand sats in its wallet for the fee.`;
    else if (f && f.mismatch && f.mismatch.confDiffers) fix = f.mismatch.adoptable ? `public_url in arena.conf was changed to ${f.mismatch.conf}, but changing it and restarting changes nothing for the network. Post the advertisement update under Services, Address.` : `public_url in arena.conf was changed to ${f.mismatch.conf}. ${f.mismatch.quick ? 'A quick tunnel is never put on chain: choose a stable address under Services.' : 'An advertisement update must name it: see Services, Address.'}`;   // kanban #3885
    else fix = 'No update naming your new address has been sent yet. Your node sends one by itself within 10 minutes; if this stays red, restart the node.';
    lines.push({ id: 'census', level: f && f.update && f.update.txid ? 'warn' : 'bad', title: 'Address the network has', says: `The network still sends players to ${old}, not to your current address.`, fix });
  }
  // 3 REACHABLE FROM OUTSIDE: each seat's results for the address now (the census one when the seat holds no other)
  const all = answered.flatMap((p) => (p.body.results || []).map((r) => ({ ...r, seat: p.seat })));
  const forCurrent = current ? all.filter((r) => norm(r.url) === norm(current)) : [];
  const ofCensus = all.filter((r) => (r.from || []).includes('census'));
  const judged = forCurrent.length ? forCurrent : ofCensus;
  const reached = judged.filter((r) => r.reached);
  if (!answered.length) lines.push({ id: 'reach', level: 'unknown', title: 'Reachable from the network', says: 'The network could not be asked right now.', fix: 'Try again in a minute.' });
  else if (!judged.length) lines.push({ id: 'reach', level: 'bad', title: 'Reachable from the network', says: 'The network does not know where to find your node.', fix: 'Your node tells the network its address every 10 minutes. Make sure it is running and has a public address.' });
  else if (reached.length && reached.length * 2 >= judged.length) lines.push({ id: 'reach', level: 'ok', title: 'Reachable from the network', says: `${reached.length} of ${judged.length} checks from the network reached your node.`, fix: null });
  else lines.push({ id: 'reach', level: 'bad', title: 'Reachable from the network', says: `${reached.length} of ${judged.length} checks from the network reached your node.`, fix: whyNot(commonFailure(judged)) });
  // an old census address that is gone, said on line 2 too
  const deadOld = ofCensus.filter((r) => !forCurrent.includes(r) && !r.reached);
  if (deadOld.length && lines[1].level !== 'ok') lines[1].fix = `${lines[1].fix} The old address does not answer any more: ${whyNot(deadOld[0])}`;
  // 4 RESPONSE TIME
  if (!reached.length) lines.push({ id: 'speed', level: 'unknown', title: 'Response time', says: 'Not measured: your node was not reached.', fix: null });
  else {
    const slowest = Math.max(...reached.map((r) => Number(r.ms) || 0));
    lines.push(slowest > SLOW_MS ? { id: 'speed', level: 'warn', title: 'Response time', says: `Your node answers slowly (up to ${secs(slowest)}).`, fix: 'Usually Bitcoin Core is busy. Give it more threads (rpcthreads=16 in bitcoin.conf) or a faster disk, and check the load of the machine.' }
      : { id: 'speed', level: 'ok', title: 'Response time', says: `Your node answers in ${secs(slowest)} or less.`, fix: null });
  }
  // 5 DRAWN INTO ROUNDS IN THE LAST 24 HOURS
  if (!rounds) lines.push({ id: 'rounds', level: 'unknown', title: 'Rounds in the last 24 hours', says: 'Could not read the rounds of your node.', fix: null });
  else {
    const day = (rounds.rounds || []).filter((r) => r.startMs >= nowMs - 86400000 && r.startMs <= nowMs && (r.gameSeated || r.settleSeated || r.drawn));
    lines.push(day.length ? { id: 'rounds', level: 'ok', title: 'Rounds in the last 24 hours', says: `Your node was drawn for ${day.length} round${day.length === 1 ? '' : 's'}.`, fix: null }
      : { id: 'rounds', level: 'warn', title: 'Rounds in the last 24 hours', says: 'Your node was not drawn for any round.', fix: rounds.why && rounds.why.says ? rounds.why.says : 'A node the network cannot reach is not drawn. A new bond takes about a day before the first draw.' });
  }
  return lines;
}

/** The worst level of the lines: bad, then warn, else ok (unknown counts as nothing found). */
export const worst = (lines) => (lines.some((l) => l.level === 'bad') ? 'bad' : lines.some((l) => l.level === 'warn') ? 'warn' : 'ok');

const MARK = { ok: '✓', warn: '!', bad: '✗', unknown: '?' };

export class ReachCheckPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { busy: false, lines: null, atMs: null, ...(props.initial || {}) };
    this.run = this.run.bind(this);
  }
  componentDidMount() {
    if (!this.props.api || this.state.lines) return;
    this.first = setTimeout(this.run, this.props.firstMs ?? 15000);
    this.timer = setInterval(this.run, this.props.everyMs || EVERY_MS);
  }
  componentWillUnmount() { clearTimeout(this.first); clearInterval(this.timer); }
  async run() {
    if (this.state.busy) return;
    this.setState({ busy: true });
    const { api, node, seats = [], pageBase = null } = this.props;
    const ask = async (seat) => {
      try {
        const r = await fetch(`${String(seat).replace(/\/+$/, '')}/reach-probe?node=${node}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
        let body = null; try { body = await r.json(); } catch { body = null; }
        return { seat, body: body && typeof body === 'object' ? body : null };
      } catch { return { seat, body: null }; }
    };
    const [reach, probes, rounds] = await Promise.all([
      (async () => api.post('/owner/reach', await api.signed('reach')))().catch(() => null),
      Promise.all(seats.slice(0, 3).map(ask)),
      (async () => api.get('/owner/rounds'))().catch(() => null)]);
    const lines = diagnose({ reach, pageBase, probes, rounds, nowMs: Date.now() });
    this.setState({ busy: false, lines, atMs: Date.now() });
    if (this.props.onResult) this.props.onResult(worst(lines), lines);
  }
  render() {
    const { busy, lines, atMs } = this.state;
    return (
      <div className="reachcheck">
        <p className="lead">Is your node reachable from the internet? This asks three nodes of the network to visit your node, the way players and other nodes do.</p>
        <Button primary disabled={busy} onClick={this.run}>{busy ? 'Checking… (up to 20 s)' : lines ? 'Check again' : 'Check my node'}</Button>
        {lines ? <ul className="rc-lines">{lines.map((l) => (
          <li key={l.id} className={`rc rc-${l.level}`} data-check={l.id}>
            <span className="rc-mark" aria-hidden="true">{MARK[l.level]}</span>
            <div><b>{l.title}</b><div className="rc-says">{l.says}</div>{l.fix ? <div className="rc-fix">{l.fix}</div> : null}</div>
          </li>))}</ul> : null}
        {atMs ? <p className="sub">Checked at {new Date(atMs).toISOString().slice(11, 16)} UTC. It runs again by itself every few minutes.</p> : null}
      </div>);
  }
}
