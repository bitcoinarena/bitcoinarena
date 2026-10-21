// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER PAGE'S DONATIONS IN REACT (kanban #564): what owner.html's donations() and devClients() drew by hand.
// WAITING TO BE COLLECTED: what this seat verified for the protocol developers and for each game it hosts, in sat to the msat, per
// recipient, per UTC day and per round (GET /owner/donations, from the seat's own donation index) - a recipient without a key named by its
// Lightning address. THE DEV CLIENTS: a donation recipient's key and its wallets, run by this node - its earnings by part and period, what it
// holds per federation, Withdraw over Lightning (an invoice, or a Lightning address with an amount), Remove; and setting one up with a new
// key or a dev key the owner already has. The page reads the doors and hands over `read()` and the signed requests.
import React from 'react';

/** msat as sat, exact to the msat */
export const sat = (msat) => { const m = BigInt(msat); const w = (m / 1000n).toLocaleString('en-US'); const f = m % 1000n; return (f ? `${w}.${String(f).padStart(3, '0').replace(/0+$/, '')}` : w) + ' sat'; };
const pct = (bps) => (Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' %';
const Row = ({ k, v, sub }) => <div className={'row' + (sub ? ' sub' : '')}><span>{k}</span><b>{v}</b></div>;
const field = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false };

export class WaitingDonations extends React.Component {
  render() {
    const { donations: r, why } = this.props;
    if (why) return <div className="card"><p className="err">{why}</p></div>;
    if (!r.sets || !r.sets.length) return <div className="card"><p>This node collects no donations yet.</p></div>;
    return (
      <>
        <div className="card"><p className="sub">Donations this node checked that the developers' clients have not collected yet: a client deletes them here once it has them. What each dev received is under Dev clients.</p>
          <Row k="Waiting at this seat" v={sat(r.totalMsat)} /></div>
        {r.sets.map((s) => (
          <div className="card" key={s.setId}>
            <h3>{s.title}</h3><Row k={`${s.kind === 'protocol' ? 'Protocol set, serial ' + s.serial : 'Game developer set'} · per day (UTC)`} v={s.setId.slice(0, 16) + '…'} />
            {s.recipients.map((x, i) => (
              <React.Fragment key={i}>
                <Row k={`${x.label || 'recipient'} · ${x.key ? x.key.slice(0, 12) + '…' : x.lnurl || 'a Lightning address'}`} v={`${sat(x.totalMsat)} · ${x.donations} donation${x.donations === 1 ? '' : 's'}`} />
                {x.byDay.slice(0, 7).map((d) => <Row key={d.day} sub k={d.day} v={sat(d.msat)} />)}
                {x.byRound.length ? <details><summary className="sub">{x.byRound.length} round{x.byRound.length === 1 ? '' : 's'}</summary>
                  {x.byRound.slice(0, 50).map((d) => <Row key={d.roundId} sub k={`round ${d.roundId.slice(0, 16)}…`} v={sat(d.msat)} />)}</details> : null}
              </React.Fragment>))}
          </div>))}
      </>);
  }
}

/** WHAT A KEY EARNED, BY PERIOD, AND ITS SHARES: the protocol developers' part and each game's, today .. all time (UTC). */
function Earnings({ split: S }) {
  if (!S || !S.earnings) return null;
  const P = S.earnings.periods; const cols = [['day', 'Today'], ['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']];
  const names = new Map(); for (const k of Object.keys(P)) for (const g of P[k].games) names.set(g.game, g.title || g.game);
  const gameMsat = (k, name) => ((P[k].games.find((g) => g.game === name) || {}).msat || '0');
  const tr = (label, f, key) => <tr key={key}><th>{label}</th>{cols.map(([k]) => <td key={k}>{sat(f(k))}</td>)}</tr>;
  return (
    <>
      <h4>Earnings</h4>
      <div className="tablewrap"><table className="earn"><thead><tr><th />{cols.map(([k, t]) => <th key={k}>{t}</th>)}</tr></thead><tbody>
        {tr('Protocol', (k) => P[k].protocolMsat, 'protocol')}
        {[...names].map(([name, title]) => tr(title, (k) => gameMsat(k, name), name))}
        {P.all.unknownMsat !== '0' ? tr('Rounds this node no longer holds', (k) => P[k].unknownMsat, 'unknown') : null}
        {tr(<b>Total</b>, (k) => P[k].totalMsat, 'total')}</tbody></table></div>
      {S.shares ? <><Row k="Your share of the protocol developers' half" v={pct(S.shares.protocolBps)} />
        {S.shares.games.map((g) => <Row key={g.title} k={`Your share of ${g.title}'s developers' half`} v={pct(g.bps)} />)}</> : null}
    </>);
}

export class DevClients extends React.Component {
  constructor(props) { super(props); this.state = { label: '', secret: '', setupSaid: null, to: {}, amount: {}, said: {}, removeWhy: '' }; }
  async setup() {
    this.setState({ setupSaid: null });
    try {
      const args = { label: this.state.label.trim() };
      if (this.state.secret.trim()) args.secretHex = this.state.secret.trim();
      const a = await this.props.setup(args);
      this.setState({ secret: '', setupSaid: { ok: true, text: `Set up ✓ ${a.slug} · key ${a.recipientPk.slice(0, 16)}…` } });
      setTimeout(() => this.props.reread(), 1500);
    } catch (e) { this.setState({ setupSaid: { ok: false, text: e.message } }); }
  }
  async withdraw(slug) {
    const to = (this.state.to[slug] || '').trim(), amt = (this.state.amount[slug] || '').trim();
    this.setState({ said: { ...this.state.said, [slug]: null } });
    try {
      const args = { slug, ...(/^ln/i.test(to) ? { invoice: to } : { lnAddress: to }), ...(amt && !/^ln/i.test(to) ? { msat: String(BigInt(amt) * 1000n) } : {}) };
      const a = await this.props.withdraw(args);
      this.setState({ said: { ...this.state.said, [slug]: { ok: true, text: `Asked ✓ the client pays it within seconds (${a.id})` } } });
      this.props.follow(slug, a.id);
    } catch (e) { this.setState({ said: { ...this.state.said, [slug]: { ok: false, text: e.message } } }); }
  }
  async remove(slug) {
    try { await this.props.remove(slug); this.props.reread(); } catch (e) { this.setState({ removeWhy: e.message }); }
  }
  card(V, managed) {
    if (V.error) return <div className="card" key={V.slug || 'beside'}><h3>{V.label || V.slug || 'Dev client'}</h3><p className="err">{V.error}</p></div>;
    const holds = (V.balances || []).reduce((t, b) => t + BigInt(b.msat || 0), 0n);
    const last = (V.requests || [])[0];
    const S = V.split, s = this.state, said = s.said[V.slug];
    return (
      <div className="card" key={V.slug || 'beside'}>
        <h3>{V.label || V.slug}{managed ? (V.running ? <span className="ok"> · running</span> : <span className="err"> · stopped</span>) : ' · beside this node'}</h3>
        <Row k="Recipient key" v={<span title={V.recipientPk}>{V.recipientPk.slice(0, 16)}…</span>} />
        <Row k="Received" v={`${sat(V.receivedMsat)} · ${V.donations} donation${V.donations === 1 ? '' : 's'}`} />
        {S ? <><Row k="For the protocol developers" v={sat(S.protocolMsat)} />
          {(S.games || []).map((g) => <Row key={g.game} k={'For ' + (g.title || g.game)} v={`${sat(g.msat)} · ${g.donations} donation${g.donations === 1 ? '' : 's'}`} />)}
          {S.unknownMsat && S.unknownMsat !== '0' ? <Row k="Rounds this node no longer holds" v={sat(S.unknownMsat)} /> : null}</> : null}
        <Earnings split={S} />
        {(V.balances || []).map((b) => <Row key={b.federation} k={'Holds in ' + b.federation.slice(0, 12)} v={sat(b.msat)} />)}
        <Row k="Withdrawn over Lightning" v={sat(V.withdrawnMsat)} />
        <Row k="Last pass" v={V.lastPass ? `${String(V.lastPass.at).slice(0, 16).replace('T', ' ')} · asked ${V.lastPass.seats} nodes` : 'not yet'} />
        {last ? <Row k="Last withdrawal you asked for" v={`${last.state || '?'}${last.msat ? ' · ' + sat(last.msat) : ''}${last.why ? ' · ' + last.why : ''}`} /> : null}
        {managed ? <>
          <details open={holds > 0n}><summary>Withdraw over Lightning</summary>
            <label>A Lightning invoice (it names the amount) or a Lightning address</label>
            <input {...field} id={'wd-' + V.slug} placeholder="lntb… or name@domain" value={s.to[V.slug] || ''} onChange={(e) => this.setState({ to: { ...s.to, [V.slug]: e.target.value } })} />
            <label>Amount in sat, for an address (empty = everything it can send)</label>
            <input id={'wa-' + V.slug} inputMode="numeric" placeholder="all" value={s.amount[V.slug] || ''} onChange={(e) => this.setState({ amount: { ...s.amount, [V.slug]: e.target.value } })} />
            <button type="button" className="primary" onClick={() => this.withdraw(V.slug)}>Withdraw</button>
            <div className="err" id={'we-' + V.slug}>{said ? (said.ok ? <span className="ok">{said.text}</span> : said.text) : ''}</div></details>
          <details><summary className="sub">Remove this client</summary><p>The client stops; its directory and key stay on the node.</p>
            <button type="button" onClick={() => this.remove(V.slug)}>Remove</button>{s.removeWhy ? <p className="err">{s.removeWhy}</p> : null}</details></> : null}
      </div>);
  }
  render() {
    const { dev: r, why } = this.props, s = this.state;
    if (why) return <div className="card"><p className="err">{why}</p></div>;
    return (
      <>
        {r.beside ? this.card(r.beside, false) : null}
        {(r.clients || []).map((c) => this.card(c, true))}
        {r.managed ? <div className="card"><h3>Set up a dev client</h3>
          <p>A dev client collects what the protocol and the games donate to one recipient key, keeps it in a wallet per federation, and pays it out
            over Lightning when you ask. Use a <b>new key</b> (put its public key in your game's donation set), or a <b>dev key you already have</b>:
            its wallets are recovered from the federation. Only one client may run per key.</p>
          <label>Label</label><input id="dlabel" autoComplete="off" placeholder="dev a" value={s.label} onChange={(e) => this.setState({ label: e.target.value })} />
          <label>Your dev key's secret (64 hex), or empty for a new key</label>
          <input {...field} id="dsecret" type="password" placeholder="empty = a new key" value={s.secret} onChange={(e) => this.setState({ secret: e.target.value })} />
          <p className="sub">The secret travels in your signed request: only do this over https or on the node's own machine.</p>
          <button type="button" className="primary" id="dsetup" onClick={() => this.setup()}>Set up</button>
          <div className="err" id="derr">{s.setupSaid ? (s.setupSaid.ok ? <span className="ok">{s.setupSaid.text}</span> : s.setupSaid.text) : ''}</div></div>
          : <div className="card"><p>This node runs no dev clients of its own: its operator starts it with ARENA_DEV_WASM_PKG to set them up here.</p></div>}
      </>);
  }
}
