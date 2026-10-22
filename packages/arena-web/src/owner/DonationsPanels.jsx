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
const count = (n, word) => `${Number(n).toLocaleString('en-US')} ${word}${Number(n) === 1 ? '' : 's'}`;
/** A CURRENCY AMOUNT (kanban #578): 2 decimals from 1 up, else up to 4 - a testnet donation is a fraction of a cent */
const SYM = { eur: '€', usd: '$', chf: 'CHF ', gbp: '£' };
export const money = (x, cur) => { const v = Number(x) || 0; const d = v >= 1 || v === 0 ? 2 : 4;
  return `${SYM[cur] || ''}${v.toLocaleString('en-US', { minimumFractionDigits: d === 2 ? 2 : 0, maximumFractionDigits: d })}`; };
export const CURS = ['sat', 'eur', 'usd', 'chf', 'gbp'];
const curKept = () => { try { const c = localStorage.getItem('arena-owner-currency'); return CURS.includes(c) ? c : 'sat'; } catch { return 'sat'; } };
/** msat as WHOLE sat, for the glance (\"369.572 sat\" read as thousands); the exact msat stay in the details */
export const whole = (msat) => `${(BigInt(msat || 0) / 1000n).toLocaleString('en-US')} sat`;
const Row = ({ k, v, sub }) => <div className={'row' + (sub ? ' sub' : '')}><span>{k}</span><b>{v}</b></div>;
const field = { autoComplete: 'off', autoCapitalize: 'none', spellCheck: false };

export class WaitingDonations extends React.Component {
  // AT ONE PEEK (the owner 2026-10-22: "lots of entries with 0 ... make it more modern and easy to see at one peek"): one line - what waits at
  // this seat for the dev clients to collect - and the sets only where something waits, folded; a set or recipient at 0 is not drawn
  render() {
    const { donations: r, why } = this.props;
    if (why) return <div className="card"><p className="err">{why}</p></div>;
    const sets = (r.sets || []).map((s) => ({ ...s, recipients: s.recipients.filter((x) => BigInt(x.totalMsat || 0) > 0n) })).filter((s) => s.recipients.length);
    const total = BigInt(r.totalMsat || 0);
    return (
      <div className="card">
        <div className="row"><span>Waiting at this seat for the dev clients</span><b>{total > 0n ? sat(r.totalMsat) : <span className="ok">nothing · all collected</span>}</b></div>
        {sets.length ? <details><summary className="sub">By set and day</summary>
          {sets.map((s) => (
            <div key={s.setId}><h4>{s.title} · {s.kind === 'protocol' ? 'protocol set ' + s.serial : 'game set'}</h4>
              {s.recipients.map((x, k) => (
                <React.Fragment key={k}>
                  <Row k={`${x.label || 'recipient'} · ${x.donations} donation${x.donations === 1 ? '' : 's'}`} v={sat(x.totalMsat)} />
                  {x.byDay.filter((d) => BigInt(d.msat || 0) > 0n).slice(0, 7).map((d) => <Row key={d.day} sub k={d.day} v={sat(d.msat)} />)}
                </React.Fragment>))}
            </div>))}</details> : null}
      </div>);
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
  constructor(props) { super(props); this.state = { label: '', secret: '', setupSaid: null, to: {}, amount: {}, said: {}, removeWhy: '', cur: curKept() }; }
  pickCur(c) { this.setState({ cur: c }); try { localStorage.setItem('arena-owner-currency', c); } catch { /* this visit only */ } }
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
  // WITHDRAW, RIGHT IN THE CARD (the owner 2026-10-22: the card's button did nothing visible - it opened a folded panel far below)
  withdrawForm(V) {
    const s = this.state, said = s.said[V.slug];
    return (
      <div className="dh-withdraw">
        <label>A Lightning invoice (it names the amount) or a Lightning address</label>
        <input {...field} id={'wd-' + V.slug} placeholder="lntb… or name@domain" value={s.to[V.slug] || ''} onChange={(e) => this.setState({ to: { ...s.to, [V.slug]: e.target.value } })} />
        <label>Amount in sat, for an address (empty = everything it can send)</label>
        <input id={'wa-' + V.slug} inputMode="numeric" placeholder="all" value={s.amount[V.slug] || ''} onChange={(e) => this.setState({ amount: { ...s.amount, [V.slug]: e.target.value } })} />
        <button type="button" className="primary" onClick={() => this.withdraw(V.slug)}>Send</button>
        <button type="button" onClick={() => this.setState({ wd: { ...(s.wd || {}), [V.slug]: false } })}>Cancel</button>
        <div className="err" id={'we-' + V.slug}>{said ? (said.ok ? <span className="ok">{said.text}</span> : said.text) : ''}</div>
      </div>);
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
        {S ? (S.games || []).filter((g) => (g.itemsBy || []).length).map((g) => <React.Fragment key={g.game}><h4>Items · {g.title || g.game}</h4>
          {g.itemsBy.map((i) => <Row key={i.item} sub k={i.item} v={`${sat(i.msat)} · ${count(i.donations, 'time')}`} />)}</React.Fragment>) : null}
        <Earnings split={S ? { ...S, shares: null } : S} />
        {(V.balances || []).filter((b) => BigInt(b.msat || 0) > 0n).map((b) => <Row key={b.federation} k={'Holds in ' + b.federation.slice(0, 12)} v={sat(b.msat)} />)}
        <Row k="Withdrawn over Lightning" v={sat(V.withdrawnMsat)} />
        <Row k="Last pass" v={V.lastPass ? `${String(V.lastPass.at).slice(0, 16).replace('T', ' ')} · asked ${V.lastPass.seats} nodes` : 'not yet'} />
        {last ? <Row k="Last withdrawal you asked for" v={`${last.state || '?'}${last.msat ? ' · ' + sat(last.msat) : ''}${last.why ? ' · ' + last.why : ''}`} /> : null}
        {managed ? <>
          <details><summary className="sub">Remove this client</summary><p>The client stops; its directory and key stay on the node.</p>
            <button type="button" onClick={() => this.remove(V.slug)}>Remove</button>{s.removeWhy ? <p className="err">{s.removeWhy}</p> : null}</details></> : null}
      </div>);
  }
  // AT ONE PEEK (the owner 2026-10-22: "modern and pretty looking, and visible at a glance"): one wide card per client - what it can
  // withdraw now in whole sats, Withdraw beside it, four stat chips, and the split as one bar (protocol, each game, items) with counts
  render() {
    const { dev: r, why } = this.props, s = this.state;
    if (why) return <div className="card"><p className="err">{why}</p></div>;
    const all = [...(r.beside ? [{ ...r.beside, managed: false }] : []), ...(r.clients || []).map((c) => ({ ...c, managed: true }))].filter((c) => !c.error);
    const period = (V, k) => (V.split && V.split.earnings && V.split.earnings.periods[k] ? V.split.earnings.periods[k].totalMsat : '0');
    const holds = (V) => (V.balances || []).reduce((t, b) => t + BigInt(b.msat || 0), 0n);
    const ago = (ms) => { if (!ms) return ''; const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
    const recent = all.flatMap((V) => (V.recent || []).map((d) => ({ ...d, who: V.label || V.slug }))).sort((a, b) => b.atMs - a.atMs).slice(0, 10);
    const COLORS = ['var(--st)', 'var(--gv)', 'var(--ok)', '#a77bf3', '#e57ab0', '#4fd1c5'];
    // THE SHARE AT THE TOP (the owner 2026-10-22: "Display the current share of this dev client in % at the top"): one number when the
    // protocol set and every game set give it the same share, else each
    const shareOf = (V) => { const sh = V.split && V.split.shares; if (!sh) return null;
      const all = [{ t: 'protocol', bps: sh.protocolBps }, ...(sh.games || []).map((g) => ({ t: g.title, bps: g.bps }))];
      // every set by name, always (the owner 2026-10-22: "what is this 33%, is it just the protocol?" - one number for all hid that)
      return <div className="dh-share"><span className="sub">Your share</span>{all.map((x) => <span key={x.t} className={Number(x.bps) >= 10000 ? 'own' : undefined}><b>{pct(x.bps)}</b> {x.t === 'protocol' ? 'Protocol' : x.t}</span>)}</div>; };
    const parts = (V) => {
      const S = V.split; if (!S) return [];
      const out = [{ label: 'Protocol', msat: BigInt(S.protocolMsat || 0), note: S.protocolDonations !== undefined ? count(S.protocolDonations, 'donation') : '' }];
      for (const g of S.games || []) out.push({ label: g.title || g.game, msat: BigInt(g.msat || 0),
        note: [count(g.donations, 'donation'), g.rounds ? count(g.rounds, g.market ? 'market round' : 'round') : null, g.items ? count(g.items, 'item') : null].filter(Boolean).join(' · ') });
      if (S.unknownMsat && S.unknownMsat !== '0') out.push({ label: 'Older rounds', msat: BigInt(S.unknownMsat), note: 'rounds this node no longer holds' });
      return out.filter((p) => p.msat > 0n).map((p, i) => ({ ...p, color: COLORS[i % COLORS.length] }));
    };
    // THE CURRENCY (kanban #578, the owner: "a filter where the sats can be changed to your favorite currency"): sat, or each donation at its
    // own historic rate (the node's fiat-rates.js), what is held at the price now; the choice kept in this browser
    const cur = s.cur || 'sat';
    const inCur = (V, msatOrSum, kind) => {
      if (cur === 'sat' || !V.fiat) return null;
      if (kind === 'now') return V.fiat.now ? money((Number(msatOrSum) / 1e11) * V.fiat.now[cur], cur) : null;
      return money(msatOrSum, cur);
    };
    return (
      <>
        <div className="cur-pick"><span>Show amounts in</span>{CURS.map((c) => <button type="button" key={c} className={c === cur ? 'on' : undefined} onClick={() => this.pickCur(c)}>{c === 'sat' ? 'sat' : c.toUpperCase()}</button>)}</div>
        {all.map((V) => {
          const P = parts(V), total = P.reduce((t, p) => t + p.msat, 0n), newest = (V.recent || [])[0];
          const T = V.fiat && V.fiat.totals;
          const chip = (k, msat) => (cur !== 'sat' && T && T[k] ? <><b>{money(T[k][cur], cur)}</b><small>{whole(msat)}</small></> : <b>{whole(msat)}</b>);
          // a part of the split in the currency: its share of all the client's donations at their rates (≈, the parts are not rated one by one)
          const partCur = (msat) => (cur !== 'sat' && T && total > 0n ? '≈ ' + money((Number(msat) / Number(total)) * T.all[cur], cur) : null);
          return (
            <div className="devhero" key={V.slug || 'beside'}>
              <div className="dh-top">
                <div className="dh-who"><b>{V.label || V.slug}</b> {V.managed ? <span className={'pill ' + (V.running ? 'on' : 'bad')}>{V.running ? 'running' : 'stopped'}</span> : <span className="pill">beside this node</span>}
                  {shareOf(V)}
                  <small>{newest ? `newest donation ${ago(newest.atMs)}` : 'no donation yet'}</small></div>
                <div className="dh-cash"><span>Ready to withdraw</span><b>{inCur(V, holds(V), 'now') || whole(holds(V))}</b>{inCur(V, holds(V), 'now') ? <small>{whole(holds(V))} at today's price</small> : null}
                  {V.managed ? <button type="button" className={holds(V) > 0n ? 'primary' : undefined} onClick={() => this.setState({ wd: { ...(s.wd || {}), [V.slug]: !(s.wd || {})[V.slug] } })}>Withdraw</button> : null}</div>
              </div>
              {V.managed && (s.wd || {})[V.slug] ? this.withdrawForm(V) : null}
              <div className="dh-chips">
                <div><span>Today</span>{chip('day', period(V, 'day'))}</div>
                <div><span>This week</span>{chip('week', period(V, 'week'))}</div>
                <div><span>All time</span>{chip('all', V.receivedMsat)}</div>
                <div><span>Donations</span><b>{Number(V.donations).toLocaleString('en-US')}</b></div>
              </div>
              {total > 0n ? <>
                {/* HOVER, A REAL READOUT (the owner 2026-10-22: "Hover is not working" - a title tooltip on a 10 px bar barely shows) */}
                <div className="dh-bar" onMouseLeave={() => this.setState({ hov: { ...(s.hov || {}), [V.slug]: null } })}>{P.map((p, i) => <i key={p.label}
                  className={(s.hov || {})[V.slug] === i ? 'on' : undefined} onMouseEnter={() => this.setState({ hov: { ...(s.hov || {}), [V.slug]: i } })}
                  style={{ width: `${Number((p.msat * 10000n) / total) / 100}%`, background: p.color }} />)}</div>
                <div className="dh-tip">{(() => { const i = (s.hov || {})[V.slug]; const p = i === null || i === undefined ? null : P[i];
                  return p ? <><i style={{ background: p.color }} /><b>{p.label}</b> · {whole(p.msat)} · {(Number((p.msat * 10000n) / total) / 100).toLocaleString('en-US')} % of all{p.note ? ' · ' + p.note : ''}</> : <span className="sub">Point at the bar to see each part</span>; })()}</div>
                <div className="dh-legend">{P.map((p, i) => <div key={p.label} className={(s.hov || {})[V.slug] === i ? 'on' : undefined}
                  onMouseEnter={() => this.setState({ hov: { ...(s.hov || {}), [V.slug]: i } })} onMouseLeave={() => this.setState({ hov: { ...(s.hov || {}), [V.slug]: null } })}>
                  <i style={{ background: p.color }} /><span>{p.label}</span><b>{partCur(p.msat) || whole(p.msat)}</b><small>{[partCur(p.msat) ? whole(p.msat) : null, p.note].filter(Boolean).join(' · ')}</small></div>)}</div></> : null}
            </div>);
        })}
        {recent.length ? <div className="card"><h3>Newest donations</h3>
          <div className="scroll"><table className="tbl"><thead><tr><th>When (UTC)</th><th>To</th><th className="n">Amount</th>{cur !== 'sat' ? <th className="n">{cur.toUpperCase()} then</th> : null}<th>Round or item</th><th>Player</th></tr></thead><tbody>
            {recent.map((d, i) => <tr key={i}><td>{d.atMs ? new Date(d.atMs).toISOString().slice(5, 16).replace('T', ' ') : '?'}</td><td>{d.who}</td><td className="n">{Number(d.amountMsat).toLocaleString('en-US')} msat</td>{cur !== 'sat' ? <td className="n">{(() => { const V = all.find((x) => (x.label || x.slug) === d.who); const v = V && V.fiat && V.fiat.recent && V.fiat.recent[d.outpoint]; return v && v[cur] !== undefined ? money(v[cur], cur) : '–'; })()}</td> : null}
              <td title={d.item || d.round}>{d.item ? d.item : d.round.slice(0, 10) + '…'}</td><td title={d.player || ''}>{d.player ? d.player.slice(0, 10) + '…' : '–'}</td></tr>)}
          </tbody></table></div><p className="sub">Each donation's full record (player key, round, entry, contract, rate) is kept by its client.{cur !== 'sat' ? ` ${cur.toUpperCase()} at each donation's own rate (CoinGecko).` : ''}</p></div> : null}
        {all.map((V) => <details key={'d-' + (V.slug || 'beside')} open={!!(s.open || {})[V.slug]}><summary>{V.label || V.slug}: details{V.managed ? ', remove' : ''}</summary>{this.card(V, V.managed)}</details>)}
        {r.managed ? <details><summary className="sub">Add a dev client</summary><div className="card">
          <p>A dev client collects what the protocol and the games donate to one recipient key, keeps it in a wallet per federation, and pays it out
            over Lightning when you ask. Use a <b>new key</b> (put its public key in your game's donation set), or a <b>dev key you already have</b>:
            its wallets are recovered from the federation. Only one client may run per key.</p>
          <label>Label</label><input id="dlabel" autoComplete="off" placeholder="dev a" value={s.label} onChange={(e) => this.setState({ label: e.target.value })} />
          <label>Your dev key's secret (64 hex), or empty for a new key</label>
          <input {...field} id="dsecret" type="password" placeholder="empty = a new key" value={s.secret} onChange={(e) => this.setState({ secret: e.target.value })} />
          <p className="sub">The secret travels in your signed request: only do this over https or on the node's own machine.</p>
          <button type="button" className="primary" id="dsetup" onClick={() => this.setup()}>Set up</button>
          <div className="err" id="derr">{s.setupSaid ? (s.setupSaid.ok ? <span className="ok">{s.setupSaid.text}</span> : s.setupSaid.text) : ''}</div></div></details>
          : (all.length ? null : <div className="card"><p>This node runs no dev clients of its own: its operator starts it with ARENA_DEV_WASM_PKG to set them up here.</p></div>)}
      </>);
  }
}
