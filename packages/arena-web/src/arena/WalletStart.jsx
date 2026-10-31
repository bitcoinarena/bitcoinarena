// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET SCREEN IN REACT (kanban #564, the Arena page): shown at start when this tab holds no wallet - Create (straight into the game,
// its 24 words later in Settings), Restore (the 24 words or the seed), Login with Nostr (extension, phone signer by a code, bunker, nsec,
// or a new account whose key is shown and must be marked saved before anything else). A step that runs says so with a ring and its
// seconds. The page keeps every rule - the seed it makes, the restore, the Nostr bundle and its login (`create`, `restore`, `nostr.*`);
// this class component only draws the panes and calls them.
import React from 'react';

const QUESTIONS = 'https://armada.buzz/invite/naddr1qvzqqqyzz5pzpt3qdj9s02tf33v6t5epfuxgk90eklx42cg2ftatwmuzznkww6anqqqqf5522e#BAEU9DouYIxVptZrIZWPrgMF';

export class WalletStart extends React.Component {
  constructor(props) {
    super(props);
    this.state = { pane: 'main', text: '', why: '', bunker: '', nsec: '', busy: '', since: 0, now: 0, working: false, qr: null,
      fresh: null, name: '', saved: false, copied: false, creating: false };
    this.say = this.say.bind(this);
  }
  componentWillUnmount() { clearInterval(this.tick); }
  // a step that runs (its text ends in "…"): the ring and the seconds since the first step of this wait
  say(text) {
    const wait = !!text && text.endsWith('…');
    if (!wait) { clearInterval(this.tick); this.tick = null; this.setState({ busy: text || '', since: 0 }); return; }
    const now = Date.now();
    this.setState((s) => ({ busy: text, since: s.since || now, now }));
    if (!this.tick && typeof setInterval === 'function') this.tick = setInterval(() => this.setState({ now: Date.now() }), 500);
  }
  pane(p) { this.setState({ pane: p, why: '' }); }
  create() { const r = this.props.create(); if (!r.ok) this.say(r.why); }
  restore() { const r = this.props.restore(this.state.text); this.setState({ why: r.ok ? 'restored - opening your wallet' : r.why }); }
  openNostr() { this.pane('nostr'); this.props.nostr.load().catch((e) => this.fail(e)); }
  fail(e) { this.say(''); this.setState({ why: e && e.message ? e.message : String(e) }); }
  // one way in: the signer it makes, then the account's wallet (the page's login reads its seed from Nostr and reloads with it)
  async attempt(how, make) {
    const N = this.props.nostr;
    this.setState({ why: '', working: true });
    try { await N.load(); await N.login(await make(), how, null, this.say); } catch (e) { this.fail(e); } finally { this.setState({ working: false }); }
  }
  async connect() {
    const N = this.props.nostr;
    this.setState({ why: '' });
    try {
      await N.load();
      const c = N.connect();
      this.setState({ qr: c, working: true });
      await N.login(await c.signer, 'nostrconnect', null, this.say);
    } catch (e) { this.fail(e); } finally { this.setState({ working: false }); }
  }
  // A NEW NOSTR ACCOUNT: its key shown, "I saved my key" before anything else; its name published, its seed made
  async newAccount() {
    const N = this.props.nostr;
    try { await N.load(); } catch (e) { this.fail(e); return; }
    this.setState({ fresh: N.newAccount(), saved: false, copied: false, name: '', pane: 'newacct', why: '' });
  }
  async createAccount() {
    const N = this.props.nostr; const { fresh } = this.state; const name = this.state.name.trim();
    this.setState({ why: '', creating: true });
    try {
      if (name) { this.say('Creating your Nostr account…'); await N.publish(fresh.signer, name); }
      await N.login(fresh.signer, 'new', { name }, this.say);
    } catch (e) { this.say(''); this.setState({ why: e.message, creating: false }); }
  }
  copy() {
    const c = typeof navigator !== 'undefined' && navigator.clipboard;
    if (c) c.writeText(this.state.fresh.nsec).then(() => this.setState({ copied: true }), () => {});
  }
  render() {
    const { pane, why, busy, since, now, working, qr, fresh, saved, creating } = this.state;
    const wait = !!busy && busy.endsWith('…');
    const secs = wait && since ? Math.floor((now - since) / 1000) : 0;
    const off = working;
    return (
      <div className="ws-box">
        <h2 id="ws-title">Your wallet</h2>
        <p className="ws-sub">It holds what you play with and what you win, in this browser. Keep its 24 words - or your Nostr key - to open it anywhere.</p>
        {pane === 'main' ? (
          <div id="ws-main">
            <button type="button" className="primary" onClick={() => this.create()}>Create a new wallet<small>Ready at once - back up its 24 words any time in Settings</small></button>
            <button type="button" onClick={() => this.pane('restore')}>Restore a wallet<small>Your 24 words, or your seed</small></button>
            <button type="button" className="nostr" onClick={() => this.openNostr()}>Login with Nostr<small>Your Nostr account is your wallet: extension, phone signer or nsec</small></button>
          </div>) : null}
        {pane === 'restore' ? (
          <div id="ws-restore-pane">
            <textarea autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="your 24 words, or your seed (64 hex)" value={this.state.text}
              onChange={(e) => this.setState({ text: e.target.value })} />
            <div className="ws-why">{why}</div>
            <button type="button" className="primary" onClick={() => this.restore()}>Restore</button>
            <button type="button" className="link" onClick={() => this.pane('main')}>Back</button>
          </div>) : null}
        {pane === 'nostr' ? (
          <div id="ws-nostr-pane">
            <button type="button" disabled={off} onClick={() => this.attempt('extension', () => this.props.nostr.extension())}>Browser extension<small>Alby, nos2x and others (NIP-07)</small></button>
            <button type="button" disabled={off} onClick={() => this.connect()}>Phone signer<small>Amber and others: scan a code (NIP-46)</small></button>
            {qr ? (
              <div>
                <div className="ws-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
                <p className="ws-note">Scan with your signer{typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? <>, or <a href={qr.uri} style={{ color: '#c9a8ff' }}>open it on this phone</a></> : null}. Waiting for it to answer…</p>
              </div>) : null}
            <input autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="bunker://… or you@your-bunker" value={this.state.bunker} onChange={(e) => this.setState({ bunker: e.target.value })} />
            <button type="button" disabled={off} onClick={() => this.attempt('bunker', () => this.props.nostr.bunker(this.state.bunker))}>Connect a bunker<small>nsec.app, nsecBunker, Amber's bunker link</small></button>
            <div className="ws-or">or, only on a device you trust</div>
            <input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="nsec1…" value={this.state.nsec} onChange={(e) => this.setState({ nsec: e.target.value })} />
            <button type="button" disabled={off} onClick={() => this.attempt('nsec', () => this.props.nostr.nsec(this.state.nsec))}>Log in with my nsec</button>
            <button type="button" disabled={off} onClick={() => this.newAccount()}>New to Nostr? Create an account</button>
            <div className="ws-why">{why}</div>
            <button type="button" className="link" onClick={() => { this.say(''); this.setState({ qr: null }); this.pane('main'); }}>Back</button>
          </div>) : null}
        {pane === 'newacct' && fresh ? (
          <div id="ws-newacct-pane">
            <div className="ws-warn"><b>This is your Nostr account and your wallet.</b> Save this key now - in a password manager or on paper. Nobody can recover it for you, and anyone who has it owns your account and your winnings.</div>
            <div className="ws-key">{fresh.nsec}</div>
            <button type="button" onClick={() => this.copy()}>{this.state.copied ? 'Copied ✓' : 'Copy the key'}</button>
            <input maxLength={40} autoComplete="off" placeholder="your name in the game (optional)" value={this.state.name} onChange={(e) => this.setState({ name: e.target.value })} />
            <label className="ws-check"><input type="checkbox" checked={saved} onChange={(e) => this.setState({ saved: e.target.checked })} /> I saved my key</label>
            <div className="ws-why">{why}</div>
            <button type="button" className="primary" disabled={!saved || creating} onClick={() => this.createAccount()}>
              {creating ? <><span className="ws-spin" aria-hidden="true" />Creating your account…</> : 'Continue'}</button>
            <button type="button" className="link" onClick={() => this.setState({ fresh: null, pane: 'nostr', why: '' })}>Back</button>
          </div>) : null}
        <div id="ws-busy" className={`ws-note${wait ? ' on' : ''}`} style={busy ? undefined : { display: 'none' }}>
          {wait ? <><span className="ws-spin" aria-hidden="true" /><span className="ws-step">{busy}</span><span className="ws-secs">{secs ? `${secs} s` : ''}</span></> : busy}
        </div>
        <p className="ws-note" style={{ textAlign: 'center', margin: '8px 0 0' }}>Questions? <a href={QUESTIONS} target="_blank" rel="noopener" style={{ color: '#c9a8ff' }}>Join the community on Armada</a></p>
      </div>);
  }
}
