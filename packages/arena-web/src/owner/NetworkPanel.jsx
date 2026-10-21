// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER DASHBOARD'S NETWORK, IN REACT (kanban #564; the network store of 2026-10-10): the network this node plays on in four lines -
// its chain, the donation addresses in force, the game series, its federation - with who signs each folded away (kanban #553); a draining
// federation and its successor (§23A.6); the network packages installed here with Remove (POST /owner/network/remove, signed; the seat
// refuses while a round depends on it); and another node's network package taken on the check-then-install path: checked IN THIS BROWSER
// with the page's client (checkNetworkPackage against this seat's chain and the games it hosts; checkNetworkUpdate against the set in
// force), then installed or updated by the seat, which checks it again and tries its series at its own doors first.
import React from 'react';
import { Button } from '../design/components.jsx';
import { Report } from './NetworkAppsPanel.jsx';

export const WHO = Object.freeze({
  chain: 'the network\'s genesis - its network id commits to the chain',
  sets: 'the network\'s donation authority (Ed25519); a new authority only by its recovery key',
  series: 'the protocol\'s series rules: this network, the genesis grid and lead, the set in force, a game this node hosts',
  invite: 'the federation\'s own guardians (its signed record). Nobody types an invite: each federation\'s record carries it, and this node finds federations by itself',
});
export const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
/** The donation set in force: the highest serial. */
export const setInForce = (sets) => (sets || []).reduce((a, x) => (!a || BigInt(x.serial) > BigInt(a.serial) ? x : a), null);

export class FourRows extends React.Component {
  render() {
    const n = this.props.network;
    const sets = n.sets || [], series = n.series || [], held = series.filter((x) => x.held !== false);
    const top = setInForce(sets);
    return (
      <div>
        <div className="row"><span>Chain</span><b>{n.chain || ''}</b></div>
        <div className="row"><span>Donation addresses</span><b>{top ? `set ${top.serial} in force (since block ${top.validFrom})` : 'none'}</b></div>
        <div className="row"><span>Game series</span><b>{held.length} running{series.length > held.length ? ` · ${series.length - held.length} not on this node` : ''}</b></div>
        <div className="row"><span>Federation</span><b>{n.federationId ? `${String(n.federationId).slice(0, 16)}…` : 'found by itself'}</b></div>
        <details><summary className="sub">Details and who signs each</summary>
          <p className="sub"><b>Chain</b> - signed by {WHO.chain}.</p>
          <p className="sub"><b>Donation addresses</b> - {sets.map((x) => `set ${x.serial} from block ${x.validFrom}`).join(', ') || 'none'}; signed by {WHO.sets}.</p>
          <p className="sub"><b>Game series</b> - {series.length ? series.map((x, i) => <React.Fragment key={x.id}>{i ? <br /> : null}{x.id.slice(0, 12)}… {x.startMs ? when(x.startMs) : ''}{x.held === false ? ' (not on this node)' : ''}</React.Fragment>) : 'none'}<br />signed by {WHO.series}.</p>
          <p className="sub"><b>Federation</b> - signed by {WHO.invite}.</p></details>
      </div>);
  }
}

export class NetworkPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { loaded: false, mine: { chain: null, own: null, installed: [], draining: [] }, games: [], from: '', offer: null, report: null, take: null, taking: false, done: null, error: null, ...(props.initial || {}) };
    this.look = this.look.bind(this); this.check = this.check.bind(this); this.take = this.take.bind(this);
  }
  componentDidMount() { if (!this.state.loaded && this.props.api) this.reload(); }
  async reload() {
    let mine = { chain: null, own: null, installed: [], draining: [] }, games = [];
    try { const got = await this.props.api.get('/owner/network'); mine = { ...mine, ...(got || {}), installed: (got && got.installed) || [], draining: (got && got.draining) || [] }; } catch { /* shown as empty */ }
    try { games = ((await this.props.api.get('/owner/plugins')).hosted || []).map((g) => g.id); } catch { games = []; }
    this.setState({ loaded: true, mine, games });
  }
  async remove(network) {
    this.setState({ error: null });
    try { await this.props.api.post('/owner/network/remove', await this.props.api.signed('network-remove', { network })); await this.reload(); } catch (e) { this.setState({ error: e.message }); }
  }
  async look() {
    const from = this.state.from.trim().replace(/\/+$/, '');
    this.setState({ offer: null, report: null, take: null, done: null, error: null });
    let pkg; try { pkg = await this.props.api.fetchJson(`${from}/network`); } catch (e) { return this.setState({ error: `That seat did not hand its network over: ${e.message}` }); }
    const m = pkg.manifest || {};
    this.setState({ offer: { from, pkg, m, installed: this.state.mine.installed.find((n) => n.network === m.networkId) || null } });
  }
  check() {
    const { client } = this.props; const { offer, mine, games } = this.state;
    const r = client.checkNetworkPackage(offer.pkg, { verify: client.verifyEd25519, seatChain: mine.chain, hostsGame: (id) => games.includes(id) });
    let u = { ok: true };
    if (r.ok && offer.installed) {
      const top = offer.installed.sets.reduce((a, x) => (BigInt(x.serial) > a ? BigInt(x.serial) : a), -1n);
      u = client.checkNetworkUpdate({ networkId: offer.installed.network, chain: offer.installed.chain, topSerial: top }, r);
    }
    this.setState({ report: { ...r, ok: r.ok, why: r.why }, take: r.ok && u.ok, error: u.ok ? null : u.why });
  }
  async take() {
    const { offer } = this.state;
    this.setState({ taking: true });
    try {
      const res = offer.installed ? await this.props.api.post('/owner/network/update', await this.props.api.signed('network-update', { network: offer.m.networkId, from: offer.from }))
        : await this.props.api.post('/owner/network/install', await this.props.api.signed('network-install', { network: offer.m.networkId, from: offer.from }));
      this.setState({ report: res, take: false, taking: false, done: `${offer.installed ? 'Updated' : 'Installed'} - in force now ✓` });
      await this.reload();
    } catch (e) { this.setState({ taking: false, error: e.message }); }
  }
  render() {
    const { loaded, mine, from, offer, report, take, taking, done, error } = this.state;
    if (!loaded) return <p className="sub">reading this node's network…</p>;
    return (
      <div>
        {mine.draining.map((d) => <p key={d.federationId} className="warnline">Federation {d.federationId.slice(0, 12)}… is being replaced by {d.successor.slice(0, 12)}… (since {when(d.sinceMs)}): new rounds and deposits go to the new one.</p>)}
        {mine.own && !mine.own.why ? <FourRows network={mine.own} /> : <div className="row"><span>Chain</span><b>{mine.chain || 'none named'}</b></div>}
        {mine.installed.map((n) => (
          <div key={n.network} className="card"><div className="row"><span>Installed · network {n.network.slice(0, 12)}… · package {n.id.slice(0, 12)}…</span>
            <b><Button onClick={() => this.remove(n.network)}>Remove</Button></b></div><FourRows network={n} /></div>))}
        <details><summary className="sub">Take a network from another node</summary>
          <label>Another node's address</label>
          <input placeholder="https://node.example" autoComplete="off" autoCapitalize="none" value={from} onChange={(e) => this.setState({ from: e.target.value })} />
          <Button onClick={this.look}>Look</Button></details>
        {offer ? (
          <div className="card">
            <div className="row"><span>{offer.pkg.title || offer.m.chain} · package {String(offer.pkg.id || '').slice(0, 12)}…</span><b><Button onClick={this.check}>Check{offer.installed ? ' update' : ''}</Button></b></div>
            <div className="row"><span>Chain</span><b>{offer.m.chain}</b></div>
            <div className="row"><span>Donation sets</span><b>{(offer.m.donationSets || []).length} · {(offer.m.donationSets || []).map((x) => `${x.slice(0, 10)}…`).join(', ')}</b></div>
            <div className="row"><span>Series</span><b>{(offer.m.series || []).length} · {(offer.m.series || []).map((x) => `${x.slice(0, 10)}…`).join(', ')}</b></div>
            <div className="row"><span>Federation</span><b>{String(offer.m.federationId).slice(0, 12)}…</b></div>
            <Report report={report} />
            {take ? <><Button primary disabled={taking} onClick={this.take}>{taking ? 'the seat is checking…' : offer.installed ? 'Update' : 'Install'}</Button><p className="sub">The seat checks it again and tries its series at its own doors first.</p></> : null}
            {done ? <p className="ok">{done}</p> : null}
          </div>) : null}
        {error ? <p className="err">{error}</p> : null}
      </div>
    );
  }
}
