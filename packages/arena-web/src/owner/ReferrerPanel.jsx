// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE REFERRER SECTION (kanban #675, 2026-10-25: "there will be a section in the node called Referrer where he can select a name for his
// program. He can have multiple ones and each earns the fees ... The user must be able to withdraw his funds via lightning"): each program
// with its link, what it earned and holds, Withdraw over Lightning; a new program by its name. A program is a client of kind 'referrer'
// (GET /owner/dev); the page hands over `programs`, `site` (the Arena site's address), `create(name)`, `withdraw(args)`, `follow`, `reread`.
import React from 'react';

const sat = (msat) => `${(Number(BigInt(msat || 0) / 1000n)).toLocaleString('en-US')} sat`;
const field = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false };

export class ReferrerPanel extends React.Component {
  constructor(props) { super(props); this.state = { name: '', said: null, busy: false, wd: {}, to: {}, amount: {}, wsaid: {}, copied: null }; }
  async create() {
    const name = this.state.name.trim();
    if (!name) return;
    this.setState({ busy: true, said: null });
    try {
      const a = await this.props.create(name);
      this.setState({ busy: false, name: '', said: { ok: true, text: `"${a.name}" is ready. Its name reached ${a.told} node${a.told === 1 ? '' : 's'}.` } });
      setTimeout(() => this.props.reread(), 1500);
    } catch (e) { this.setState({ busy: false, said: { ok: false, text: e.message } }); }
  }
  async withdraw(slug) {
    const s = this.state, to = (s.to[slug] || '').trim(), amt = (s.amount[slug] || '').trim();
    this.setState({ wsaid: { ...s.wsaid, [slug]: null } });
    try {
      const args = { slug, ...(/^ln/i.test(to) ? { invoice: to } : { lnAddress: to }), ...(amt && !/^ln/i.test(to) ? { msat: String(BigInt(amt) * 1000n) } : {}) };
      const a = await this.props.withdraw(args);
      this.setState({ wsaid: { ...this.state.wsaid, [slug]: { ok: true, text: `Sent to the client. It pays within seconds (${a.id}).` } } });
      if (this.props.follow) this.props.follow(slug, a.id);
    } catch (e) { this.setState({ wsaid: { ...this.state.wsaid, [slug]: { ok: false, text: e.message } } }); }
  }
  copy(text, id) {
    try { navigator.clipboard.writeText(text); this.setState({ copied: id }); setTimeout(() => this.setState({ copied: null }), 1500); } catch { /* select it by hand */ }
  }
  program(P) {
    const s = this.state, site = (this.props.site || 'https://testnet.bitcoin-arena.io').replace(/\/+$/, '');
    const link = `${site}/?ref=${P.recipientPk}`, demo = `${site}/referral-demo/?ref=${P.recipientPk}`;
    const holds = (P.balances || []).reduce((t, b) => t + BigInt(b.msat || 0), 0n);
    const said = s.wsaid[P.slug];
    return (
      <div className="card ref-program" key={P.slug} id={'ref-' + P.slug}>
        <div className="ref-head"><h3>{P.label || P.slug}</h3><span className={P.running ? 'ok' : 'err'}>{P.running ? 'running' : 'stopped'}</span></div>
        <div className="ref-stats">
          <div><span>Earned</span><b>{sat(P.referral ? P.referral.msat : 0)}</b><small>{P.referral ? P.referral.payouts : 0} payout{P.referral && P.referral.payouts === 1 ? '' : 's'}</small></div>
          <div><span>Ready to withdraw</span><b>{sat(holds)}</b><small>withdrawn {sat(P.withdrawnMsat || 0)}</small></div>
        </div>
        <label>Your link</label>
        <div className="ref-link"><code>{link}</code><button type="button" onClick={() => this.copy(link, P.slug + ':l')}>{s.copied === P.slug + ':l' ? 'Copied ✓' : 'Copy'}</button></div>
        <label>Or host Rock Paper Scissors on your site</label>
        <div className="ref-link"><code>{`<iframe src="${site}/?game=rock-paper-scissors&ref=${P.recipientPk}" width="100%" height="720" allow="clipboard-write"></iframe>`}</code>
          <button type="button" onClick={() => this.copy(`<iframe src="${site}/?game=rock-paper-scissors&ref=${P.recipientPk}" width="100%" height="720" allow="clipboard-write"></iframe>`, P.slug + ':e')}>{s.copied === P.slug + ':e' ? 'Copied ✓' : 'Copy'}</button></div>
        <p className="sub">See it working: <a href={demo} target="_blank" rel="noopener noreferrer">the demo page</a>.</p>
        {s.wd[P.slug] ? (
          <div className="dh-withdraw">
            <label>A Lightning invoice (it names the amount) or a Lightning address</label>
            <input {...field} id={'rw-' + P.slug} placeholder="lntb… or name@domain" value={s.to[P.slug] || ''} onChange={(e) => this.setState({ to: { ...s.to, [P.slug]: e.target.value } })} />
            <label>Amount in sat, for an address (empty = all of it)</label>
            <input id={'ra-' + P.slug} inputMode="numeric" placeholder="all" value={s.amount[P.slug] || ''} onChange={(e) => this.setState({ amount: { ...s.amount, [P.slug]: e.target.value } })} />
            <button type="button" className="primary" onClick={() => this.withdraw(P.slug)}>Send</button>
            <button type="button" onClick={() => this.setState({ wd: { ...s.wd, [P.slug]: false } })}>Cancel</button>
            <div className="err">{said ? (said.ok ? <span className="ok">{said.text}</span> : said.text) : ''}</div>
          </div>) : <button type="button" className={holds > 0n ? 'primary' : undefined} onClick={() => this.setState({ wd: { ...s.wd, [P.slug]: true } })}>Withdraw</button>}
      </div>);
  }
  render() {
    const { programs = [], why = null } = this.props, s = this.state;
    return (
      <div id="referrer-panel">
        <p className="sub">Put a link to Bitcoin Arena on your site, or host a game there. Every game played through it pays your program 10% of the nodes' fee. Players pay nothing extra.</p>
        {why ? <p className="err">{why}</p> : null}
        {programs.map((P) => this.program(P))}
        <div className="card">
          <h3>{programs.length ? 'Another program' : 'Your first program'}</h3>
          <label>Its name (shown in the explorer and on Health)</label>
          <input {...field} id="ref-name" maxLength={48} placeholder="My Bitcoin blog" value={s.name} onChange={(e) => this.setState({ name: e.target.value })} />
          <button type="button" className="primary" id="ref-create" disabled={s.busy || !s.name.trim()} onClick={() => this.create()}>{s.busy ? 'Creating …' : 'Create program'}</button>
          <div className="err" id="ref-said">{s.said ? (s.said.ok ? <span className="ok">{s.said.text}</span> : s.said.text) : ''}</div>
        </div>
      </div>);
  }
}
