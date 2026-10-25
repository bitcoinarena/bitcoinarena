// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PROPOSALS FORUM'S VIEWS IN REACT (kanban #564, src/arena-ui/proposals): the thread list, one thread and the three new-proposal
// forms - the only drawing of the forum (2026-10-21: "no fall backs"). The forum's own script (forum.js) reads the nodes, keeps
// the player's in-game key and signs and posts; it hands these class components plain view data - names, stages, amounts, and a
// proposal's text as the HTML its own Markdown made (escaped there) - and gets the reply or the form back.
import React from 'react';

const n = (x) => Number(x).toLocaleString('en-US');
const Stage = ({ s }) => <span className={`stage ${s.cls}`}>{s.text}</span>;
const Avatar = ({ a, title }) => <div className="ava" style={{ background: a.colour }} title={title}>{a.initial}</div>;

/** Who signs here: { name, npub } of the in-game key, or no name - then how to post. */
export function SignedIn({ name, npub }) {
  if (!name) return 'Read freely. To post, open the Arena once: the forum signs with the key and the name you play with.';
  return <>Signed in as <b title={npub}>{name}</b> · your in-game key and name</>;
}

/** The reserves on top: { reserves: { sats, agreeing, asked } | null, why, capPct } - what the nodes agree on and the most one PIP may ask. */
// OPEN AND CLOSED AS AN ACCORDION (kanban #589, the owner 2026-10-23: "es muss auch wieder einklappen - mach ein klar sichtbares
// Accordion mit offen und closed button"): `open` while the details show; the one button opens them, or closes them again
export const ReservesToggle = ({ open }) => (
  <a className="btn rs-toggle" href={open ? '#' : '#reserves'} aria-expanded={open ? 'true' : 'false'}>{open ? '▴ Close details' : '▾ Open details'}</a>);
export function ReserveBalance({ reserves, why, capPct, open = false }) {
  return (
    <><a className="lbl balance-link" href={open ? '#' : '#reserves'} title="Every payment into the reserves">Protocol reserves</a><b className="sats">{reserves ? `${n(reserves.sats)} sat` : '–'}</b>
      <span className="sub">{reserves ? `${reserves.agreeing} of ${reserves.asked} nodes agree · a PIP may ask up to ${n(Math.floor(reserves.sats * capPct / 100))} sat`
        : why ? `could not be read: ${why}` : 'reading the nodes'}</span><ReservesToggle open={open} /></>);
}

// THE RESERVES IN DETAIL (kanban #589, the owner 2026-10-23: "in clicking on protocol reserves a page appears that shows details, again
// with filters like on the owners page. with paging, filters to group by app, items, market/games and showing all necessary details like
// amount, user, date"): every payment into the reserves as a seat lists it (GET /reserves?all=1) - its date, amount, app, kind (a market,
// a game, an item), round, entry and federation - filtered by kind, app and federation, grouped with each group's count and sum, 25 a
// page; under it every payout the reserves made to a proposal.
const msatSat = (m) => { const v = Number(m) / 1000; return v.toLocaleString('en-US', { maximumFractionDigits: 3 }); };
const short = (h) => (h ? String(h).slice(0, 8) : '–');
export class ReservesView extends React.Component {
  constructor(props) { super(props); this.state = { kind: 'all', app: 'all', fed: 'all', group: 'none', page: 0 }; }
  set(k, v) { this.setState({ [k]: v, page: 0 }); }
  render() {
    const { rows, payouts, status, error } = this.props;
    const s = this.state, PAGE = 15;   // 15 a table (the owner 2026-10-23: "nur 15 Einträge pro Table")
    // UNDER THE BOX THAT OPENS AND CLOSES IT (kanban #589, the owner: "unten kein Close Details"): no button of its own
    if (error) return <div className="empty">The reserves could not be read: {error}</div>;
    if (!rows) return <div className="empty">Reading the nodes…</div>;
    const apps = [...new Set(rows.map((r) => r.app))].sort(), feds = [...new Set(rows.map((r) => r.federation))].sort();
    const shown = rows.filter((r) => (s.kind === 'all' || r.kind === s.kind) && (s.app === 'all' || r.app === s.app) && (s.fed === 'all' || r.federation === s.fed));
    const sum = shown.reduce((t, r) => t + Number(r.amountMsat), 0);
    const groups = s.group === 'none' ? null : [...shown.reduce((m, r) => { const k = s.group === 'kind' ? r.kind : s.group === 'app' ? r.app : short(r.federation);
      const g = m.get(k) || { key: k, count: 0, msat: 0 }; g.count++; g.msat += Number(r.amountMsat); m.set(k, g); return m; }, new Map()).values()].sort((a, b) => b.msat - a.msat);
    const pages = Math.max(1, Math.ceil(shown.length / PAGE)), page = Math.min(s.page, pages - 1);
    const payPages = Math.max(1, Math.ceil((payouts || []).length / PAGE)), payPage = Math.min(s.payPage || 0, payPages - 1);
    const sel = (k, opts) => <select id={`rs-${k}`} value={s[k]} onChange={(e) => this.set(k, e.target.value)}>{opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select>;
    return (
      <div>
        <p className="lead">Every payment into the reserves: 2 % of each round and 20 % of each item, as the nodes record them. {status || ''}</p>
        <div className="rs-filters">
          <label>Kind {sel('kind', [['all', 'All'], ['market', 'Markets'], ['game', 'Games'], ['item', 'Items']])}</label>
          <label>App {sel('app', [['all', 'All apps'], ...apps.map((a) => [a, a])])}</label>
          <label>Federation {sel('fed', [['all', 'All'], ...feds.map((f) => [f, short(f)])])}</label>
          <label>Group by {sel('group', [['none', 'Nothing'], ['app', 'App'], ['kind', 'Kind'], ['federation', 'Federation']])}</label>
        </div>
        <p className="rs-sum" id="rs-sum"><b>{msatSat(sum)} sat</b> in {n(shown.length)} payment{shown.length === 1 ? '' : 's'}{shown.length !== rows.length ? ` (of ${n(rows.length)})` : ''}</p>
        {groups ? <div className="tbl rs"><table id="rs-groups"><thead><tr><th>{s.group === 'app' ? 'App' : s.group === 'kind' ? 'Kind' : 'Federation'}</th><th className="al-right">Payments</th><th className="al-right">Sats</th></tr></thead>
          <tbody>{groups.map((g) => <tr key={g.key}><td>{g.key}</td><td className="al-right">{n(g.count)}</td><td className="al-right">{msatSat(g.msat)}</td></tr>)}</tbody></table></div> : null}
        <div className="tbl rs"><table id="rs-rows"><thead><tr><th>Date (UTC)</th><th className="al-right">Sats</th><th>App</th><th>Kind</th><th>Round</th><th>Entry</th><th>Federation</th></tr></thead>
          <tbody>{shown.slice(page * PAGE, page * PAGE + PAGE).map((r) => (
            <tr key={r.outpoint}><td>{r.at.slice(0, 16).replace('T', ' ')}</td><td className="al-right">{msatSat(r.amountMsat)}</td><td>{r.app}</td><td>{r.kind}</td>
              <td title={r.roundId}>{short(r.roundId)}</td><td title={r.entryId || ''}>{r.entryId ? short(r.entryId) : r.kind === 'market' ? 'market pool' : '–'}</td><td title={r.federation}>{short(r.federation)}</td></tr>))}</tbody></table></div>
        <div className="bar rs-pager"><button type="button" className="btn" disabled={page === 0} onClick={() => this.setState({ page: page - 1 })}>← Newer</button>
          <span className="say" id="rs-page">Page {page + 1} of {pages}</span>
          <button type="button" className="btn" disabled={page >= pages - 1} onClick={() => this.setState({ page: page + 1 })}>Older →</button></div>
        <h3>Paid out to proposals</h3>
        {payouts && payouts.length ? <div className="tbl rs"><table id="rs-payouts"><thead><tr><th>Proposal</th><th className="al-right">Sats</th><th>To</th><th>State</th><th>Federation</th></tr></thead>
          <tbody>{payouts.slice(payPage * PAGE, payPage * PAGE + PAGE).map((p) => <tr key={p.proposal + (p.txid || '')}><td title={p.proposal}>{short(p.proposal)}</td><td className="al-right">{p.amountSats ? n(Number(p.amountSats)) : '–'}</td>
            <td>{String(p.lnurl || '–').slice(0, 40)}</td><td>{p.state}</td><td title={p.federation}>{short(p.federation)}</td></tr>)}</tbody></table></div>
          : <div className="empty">No payout yet.</div>}
        {payPages > 1 ? <div className="bar rs-pager"><button type="button" className="btn" disabled={payPage === 0} onClick={() => this.setState({ payPage: payPage - 1 })}>← Newer</button>
          <span className="say" id="rs-pay-page">Page {payPage + 1} of {payPages}</span>
          <button type="button" className="btn" disabled={payPage >= payPages - 1} onClick={() => this.setState({ payPage: payPage + 1 })}>Older →</button></div> : null}
      </div>);
  }
}

/** One line in place of a view: { text } - the nodes could not be read, say why. */
export const Empty = ({ text }) => <div className="empty">{text}</div>;

/** The thread list: { status, items: [{ pip, title, by, amount, replies, stage: { cls, text }, href }] or null while reading }. */
export function ProposalList({ status, items }) {
  return (
    <div>
      <div className="bar"><span className="say">{status}</span><a className="btn primary grow" href="#new">New proposal</a></div>
      <div className="topics">
        <div className="th"><span>Proposal</span><span className="n">Amount</span><span className="n">Replies</span><span className="n">Stage</span></div>
        {items && !items.length ? <div className="empty">No proposals yet. Start the first one.</div> : null}
        {(items || []).map((p) => (
          <a key={p.pip} className="topic" href={p.href}>
            <span className="t"><span className="pip">{`PIP-${p.pip}`}</span> {p.title}<span className="by">{p.by}</span></span>
            <span className="amt">{p.amount}</span><span className="n">{p.replies}</span><Stage s={p.stage} />
          </a>))}
      </div>
    </div>);
}

function Post({ p, depth, children }) {
  return (
    <article className={`post${depth ? ' reply' : ''}`} style={depth ? { '--depth': Math.min(depth, 4) } : undefined}>
      <Avatar a={p.avatar} title={p.npub} />
      <div>
        <div className="who"><b title={p.npub}>{p.name}</b> · {p.head}</div>
        {p.html !== undefined ? <div className="body md" dangerouslySetInnerHTML={{ __html: p.html }} /> : <div className="body">{p.text}</div>}
        {children}
      </div>
    </article>);
}

/**
 * One thread: { thread: null (not held) | { heading, amount, lnurl, stage, stageLine, post, comments: [{ id, depth, ...post }] }, status,
 * onReply(text, parentId) -> Promise<{ ok, say }> }. A reply goes to the post named by its Reply button, else to the proposal.
 */
// THE TABLE THE FORM'S HELP SHOWS AND INSERTS (kanban #590)
export const TABLE_EXAMPLE = '| What | Sats |\n| --- | --: |\n| Server, one year | 50,000 |\n| Domain | 1,500 |';

export class ProposalThread extends React.Component {
  constructor(props) { super(props); this.state = { text: '', replyTo: null, replyName: null, say: '', bad: false, busy: false }; this.send = this.send.bind(this); this.box = React.createRef(); }
  async send(e) {
    e.preventDefault();
    if (!this.state.text.trim()) return;
    this.setState({ busy: true, say: 'Sending…', bad: false });
    const r = await this.props.onReply(this.state.text, this.state.replyTo);
    this.setState(r.ok ? { busy: false, say: r.say, bad: false, text: '', replyTo: null, replyName: null } : { busy: false, say: r.say, bad: true });
  }
  render() {
    const { thread: t, status } = this.props;
    const { text, replyName, say, bad, busy } = this.state;
    return (
      <div>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        {!t ? <div className="empty">{status}</div> : (
          <>
            <h1>{t.heading}</h1>
            <Post p={t.post} depth={0}>
              <div className="facts"><span><b>{t.amount}</b> to {t.lnurl}</span><Stage s={t.stage} /><span>{t.stageLine}</span></div>
            </Post>
            {t.comments.map((c) => (
              <Post key={c.id} p={c} depth={c.depth}>
                <div className="acts"><button type="button" onClick={() => { this.setState({ replyTo: c.id, replyName: c.name }); if (this.box.current) this.box.current.focus(); }}>Reply</button></div>
              </Post>))}
            <form className="compose" onSubmit={this.send}>
              <textarea ref={this.box} rows={4} maxLength={4000} value={text} placeholder={replyName ? `Reply to ${replyName}` : 'Write a reply'} onChange={(e) => this.setState({ text: e.target.value })} />
              <div className="bar"><button type="submit" className="btn primary" disabled={busy}>Post reply</button><span className={`say${bad ? ' bad' : ''}`}>{say}</span></div>
            </form>
          </>)}
      </div>);
  }
}

// A NEW PROPOSAL (slice 2): the type switch (the fees and payout types are their own components below), the reserves and the cap, title / what it does /
// how it improves (Markdown, with a preview made by forum.js's own Markdown), the amount against the cap and the Lightning address - the
// same checks and words as before - and publish: forum.js signs with the in-game key and hands it to every node (`onPublish`).
export const LN_ADDRESS = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
export const LNURL = /^lnurl1[02-9ac-hj-np-z]{20,}$/i;

/** The amount and the address against the cap: [ok, words, bad]. */
export function amountCheck({ amount, lnurl }, reserves, capPct) {
  if (!amount) return [true, '', false];
  const a = Number(amount), max = reserves ? Math.floor(reserves.sats * capPct / 100) : null;
  if (!(a >= 1)) return [false, 'Ask at least 1 sat.', true];
  if (!reserves) return [false, 'The reserves could not be read, so the amount cannot be checked yet.', true];
  if (a > max) return [false, `${n(a)} sat is more than ${capPct}% of the reserves (${n(max)} sat): it could never be paid.`, true];
  if (lnurl && !LN_ADDRESS.test(lnurl.trim()) && !LNURL.test(lnurl.trim())) return [false, 'That is not a Lightning address (you@wallet.example) or an LNURL.', true];
  return [true, `Within the cap: ${(a * 100 / reserves.sats).toFixed(2)}% of the reserves.`, false];
}

export class NewProposal extends React.Component {
  constructor(props) {
    super(props);
    this.state = { title: '', content: '', improves: '', amount: '', lnurl: '', preview: false, say: '', bad: false, busy: false, tableHelp: false };
    this.submit = this.submit.bind(this);
  }
  // A TABLE, AS AN EXAMPLE TO COPY (kanban #590, the owner 2026-10-23: "not sure how tables work. Explain it better in the help"): put at
  // the end of what the proposal does, with the preview opened so it shows as a table at once
  insertTable() {
    const c = this.state.content;
    this.setState({ content: c + (c && !c.endsWith('\n') ? '\n\n' : c ? '\n' : '') + TABLE_EXAMPLE + '\n', preview: true, say: '' });
  }
  used() { return this.props.purposeLength(this.state.title, this.state.content, this.state.improves); }
  async submit(e) {
    e.preventDefault();
    const s = this.state, out = (say, bad = true) => this.setState({ say, bad });
    if (!this.props.signedIn) return out('Open the Arena once first: the forum signs with your in-game key.');
    if (!s.title.trim() || !s.content.trim() || !s.improves.trim()) return out('Fill in the title, what it does, and how it improves Bitcoin Arena.');
    if (/\n/.test(s.title)) return out('The title is one line.');
    if (this.used() > 4000) return out('The three parts together are more than 4,000 characters.');
    const [ok, words] = amountCheck(s, this.props.reserves, this.props.capPct);
    if (!ok) return out(words);
    if (!s.lnurl.trim()) return out('Name the Lightning address to pay.');
    this.setState({ busy: true, say: 'Signing…', bad: false });
    const r = await this.props.onPublish({ title: s.title, content: s.content, improves: s.improves, amount: Math.floor(Number(s.amount)), lnurl: s.lnurl });
    this.setState({ busy: false, say: r.say, bad: !r.ok });
  }
  render() {
    const { reserves: r, reservesWhy, capPct, types, hash, markdown } = this.props;
    const s = this.state, max = r ? Math.floor(r.sats * capPct / 100) : null;
    const used = this.used(), [, amountWords, amountBad] = amountCheck(s, r, capPct);
    const field = (k) => ({ name: k, value: s[k], onChange: (e) => this.setState({ [k]: e.target.value, say: '' }) });
    return (
      <div>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        <h1>New proposal</h1>
        <div className="types" role="radiogroup" aria-label="Type"><span className="types-label">Type</span>
          {types.map(([h, label]) => <a key={h} className={`type${h === hash ? ' on' : ''}`} href={h} role="radio" aria-checked={h === hash ? 'true' : 'false'}>{label}</a>)}</div>
        <form className="compose" onSubmit={this.submit}>
          <p className="reserves-line">{r ? <>The protocol reserves hold <b>{n(r.sats)} sat</b> ({r.agreeing} of {r.asked} nodes agree). A proposal may ask at most <b>{capPct}%: {n(max)} sat</b>.</>
            : `The reserves could not be read${reservesWhy ? `: ${reservesWhy}` : ''}. A proposal may ask at most ${capPct}% of them.`}</p>
          <label>Title<input {...field('title')} maxLength={120} required placeholder="A short name for the PIP" /></label>
          <label>What the proposal does <span className="hint">Markdown: # heading, **bold**, *italic*, - list, `code`, [link](https://…) and tables{' '}
            <button type="button" className="linkish" id="pip-table-help" aria-expanded={s.tableHelp ? 'true' : 'false'} onClick={() => this.setState({ tableHelp: !s.tableHelp })}>{s.tableHelp ? 'hide how' : 'how?'}</button></span>
            {s.tableHelp ? <div className="mdhelp" id="pip-table-howto"><p>A table is one line per row, its cells between | bars. A second line of dashes makes the first row the header; a colon
              aligns a column: <code>:--</code> left, <code>:-:</code> centre, <code>--:</code> right.</p><pre>{TABLE_EXAMPLE}</pre>
              <button type="button" className="btn" id="pip-table-insert" onClick={() => this.insertTable()}>Insert this table</button></div> : null}
            <textarea {...field('content')} rows={10} required /></label>
          <div className="bar"><button type="button" className="btn" onClick={() => this.setState({ preview: !s.preview })}>{s.preview ? 'Hide preview' : 'Preview'}</button>
            <span className={`say${used > 4000 ? ' bad' : ''}`}>{n(used)} of 4,000 characters</span></div>
          {s.preview ? <div className="md preview"><h3>{s.title}</h3><div dangerouslySetInnerHTML={{ __html: markdown(s.content) }} /><h3 className="improves">How it improves Bitcoin Arena</h3><div dangerouslySetInnerHTML={{ __html: markdown(s.improves) }} /></div> : null}
          <label>How it improves Bitcoin Arena <span className="hint">its games, its protocol, its tools or its players</span><textarea {...field('improves')} rows={4} required /></label>
          <div className="row"><label>Amount (sat)<input {...field('amount')} type="number" min="1" step="1" required max={max || undefined} /></label>
            <label>Lightning address to pay<input {...field('lnurl')} placeholder="you@wallet.example" required /></label></div>
          <div className="bar"><button className="btn primary" type="submit" disabled={s.busy}>Sign and publish</button>
            <span className={`say${(s.say ? s.bad : amountBad) ? ' bad' : ''}`}>{s.say || amountWords}</span></div>
        </form>
      </div>);
  }
}

// CHANGE FEES (slice 3): the fees in force as the nodes answer them, one field per fee with its limit, the block it applies from, the
// reason; `check(typed, activation, purpose)` -> { changes, say, bad } is forum.js's own (the seats' rule through its client); publish
// signs and hands it to every node. Below, every fee proposal with its signal, vote, the developers' answers and its decision.
export class FeesProposal extends React.Component {
  constructor(props) { super(props); this.state = { typed: {}, activation: props.data ? String(props.data.earliest) : '', purpose: '', say: '', bad: false, busy: false }; this.submit = this.submit.bind(this); }
  componentDidUpdate(prev) { if (!prev.data && this.props.data && !this.state.activation) this.setState({ activation: String(this.props.data.earliest) }); }   // the fees arrived
  verdict() { return this.props.check(this.state.typed, Number(this.state.activation), this.state.purpose); }
  async submit(e) {
    e.preventDefault();
    if (!this.props.signedIn) return this.setState({ say: 'Open the Arena once first: the forum signs with your in-game key.', bad: true });
    const v = this.verdict();
    if (!v.changes) return this.setState({ say: v.say, bad: true });
    if (!this.state.purpose.trim()) return this.setState({ say: 'Say why: a proposal always gives its reason.', bad: true });
    this.setState({ busy: true, say: 'Signing…', bad: false });
    const r = await this.props.onPublish({ changes: v.changes, activation: Number(this.state.activation), purpose: this.state.purpose });
    this.setState({ busy: false, say: r.say, bad: !r.ok });
  }
  render() {
    const { data: d, error, types, hash, feeVal, markdown } = this.props;
    const head = (
      <>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        <h1>New proposal</h1>
        <div className="types" role="radiogroup" aria-label="Type"><span className="types-label">Type</span>
          {types.map(([h, label]) => <a key={h} className={`type${h === hash ? ' on' : ''}`} href={h} role="radio" aria-checked={h === hash ? 'true' : 'false'}>{label}</a>)}</div>
      </>);
    if (!d) return <div>{head}<div className="empty">{error || 'Reading the fees from the nodes…'}</div></div>;
    const s = this.state, v = Object.keys(s.typed).some((k) => s.typed[k] !== '') || s.purpose ? this.verdict() : { say: '', bad: false };
    const words = s.say || v.say, bad = s.say ? s.bad : v.bad;
    return (
      <div>
        {head}
        <form className="compose fees" onSubmit={this.submit}>
          <p className="reserves-line">Fees in force at block {d.tip} ({d.agreeing} of {d.asked} nodes agree). Fill in only the fees to change; leave the others empty. A round takes at most {d.sums.roundMaxBps / 100} %, an item's parts add up to {d.sums.itemPct} %, a market takes at most {d.sums.marketMaxBps / 100} %. A donation is never 0, and a change to one needs most of the protocol developers.</p>
          <div className="tbl"><table><thead><tr><th>Fee</th><th>In force</th><th>Limit</th><th>New value</th></tr></thead><tbody>
            {d.keys.map((k) => (
              <tr key={k}><td>{d.names[k] || k}{d.limits[k].donation ? <span className="hint"> donation</span> : null}</td><td>{feeVal(k, d.fees[k])}</td><td>{feeVal(k, d.limits[k].min)} – {feeVal(k, d.limits[k].max)}</td>
                <td><input name={k} type="number" step="1" min={d.limits[k].min} max={d.limits[k].max} placeholder={String(d.fees[k])} value={s.typed[k] || ''}
                  onChange={(e) => this.setState({ typed: { ...s.typed, [k]: e.target.value }, say: '' })} /> {d.units[k] === 'bps' ? 'bps' : '%'}</td></tr>))}
          </tbody></table></div>
          <div className="row"><label>Applies from block<input name="activation" type="number" step="1" min={d.earliest} value={s.activation} onChange={(e) => this.setState({ activation: e.target.value, say: '' })} /></label></div>
          <label>Why <span className="hint">required: what the change does and for whom</span><textarea name="purpose" rows={5} maxLength={4000} required value={s.purpose} onChange={(e) => this.setState({ purpose: e.target.value, say: '' })} /></label>
          <div className="bar"><button className="btn primary" type="submit" disabled={s.busy}>Sign and publish</button><span className={`say${bad ? ' bad' : ''}`}>{words}</span></div>
        </form>
        <h2>Fee proposals</h2>
        {!d.proposals.length ? <div className="empty">No fee proposals yet.</div> : d.proposals.map((p) => (
          <div key={p.id} className="fee-prop">
            <div className="bar"><b>{p.id.slice(0, 12)}…</b><span className="say">{p.decision ? (p.decision.accepted ? `accepted · in force from block ${p.activationHeight}` : `refused · ${p.decision.why}`) : p.vote ? `vote ${p.vote.state}` : `signal ${p.signal ? p.signal.state : '…'}`}</span></div>
            <ul>{p.changes.map((x) => <li key={x.fee}>{d.names[x.fee] || x.fee}: {feeVal(x.fee, x.from)} → {feeVal(x.fee, x.to)}</li>)}</ul>
            {p.needsDevs ? <p className="hint">Changes a donation: protocol developers {p.devs.filter((x) => x.approve).length} approve, {p.devs.filter((x) => !x.approve).length} deny.</p> : null}
            {p.purpose ? <div className="md" dangerouslySetInnerHTML={{ __html: markdown(p.purpose) }} /> : null}
          </div>))}
      </div>);
  }
}

// A LEADERBOARD PAYOUT (slice 4): what each federation holds and the most one payout may take, the form (scope, game, top, amount,
// federation, period, split, payment date, reason), and every request with its vote. `check(fields)` -> { ok, why } | { ok, request,
// say } is forum.js's own (the split, the date as a height and the cap through its client); publish signs and hands it to every node.
export class PayoutProposal extends React.Component {
  constructor(props) {
    super(props);
    const d = props.data;
    this.state = { scope: '0', game: '', top: '10', amount: '', fed: d && d.feds[0] ? d.feds[0].id : '', period: d ? String(d.periods[0]) : '', split: '', date: d ? d.defaultDate : '', purpose: '', say: '', bad: false, busy: false };
    this.submit = this.submit.bind(this);
  }
  componentDidUpdate(prev) {
    const d = this.props.data;
    if (!prev.data && d) this.setState({ fed: d.feds[0] ? d.feds[0].id : '', period: String(d.periods[0]), date: d.defaultDate });   // the nodes answered
  }
  fields() { const s = this.state; return { scope: s.scope, game: s.game, top: s.top, amount: s.amount, fed: s.fed, period: s.period, split: s.split, date: s.date, purpose: s.purpose }; }
  async submit(e) {
    e.preventDefault();
    if (!this.props.signedIn) return this.setState({ say: 'Open the Arena once first: the forum signs with your in-game key.', bad: true });
    const c = this.props.check(this.fields());
    if (!c.ok) return this.setState({ say: c.why, bad: true });
    if (!c.request.amountSats) return this.setState({ say: 'Name the amount.', bad: true });
    if (!c.request.purpose.trim()) return this.setState({ say: 'Say why: a proposal always gives its reason.', bad: true });
    this.setState({ busy: true, say: 'Signing…', bad: false });
    const r = await this.props.onPublish(c.request);
    this.setState({ busy: false, say: r.say, bad: !r.ok });
  }
  render() {
    const { data: d, error, types, hash, markdown } = this.props;
    const head = (
      <>
        <div className="bar"><a className="btn" href="#">← All proposals</a></div>
        <h1>New proposal</h1>
        <div className="types" role="radiogroup" aria-label="Type"><span className="types-label">Type</span>
          {types.map(([h, label]) => <a key={h} className={`type${h === hash ? ' on' : ''}`} href={h} role="radio" aria-checked={h === hash ? 'true' : 'false'}>{label}</a>)}</div>
      </>);
    if (!d) return <div>{head}<div className="empty">{error || 'Reading the nodes…'}</div></div>;
    const s = this.state, touched = s.amount || s.split || s.purpose || s.game;
    const live = touched ? this.props.check(this.fields()) : null;
    const words = s.say || (live ? (live.ok ? live.say : live.why) : ''), bad = s.say ? s.bad : !!(live && !live.ok);
    const f = (k) => ({ name: k, value: s[k], onChange: (e) => this.setState({ [k]: e.target.value, say: '' }) });
    return (
      <div>
        {head}
        <div className="avail">{!d.feds.length ? <div className="empty">No federation with a reserve key answered: nothing can be paid out now.</div> : d.feds.map((x) => (
          <div key={x.id} className="avail-fed"><div className="avail-name">Federation {x.id.slice(0, 8)}</div>
            <div className="avail-row"><span>Reserves now</span><b>{n(x.held)} sat</b></div>
            <div className="avail-row"><span>Max for one payout (10 %)</span><b className="max">{n(x.max)} sat</b></div></div>))}</div>
        <form className="compose payout" onSubmit={this.submit}>
          <p className="reserves-line">Pays the best players of a season by P&amp;L from one federation's protocol reserves, as e-cash into their Arena wallets. Its vote runs 2 weeks from publication, weighted by bond, with no signal; it passes when YES is at least 25 % of the voting weight. At most 10 % of that federation's reserves.</p>
          <div className="row"><label>Leaderboard<select {...f('scope')}><option value="0">All games and markets</option><option value="1">One game</option><option value="2">One market</option></select></label>
            <label>Game or market name<input {...f('game')} placeholder="e.g. btc-updown-15m" disabled={s.scope === '0'} /></label></div>
          <div className="row"><label>Top<input {...f('top')} type="number" min="1" max={d.topMax} /></label><label>Amount (sat)<input {...f('amount')} type="number" min="1" step="1" /></label></div>
          <div className="row"><label>Paid from<select {...f('fed')}>{d.feds.length ? d.feds.map((x) => <option key={x.id} value={x.id}>{x.id.slice(0, 8)} · reserves {n(x.held)} sat · up to {n(x.max)} sat</option>) : <option value="">no federation with a reserve key answered</option>}</select></label>
            <label>Period<select {...f('period')}>{d.periods.map((p) => <option key={p} value={p}>{p === 30 ? 'last month (30 days)' : `last ${p} days`}</option>)}</select></label></div>
          <div className="row"><label>Split per place <span className="hint">empty: equal; or percents, one per place, e.g. 50, 30, 20</span><input {...f('split')} placeholder="equal" /></label>
            <label>Payment date (UTC)<input {...f('date')} type="date" /></label></div>
          <label>Why <span className="hint">required: why these players, this amount</span><textarea {...f('purpose')} rows={3} maxLength={4000} required /></label>
          <div className="bar"><button className="btn primary" type="submit" disabled={s.busy}>Sign and publish</button><span className={`say${bad ? ' bad' : ''}`}>{words}</span></div>
        </form>
        <h2>Leaderboard payout requests</h2>
        {!d.list.length ? <div className="empty">{d.listEmpty}</div> : d.list.map((p) => (
          <div key={p.id} className="fee-prop"><div className="bar"><b>{p.title}</b><span className="say">{p.vote}</span></div><p className="hint">{p.line}</p>
            {p.purpose ? <div className="md" dangerouslySetInnerHTML={{ __html: markdown(p.purpose) }} /> : null}</div>))}
      </div>);
  }
}
