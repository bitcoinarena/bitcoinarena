// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER AREA IN REACT (kanban #564): what owner.html's area() drew by hand - the sidebar (a top menu on a phone) with a dot where a
// section needs the owner, one section at a time chosen by the address's # (kanban #553), the Overview (what needs the owner, the node at a
// glance as stat cards - kanban #565), every section's heading and lead with the places its panels are drawn into, the emergency code
// (spec §23A.5a: shown on a press, made from the words, never kept), signing a game or market with the developer key, and the login (the
// words shown, or signed out). The page draws each panel into its place (an element React leaves empty) and hands over the rest:
// `needs` (the need() list, null while nothing has said yet), the node's facts, `onShowWords()`, `onForget()`, `emergencyCode`, `devKey`,
// `signManifest(text)`.
import React from 'react';
import { NeedsPanel, ordered } from './NeedsPanel.jsx';

export const SECTIONS = [['overview', 'Overview'], ['roles', 'Roles'], ['bond', 'Bond'], ['services', 'Services'], ['apps', 'Apps'], ['release', 'Updates'],
  ['money', 'Donations'], ['emergency', 'Emergency code'], ['leave', 'Leave'], ['developer', 'Developer'], ['login', 'Your login']];
const HOW = { words: 'your 24 words', nsec: 'Nostr (nsec)', extension: 'Nostr (extension)', bunker: 'Nostr (remote signer)' };
/** a place a panel is drawn into: React draws it empty and never touches what the page puts in it */
const Place = ({ id, className = 'card' }) => <div className={className || undefined} id={id} />;
const field = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false };

export class OwnerArea extends React.Component {
  constructor(props) {
    super(props);
    this.state = { section: this.fromHash(), words: null, emShown: false, manifest: '', signed: null, signErr: '', copied: false };
    this.onHash = () => { this.setState({ section: this.fromHash() }); window.scrollTo(0, 0); };
  }
  fromHash() { const want = (typeof location !== 'undefined' ? location.hash : '').slice(1) || 'overview'; return SECTIONS.some(([x]) => x === want) ? want : 'overview'; }
  componentDidMount() { window.addEventListener('hashchange', this.onHash); }
  componentWillUnmount() { window.removeEventListener('hashchange', this.onHash); }
  sign() {
    this.setState({ signErr: '', signed: null, copied: false });
    try { this.setState({ signed: this.props.signManifest(this.state.manifest) }); } catch (e) { this.setState({ signErr: e.message }); }
  }
  copy() { navigator.clipboard.writeText(this.state.signed.hex).then(() => this.setState({ copied: true }), () => { if (this.hex) this.hex.select(); }); }
  render() {
    const p = this.props, s = this.state, on = s.section;
    const dots = new Map(); for (const n of ordered(p.needs || [])) if (!dots.has(n.section)) dots.set(n.section, n.level);
    const sec = (id, children) => <section id={'s-' + id} hidden={on !== id}>{children}</section>;
    const games = p.games || [];
    return (
      <div className="layout">
        <nav className="side" id="side">{SECTIONS.map(([id, t]) => <a key={id} href={'#' + id} data-s={id} className={on === id ? 'on' : undefined}>{t}<span className={'dot' + (dots.has(id) ? ' d-' + dots.get(id) : '')} id={'dot-' + id} /></a>)}</nav>
        <main>
          {sec('overview', <><h2>Overview</h2>
            <div className="card" id="needs">{p.needs ? <NeedsPanel items={p.needs} /> : <p className="sub">checking this node…</p>}</div>
            {/* THE NODE AT A GLANCE (kanban #565): one card per fact, the label small, the value large */}
            <div className="stats">
              <div className="stat"><span>Node</span><b className="mono">{p.node.slice(0, 12)}…</b><small>its key on the network</small></div>
              <div className="stat"><span>Custody</span><b className={p.guardian ? 'ok' : undefined}>{p.guardian ? 'Guardian' : 'No custody'}</b><small>{p.guardian ? 'holds players\' bitcoin with its federation' : 'does not hold players\' bitcoin'}</small></div>
              <div className="stat"><span>Apps</span><b>{games.length}</b><small>{games.length ? games.map((g) => `${g.name} v${g.version ?? '?'}`).join(', ') : 'none installed'}</small></div>
              <div className="stat"><span>Owner since</span><b>{new Date(p.claimedAtMs).toISOString().slice(0, 10)}</b><small>signed in with {HOW[p.how] || p.how}</small></div>
              <div className="stat"><span>Owner key</span><b className="mono">{p.owner.slice(0, 12)}…</b><small>the key every owner request is signed with</small></div>
            </div></>)}
          {sec('roles', <><h2>Roles</h2>
            <p className="lead">What this node does for the network, and what each role earns.</p><Place id="roles" />
            <h3 className="sh">Custody (guardian)</h3><Place id="custody" />
            <h3 className="sh">Liquidity provider</h3><Place id="liquidity" /></>)}
          {sec('bond', <><h2>Bond</h2>
            <p className="lead">The bitcoin this node locked so it can be drawn for rounds. It earns your share of the fees.</p>
            <Place id="bond-answer" /><Place id="capacity-plea" className={null} /><Place id="bond" />
            <details className="more"><summary>How this node is drawn (details)</summary><Place id="standing" /></details></>)}
          {sec('services', <><h2>Services</h2>
            <p className="lead">The programs this node runs and whether they answer.</p>
            <h3 className="sh">Address</h3><Place id="address" /><Place id="services" /></>)}
          {sec('apps', <><h2>Apps</h2>
            <p className="lead">Games, markets and networks this node runs. New ones come from other nodes; each is checked here and again by the node before it runs.</p>
            <div className="card" id="store"><h3>On this node</h3><Place id="installed" className={null} /><h3>Found on the network</h3><Place id="netfound" className={null} /></div>
            <h3 className="sh">Network</h3><div className="card" id="nets">
              <p>The network this node plays on: its chain, the donation addresses in force, the game series, and its federations.</p><Place id="netmine" className={null} /></div></>)}
          {sec('release', <><h2>Updates</h2><p className="lead">The version this node runs and whether a newer one is out.</p><Place id="release" /></>)}
          {sec('money', <><h2>Donations</h2>
            <p className="lead">Money this node collects for the developers, and the developers' split.</p>
            <h3 className="sh">Waiting to be collected</h3><Place id="dons" className={null} />
            <h3 className="sh">Dev clients</h3><Place id="devs" className={null} />
            <h3 className="sh">Developer split</h3><Place id="ballots" className={null} /></>)}
          {sec('emergency', <><h2>Emergency code</h2><div className="card" id="emergency">
            <p>If this node will be offline for a while - more than about two days on mainnet, 12 blocks on testnet4 - take it out of the
              network with your emergency code so you keep your bond. Open <a href="https://testnet.bitcoin-arena.io/offline/" target="_blank" rel="noopener"><b>testnet.bitcoin-arena.io/offline</b></a> on any device and type the code.</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', margin: '6px 0 10px' }}><tbody>
              <tr><th style={{ textAlign: 'left' }}>Your node</th><th style={{ textAlign: 'left' }}>What happens</th><th style={{ textAlign: 'left' }}>Your bond</th></tr>
              <tr><td>no custody</td><td>it is out of every draw at once</td><td>kept</td></tr>
              <tr><td>custody, code typed in time</td><td>it leaves; its federation gets a successor</td><td>kept</td></tr>
              <tr><td>custody, too late</td><td>counted as abandoned</td><td>lost</td></tr></tbody></table>
            {p.emergencyCode ? <><div className="row"><span>Your code</span><b id="emcode">{s.emShown ? p.emergencyCode : 'hidden'}</b></div>
              {s.emShown ? null : <button type="button" id="emshow" onClick={() => this.setState({ emShown: true })}>Show the code</button>}</>
              : <p className="sub">This browser signed in without the 24 words, so it cannot make the code. The installer showed it at the seed step; it is made from the same words.</p>}
            <p className="sub">The code can only take this node out - no money, no settings. Never type your 24 words on another node.</p>
            <p className="sub">If the Arena site cannot be reached: the same page is on every node, at <a href={p.emergencyLink}>/Dashboard/emergency</a>.</p></div></>)}
          {sec('leave', <><h2>Leave</h2><Place id="leave" /></>)}
          {sec('developer', <><h2>Developer</h2><div className="card">
            <p>Sign your own game or market. Your developer key comes from the same 24 words: <b id="devkey" className="mono">{p.devKey || 'none with a Nostr signer - sign games with your 24 words or your nsec'}</b></p>
            <label>The manifest (JSON; 32-byte values in hex, large numbers as strings; leave out gameDevPubkey - it is yours)</label>
            <textarea id="body" rows={8} {...field} placeholder='{ "gameName": "my-game", "version": 1, "resultType": "HEAD_TO_HEAD", ... }' value={s.manifest} onChange={(e) => this.setState({ manifest: e.target.value })} />
            <div className="err" id="serr">{s.signErr}</div>
            <button type="button" className="primary" id="sign" disabled={!p.devKey} onClick={() => this.sign()}>Sign</button>
            <div id="signed">{s.signed ? <><div className="row"><span>Game id</span><b>{s.signed.gameId.slice(0, 16)}…</b></div>
              <label>The signed manifest (hex)</label><textarea id="mhex" rows={5} readOnly value={s.signed.hex} ref={(x) => { this.hex = x; }} />
              <button type="button" id="copy" onClick={() => this.copy()}>{s.copied ? 'Copied ✓' : 'Copy'}</button></> : null}</div></div></>)}
          {sec('login', <><h2>Your login</h2>
            {p.how === 'words' ? <div className="card"><p>Your 24 words are kept in this browser only.</p>
              <button type="button" id="show" onClick={() => this.setState({ words: p.onShowWords() })}>Show them</button>
              <button type="button" id="forget" onClick={p.onForget}>Forget them on this browser</button>
              <div id="shown">{s.words ? <div className="words">{s.words.map((w, i) => <span key={i}>{w}</span>)}</div> : null}</div></div>
              : <div className="card"><p>This browser keeps your login{p.how === 'nsec' ? ' and your nsec' : ''}. Your key stays with your {p.how === 'nsec' ? 'nsec - keep it written down' : 'signer'}.</p>
                <button type="button" id="forget" onClick={p.onForget}>Sign out on this browser</button></div>}</>)}
        </main>
      </div>);
  }
}
