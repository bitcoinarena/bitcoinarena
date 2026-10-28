// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA SITE'S SMALL PAGES IN REACT (kanban #564, 2026-10-21: "And also the small pages"): what /dashboard/ and /guardians/ drew
// by hand. NodesList: each testnet4 node's way to its own dashboard, with its key, today's profit and the rounds it checked once its
// dashboard.json answers. GuardianCheck: every guardian of the two testnet4 federations as this device reached it - its sessions and the
// time it took, or why not - with each federation's agreement and the total. WayOut: the /wallet/ page's link to where it goes. The pages keep reading the nodes; these draw what they read.
import React from 'react';
import { uptimeCell } from '../dashboard/Uptime.jsx';

const fmtSat = (msat) => (Number(msat) / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' sat';

// ITS UPTIME (kanban #756): 24 h · 7 d · 30 d · all from its GET /uptime, the 24 h marked when below inclusion
const uptimeLine = (u) => { const c = uptimeCell(u); return c ? <> · uptime <span className="v">{c.text}</span>{c.below ? <span className="bad"> below inclusion</span> : null}</> : null; };
/** rows: [{ n, href, read: null (reading) | false (not answering) | { node, dayMsat, rounds, uptime } }] */
export class NodesList extends React.Component {
  render() {
    const { rows } = this.props;
    if (!rows) return 'Reading the nodes’ routes…';
    return rows.map((r) => (
      <div className="row" key={r.n}>
        <a href={r.href}>Node {r.n}</a>
        <span className="k">{r.read === null ? 'reading…' : r.read === false ? 'not answering now'
          : <><span>{r.read.node.slice(0, 12)}…</span> · today <span className="v">{fmtSat(r.read.dayMsat)}</span> · {r.read.rounds} rounds checked{uptimeLine(r.read.uptime)}</>}</span>
      </div>));
  }
}

/** feds: [{ name, id, paths: [{ url, r: null (opening) | { ok, sessions, why, ms } }] }] */
export class GuardianCheck extends React.Component {
  render() {
    const { feds } = this.props;
    return feds.map((f, fi) => {
      const done = f.paths.every((p) => p.r);
      const ok = f.paths.filter((p) => p.r && p.r.ok), counts = ok.map((p) => p.r.sessions);
      const spread = counts.length ? Math.max(...counts) - Math.min(...counts) : null;
      const agree = done ? `${f.id}… · ${ok.length} of ${f.paths.length} answer${counts.length ? ` · sessions ${Math.min(...counts)}${spread ? `–${Math.max(...counts)}` : ''}${spread <= 1 ? ', in agreement' : ', NOT in agreement'}` : ''}` : `${f.id}…`;
      return (
        <React.Fragment key={f.id}>
          <h2>{f.name} <span className="agree" id={'agree-' + fi}>{agree}</span></h2>
          <table><tbody>{f.paths.map((p, pi) => (
            <tr key={p.url}><td className="path">{p.url}</td>
              <td className={'state ' + (!p.r ? 'wait' : p.r.ok ? 'ok' : 'bad')} id={`s-${fi}-${pi}`}>
                {!p.r ? 'opening…' : p.r.ok ? `${p.r.sessions} sessions · ${p.r.ms} ms` : `${p.r.why} · ${p.r.ms} ms`}</td></tr>))}</tbody></table>
        </React.Fragment>);
    });
  }
}

/** The /wallet/ page's way out, while the browser goes there: { to } - the wallet's address, as a link. */
export const WayOut = ({ to }) => <>If nothing happens: <a href={to}>{to}</a></>;
