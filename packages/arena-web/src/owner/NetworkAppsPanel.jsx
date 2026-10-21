// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NETWORK'S APPS, IN REACT (kanban #564): the games and markets the other nodes run that this one does not (GET /network-games: name,
// type, version, how many seats host it, the developer's signed description), and any node looked at by its address. Install / Update
// first CHECKS THE PACKAGE IN THIS BROWSER - the page's own client (checkPackage against the game id, its developer signature, checkUpdate
// against the version hosted here), every check shown - and only then asks the seat, which checks it again and runs it in a sandbox first
// (POST /owner/plugins/install | update, signed). From the network list one Install takes it as soon as every check passed; for a node
// looked at by address the owner reads the report and presses Install. `client` = { checkPackage, checkUpdate, verifyEd25519, toHex,
// fromHex }; `api` = { get(path), post, signed, fetchJson(url) } (fetchJson throws the seat's text when it does not answer 200).
import React from 'react';
import { Button } from '../design/components.jsx';
import { InfoLine } from './AppsPanel.jsx';

/** A newer version of a game hosted here: its parent is hosted (not superseded) and named in its manifest. */
export function parentOf(g, hosted) {
  let parent = null;
  for (const h of hosted) if (!h.supersededBy && g.manifest && g.manifest.includes(h.id)) parent = h;
  return parent;
}
/** What another node offers that this one does not run, each with the hosted version it would update. */
export const offersOf = (games, hosted) => (games || []).filter((g) => !hosted.some((h) => h.id === g.id)).map((g) => ({ g, parent: parentOf(g, hosted) }));

export class Report extends React.Component {
  render() {
    const r = this.props.report;
    if (!r) return null;
    return (
      <div className="report">
        {(r.checks || []).map((c, i) => <div key={i} className="row"><span>{c.ok ? '✓' : '✗'} {c.check}</span><b className="sub">{c.detail || ''}</b></div>)}
        {r.ok === false && r.why ? <p className="err">{r.why}</p> : null}
      </div>);
  }
}

export class NetworkAppsPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hosted: [], ng: null, foundError: null, from: '', look: null, lookError: null, checks: {}, done: null, ...(props.initial || {}) };
    this.search = this.search.bind(this); this.look = this.look.bind(this);
  }
  componentDidMount() { if (this.props.api && !this.state.ng) { this.reloadMine(); this.search(false); } }
  async reloadMine() {
    let got = null; try { got = await this.props.api.get('/owner/plugins'); } catch { got = null; }
    this.setState({ hosted: (got && got.hosted) || [] });
  }
  async search(fresh) {
    try { this.setState({ ng: await this.props.api.get('/network-games' + (fresh ? '?fresh=1' : '')), foundError: null }); }
    catch (e) { this.setState({ foundError: `the seat did not answer: ${e.message}` }); }
  }
  async look() {
    const from = this.state.from.trim().replace(/\/+$/, '');
    this.setState({ look: null, lookError: null });
    let got; try { got = await this.props.api.fetchJson(`${from}/games`); } catch (e) { return this.setState({ lookError: `That seat did not answer: ${e.message}` }); }
    this.setState({ look: { from, offers: offersOf(got.games, this.state.hosted) } });
  }
  setCheck(id, v) { this.setState((s) => ({ checks: { ...s.checks, [id]: { ...(s.checks[id] || {}), ...v } } })); }
  /** Check in this browser; with `auto`, take it as soon as every check passed. Answers whether it was taken. */
  async check({ g, parent, from, auto }) {
    const { client } = this.props;
    this.setCheck(g.id, { state: 'checking', report: null, why: null });
    let pkg; try { pkg = await this.props.api.fetchJson(`${from}/plugin?game=${g.id}`); }
    catch (e) { this.setCheck(g.id, { state: 'refused', why: `That seat did not hand the game over: ${e.message}` }); return false; }
    const parentOfId = (id) => { const h = parent && parent.id === client.toHex(id) ? parent : null; return h ? { gameDevPubkey: client.fromHex(h.devKey), version: h.version } : null; };
    const r = client.checkPackage(pkg, { verify: client.verifyEd25519, want: g.id, parentOf: parentOfId });
    let u = { ok: true };
    if (r.ok && parent) u = client.checkUpdate({ gameId: parent.id, devKey: parent.devKey, version: parent.version }, r);
    const ok = r.ok && u.ok;
    this.setCheck(g.id, { state: ok ? 'checked' : 'failed', report: r, why: u.ok ? null : u.why, take: ok ? { g, parent, from } : null });
    if (ok && auto) return this.take({ g, parent, from });
    return false;
  }
  async take({ g, parent, from }) {
    this.setCheck(g.id, { state: 'taking' });
    try {
      const res = parent ? await this.props.api.post('/owner/plugins/update', await this.props.api.signed('update', { game: g.id, from, replaces: parent.id }))
        : await this.props.api.post('/owner/plugins/install', await this.props.api.signed('install', { game: g.id, from }));
      this.setCheck(g.id, { state: 'taken', report: res, why: null });
      this.setState({ done: `${g.title || g.name} v${g.version} ${parent ? 'updated' : 'installed'} - running now ✓` });
      await this.reloadMine(); await this.search(false);
      if (this.props.onChanged) this.props.onChanged();
      return true;
    } catch (e) { this.setCheck(g.id, { state: 'refused', why: e.message }); return false; }
  }
  checkBox(g) {
    const c = this.state.checks[g.id];
    if (!c) return null;
    return (
      <div>
        {c.state === 'checking' ? <p className="sub">checking in this browser…</p> : null}
        <Report report={c.report} />
        {c.why ? <p className="err">{c.why}</p> : null}
        {c.state === 'checked' && c.take ? <><Button primary onClick={() => this.take(c.take)}>{c.take.parent ? 'Update' : 'Install'}</Button><p className="sub">The seat checks it again and runs it in a sandbox first.</p></> : null}
        {c.state === 'taking' ? <p className="sub">the seat is checking…</p> : null}
        {c.state === 'taken' ? <p className="ok">{c.take && c.take.parent ? 'Updated' : 'Installed'} - running now ✓</p> : null}
      </div>);
  }
  /** One app another node runs, as a card (kanban #565): its initial, name, version, kind and seats, its signed description, Install / Update. */
  offerCard(g, hosted) {
    const parent = g.updateOf ? hosted.find((h) => h.id === g.updateOf) || null : null;
    const c = this.state.checks[g.id];
    return (
      <div key={g.id} className="app-card">
        <div className="app-head"><span className="app-ic" aria-hidden="true">{(g.title || '?').slice(0, 1).toUpperCase()}</span>
          <b className="app-name">{g.title}</b><span className="pill">v{g.version}</span></div>
        {g.infoSigned ? <InfoLine info={{ description: g.description, website: g.website }} /> : <div className="sub info">no signed description</div>}
        <div className="app-foot"><span className="sub">{g.type} · on {g.seats.length} node{g.seats.length === 1 ? '' : 's'}</span>
          <Button primary disabled={!!c && c.state === 'checking'} onClick={() => this.check({ g, parent, from: g.seats[0], auto: true })}>{g.updateOf ? 'Update' : 'Install'}</Button></div>
        {this.checkBox(g)}
      </div>);
  }
  render() {
    const { ng, foundError, hosted, look, lookError, done, from } = this.state;
    const offers = ng ? (ng.games || []).filter((g) => !g.hostedHere) : [];
    const answered = ng ? (ng.seats || []).filter((x) => x.answered).length : 0;
    return (
      <div>
        <div className={`summary ${foundError || (ng && !answered) ? 'bad' : 'good'}`}>
          <div><b>{foundError ? 'The network was not read' : !ng ? 'Asking the network\'s nodes…' : !answered ? 'No other node answered: nothing to compare yet' : offers.length ? `${offers.length} app${offers.length === 1 ? '' : 's'} this node does not run` : 'This node runs every app the others do'}</b>
            <span className="sub">{foundError || (ng ? `${answered} of ${(ng.seats || []).length} nodes answered · ${ng.atMs ? new Date(ng.atMs).toLocaleTimeString() : '-'}` : '')}</span></div>
          <button type="button" className="mini" onClick={() => this.search(true)}>Search again</button>
        </div>
        {done ? <p className="ok">{done}</p> : null}
        {offers.length ? <div className="app-grid">{offers.map((g) => this.offerCard(g, hosted))}</div> : null}
        <details className="settings-card"><summary className="sub">Or look at one node by its address</summary>
          <div className="inline"><input placeholder="https://node.example" autoComplete="off" autoCapitalize="none" value={from} onChange={(e) => this.setState({ from: e.target.value })} />
            <Button onClick={this.look}>Look</Button></div></details>
        {lookError ? <p className="err">{lookError}</p> : null}
        {look && !look.offers.length ? <p className="sub">That node has nothing this node does not already have.</p> : null}
        {look && look.offers.length ? <div className="app-grid">{look.offers.map(({ g, parent }) => (
          <div key={g.id} className="app-card"><div className="app-head"><span className="app-ic" aria-hidden="true">{(g.title || g.name || '?').slice(0, 1).toUpperCase()}</span>
            <b className="app-name">{g.title || g.name}</b><span className="pill">{g.attested ? 'market' : 'game'}</span></div>
            <div className="app-foot"><code className="sub">{g.id.slice(0, 12)}…</code><Button onClick={() => this.check({ g, parent, from: look.from, auto: false })}>Check{parent ? ' update' : ''}</Button></div>
            {this.checkBox(g)}</div>))}</div> : null}
      </div>
    );
  }
}
