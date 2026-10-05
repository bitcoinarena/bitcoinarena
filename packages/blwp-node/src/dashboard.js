// /Dashboard: WHAT THIS NODE EARNED, SPENT AND DID (the owner 2026-10-01 15:44/15:45, open list item 2 of 21:16).
//
// "Every node serves /Dashboard. An interactive page with charts. A node earns from the 2% node fee ... Each category has
// its own earnings, and totals for the day, the month, and the year. Categories: game/verify fee, settlement fee,
// guardian/custody fee, other earnings if any, Lightning costs, gateway costs, and absolute profit. Also: since when the
// node has been active, which rounds it checked and what it earned on each, which settlements it made, and which
// federations it is in."
//
// EVERY FIGURE IS READ FROM THIS NODE'S OWN STORE (and its census, through `poolsFor`) - nothing asked of a peer, nothing estimated:
//   - a round it checked: one in which it signed at least one player's result;
//   - its fee share in that round: §22A's table (`nodeFeeTable`) over the entries it signed a result for, its two pools
//     the round's signer nodes - the table the settlement claims the fee locks by; EARNED once this node's settlement of
//     the round is ACCEPTED (the fee locks were claimed), OWED before;
//   - the guardian/custody third, Lightning and gateway costs: the fee table pays two pools and this node holds no
//     Lightning channel and pays no gateway, so they are 0 - and said so, not hidden;
//   - A NODE THAT HOSTS AN LND AND A GATEWAY (the owner 2026-10-03 22:50: node 1 gateway A + LND 1, node 2 gateway B + LND 2;
//     plan accepted 2026-10-04) shows them in `hosts`, read by hosts.js on this machine: the LND's own figures, the fees its
//     own payments paid as the Lightning costs of the day / month / year, and the gateway's figures. Gateway costs stay 0
//     with the reason: the gateway is what charges; the node pays it nothing. `hosts` is null on a node that hosts neither.
import { decodeRoundContract, decodeEntryContract } from '../../protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { nodeFeeTable } from '../../protocol/src/fee.js';
import { toHex } from '../../protocol/src/hash.js';

const DAY = 86400000;
const hex = (b) => toHex(new Uint8Array(b));

/** The dashboard's figures, from `round` (a Round over this node's store) at `nowMs`. */
export function dashboardData(round, { nowMs = Date.now(), roundsShown = 200, poolsFor = null, hosts = null } = {}) {
  const db = round.db;
  const me = hex(round.pubkey);
  const first = db.prepare('SELECT MIN(opened_ms) AS t FROM rounds').get();
  // THE ROUNDS WITH ENTRIES, newest first: the only rounds a fee can come from
  const rows = db.prepare(`SELECT r.round_id, r.contract, r.opened_ms, COUNT(e.entry_id) AS n, MAX(e.joined_ms) AS lastJoin
    FROM rounds r JOIN entries e ON e.round_id = r.round_id GROUP BY r.round_id ORDER BY lastJoin DESC`).all();
  const resultsOf = db.prepare('SELECT entry_id, bytes FROM results WHERE round_id = ? AND node_pubkey = ?');
  const entryOf = db.prepare('SELECT contract FROM entries WHERE entry_id = ?');
  const settlementOf = db.prepare('SELECT state, why, made_ms FROM lock_settlements WHERE round_id = ?');
  const rounds = [];
  const federations = new Map();
  for (const r of rows) {
    let contract;
    try { contract = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
    const fed = contract.federationId ? hex(contract.federationId) : null;
    if (fed && contract.stakeMsat > 0n) {
      const f = federations.get(fed) || { federation: fed, firstMs: Number(contract.startTimeMs), lastMs: 0, rounds: 0 };
      f.firstMs = Math.min(f.firstMs, Number(contract.startTimeMs)); f.lastMs = Math.max(f.lastMs, Number(contract.startTimeMs)); f.rounds++;
      federations.set(fed, f);
    }
    const mine = resultsOf.all(r.round_id, Buffer.from(round.pubkey));
    const entries = [];
    for (const x of mine) {
      try {
        const res = decodePlayerResult(splitSignedResult(new Uint8Array(x.bytes)).body);
        const e = decodeEntryContract(new Uint8Array(entryOf.get(x.entry_id).contract));
        entries.push({ pubkey: e.playerPubkey, stakeMsat: e.stakeMsat, outcome: res.outcome });
      } catch { /* an unreadable row earns nothing */ }
    }
    let gameVerify = 0n; let settlement = 0n; let guardian = 0n;
    if (entries.length && contract.stakeMsat > 0n && Array.isArray(contract.nodes)) {
      try {
        // THE SAME POOLS THE SETTLEMENT PAYS BY (server: the census committees and the federation's guardians)
        let pools = { gameVerify: contract.nodes, settlement: contract.nodes, guardian: [] };
        try { if (poolsFor) pools = poolsFor(new Uint8Array(r.round_id), contract) || pools; } catch { /* the contract's own nodes */ }
        const all = [...pools.gameVerify, ...pools.settlement, ...(pools.guardian || [])];
        const table = nodeFeeTable({ contract, entries, pools, eligible: new Set(all.map(hex)) });
        for (const [k, msat] of table.signerNodes) {
          if (!k.endsWith(me)) continue;
          if (k.startsWith('gameVerify')) gameVerify += msat; else if (k.startsWith('guardian')) guardian += msat; else settlement += msat;
        }
      } catch { /* a round the table refuses earns nothing here */ }
    }
    const s = settlementOf.get(r.round_id);
    rounds.push({ id: hex(r.round_id), startMs: Number(contract.startTimeMs), free: contract.stakeMsat === 0n,
      stakeMsat: String(contract.stakeMsat), entries: r.n, checked: mine.length,
      settlement: s ? { state: s.state, madeMs: Number(s.made_ms), why: String(s.why || '').slice(0, 160) } : null,
      earned: s && s.state === 'ACCEPTED', gameVerifyMsat: String(gameVerify), settlementMsat: String(settlement), guardianMsat: String(guardian) });
  }
  const checked = rounds.filter((r) => r.checked > 0);
  // TOTALS FOR THE DAY, THE MONTH, THE YEAR (UTC), earned only
  const zero = () => ({ gameVerifyMsat: 0n, settlementMsat: 0n, guardianMsat: 0n, otherMsat: 0n, lightningCostMsat: 0n, gatewayCostMsat: 0n });
  const now = new Date(nowMs);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const yearStart = Date.UTC(now.getUTCFullYear(), 0, 1);
  const totals = { day: zero(), month: zero(), year: zero(), owed: zero() };
  const daily = new Map();
  for (const r of checked) {
    const add = (t) => { t.gameVerifyMsat += BigInt(r.gameVerifyMsat); t.settlementMsat += BigInt(r.settlementMsat); t.guardianMsat += BigInt(r.guardianMsat); };
    if (!r.earned) { add(totals.owed); continue; }
    const at = r.settlement.madeMs;
    if (at >= dayStart) add(totals.day);
    if (at >= monthStart) add(totals.month);
    if (at >= yearStart) add(totals.year);
    const d = new Date(at).toISOString().slice(0, 10);
    const t = daily.get(d) || zero(); add(t); daily.set(d, t);
  }
  // THE LIGHTNING COSTS OF A NODE THAT HOSTS AN LND: the fees its own payments paid, by when they were made
  const lnd = hosts && hosts.lnd && !hosts.lnd.error ? hosts.lnd : null;
  for (const p of (lnd && lnd.paymentFees) || []) {
    const fee = BigInt(p.feeMsat);
    if (p.atMs >= dayStart) totals.day.lightningCostMsat += fee;
    if (p.atMs >= monthStart) totals.month.lightningCostMsat += fee;
    if (p.atMs >= yearStart) totals.year.lightningCostMsat += fee;
  }
  const out = (t) => {
    const income = t.gameVerifyMsat + t.settlementMsat + t.guardianMsat + t.otherMsat;
    const costs = t.lightningCostMsat + t.gatewayCostMsat;
    return Object.fromEntries([...Object.entries(t).map(([k, v]) => [k, String(v)]), ['profitMsat', String(income - costs)]]);
  };
  const days = [];
  for (let d = 29; d >= 0; d--) {
    const key = new Date(dayStart - d * DAY).toISOString().slice(0, 10);
    days.push({ day: key, ...out(daily.get(key) || zero()) });
  }
  const settlements = db.prepare('SELECT round_id, state, why, made_ms FROM lock_settlements ORDER BY made_ms DESC LIMIT 100').all()
    .map((s) => ({ round: hex(s.round_id), state: s.state, madeMs: Number(s.made_ms), why: String(s.why || '').slice(0, 200) }));
  const byState = {};
  for (const s of db.prepare('SELECT state, COUNT(*) AS n FROM lock_settlements GROUP BY state').all()) byState[s.state] = s.n;
  return {
    node: me, nowMs, sinceMs: first && first.t ? Number(first.t) : null,
    totals: { day: out(totals.day), month: out(totals.month), year: out(totals.year), owed: out(totals.owed) },
    days, roundsChecked: checked.length, rounds: checked.slice(0, roundsShown),
    settlements, settlementsByState: byState, federations: [...federations.values()],
    notes: {
      guardian: 'the guardian third (§22A) goes to the census nodes guarding the round\'s federation; this node\'s share is shown when it guards it',
      lightning: hosts && hosts.lnd ? `this node hosts LND ${hosts.lnd.alias || '(not read: ' + (hosts.lnd.error || '?') + ')'}; its Lightning costs are the fees its own payments paid`
        : 'this node holds no Lightning channel',
      gateway: hosts && hosts.gateway ? `this node hosts gateway ${hosts.gateway.name}; gateway costs are 0: the gateway is what charges, the node pays it nothing`
        : 'this node pays no gateway',
    },
    hosts: hosts && (hosts.lnd || hosts.gateway) ? {
      lnd: hosts.lnd ? (() => { const { paymentFees, ...rest } = hosts.lnd;
        return { ...rest, paymentsWithFee: (paymentFees || []).length, paidFeesMsat: String((paymentFees || []).reduce((t, x) => t + BigInt(x.feeMsat), 0n)) }; })() : null,
      gateway: hosts.gateway || null,
    } : null,
  };
}

/** The page: one HTML document that reads /dashboard.json and draws it (no outside script). */
export function dashboardHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Node Dashboard</title><style>
:root{--bg:#0f1218;--card:#171c25;--line:#2a3140;--text:#e6e9ef;--dim:#8b93a3;--gv:#f2a93b;--st:#4fa3ff;--gd:#9b7bff;--ok:#3fbf7f;--bad:#e25c5c}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f5f6f8;--card:#fff;--line:#dde1e7;--text:#1b2230;--dim:#5d6676}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif;padding:16px;max-width:1100px;margin:auto}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.sub{color:var(--dim);margin-bottom:14px;word-break:break-all}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card h3{margin:0 0 8px;font-size:13px;color:var(--dim)}
.row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 8px;padding:2px 0}.row b{font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:auto}.notes{color:var(--dim);word-break:normal;overflow-wrap:anywhere}.notes p{margin:0 0 6px}
#chartbox{position:relative}#tip{position:absolute;display:none;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px;font-size:12px;white-space:normal;max-width:calc(100% - 8px);font-variant-numeric:tabular-nums}.profit{border-top:1px solid var(--line);margin-top:6px;padding-top:6px}
.tabs button{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 10px;margin-right:4px;cursor:pointer}.tabs button.on{border-color:var(--gv)}
svg{width:100%;height:auto;display:block}table{width:100%;border-collapse:collapse;font-size:12.5px}th,td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600}td.n{text-align:right;font-variant-numeric:tabular-nums}.ok{color:var(--ok)}.bad{color:var(--bad)}.scroll{overflow-x:auto}
.legend span{display:inline-block;margin-right:12px;color:var(--dim)}tr.rr{cursor:pointer}tr.rr:hover td{background:rgba(127,127,127,.08)}tr.pl>td{background:rgba(127,127,127,.05);padding:6px 6px 10px 22px}tr.pl table{font-size:12px}a{color:var(--st)}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
</style></head><body>
<h1>Node Dashboard</h1><div class="sub" id="who">loading…</div>
<h2>Earnings</h2><div class="tabs" id="tabs"></div><div class="grid" id="totals" style="margin-top:8px"></div>
<h2>Fee earned per day, last 30 days (msat)</h2><div class="card" id="chartbox"><div id="tip" role="status"></div><div class="legend"><span><i style="background:var(--gv)"></i>game/verify</span><span><i style="background:var(--st)"></i>settlement</span><span><i style="background:var(--gd)"></i>guardian</span></div><div id="chart"></div></div>
<h2>Rounds checked</h2><div class="card scroll"><table id="rounds"></table></div>
<h2>Settlements</h2><div class="card scroll"><div id="sstate" class="sub"></div><table id="settle"></table></div>
<h2>Federations</h2><div class="card scroll"><table id="feds"></table></div>
<script>
const sat=(m)=>{const n=Number(m)/1000;return (n<10?n.toFixed(3):n.toFixed(n<1000?1:0)).replace(/\\.0+$/,'')+' sat'};
const t=(ms)=>ms?new Date(ms).toISOString().replace('T',' ').slice(0,19)+' UTC':'-';
const el=(id)=>document.getElementById(id);
let D=null,period='day';
// THE ROUNDS ARE CLICKABLE (the owner 2026-10-03 22:25, plan accepted 2026-10-04): a row opens to its players, read from this
// node's own api/round-result when it is first opened and kept for this page view; an open row stays open across the
// 60 s refresh. Every value is the endpoint's own - outcome, score, signers, stake, result and netMsat; nothing worked out.
const open=new Set(),players=new Map();
const esc=(v)=>String(v).replace(/[<>&"]/g,(c)=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
const score=(v)=>v===null||v===undefined?'-':Math.trunc(v/100000)+'.'+String(Math.abs(v)%100000).padStart(5,'0');
// A NOTE'S HYPHENS DO NOT BREAK (kanban #125, measured at 1280 px: "test-host- / testnet4"): a name in a note stays one word.
const keep=(t)=>String(t).replace(/-/g,'\\u2011');
const signedSat=(m)=>m===null||m===undefined||m===''?'':(Number(m)>0?'+':'')+sat(m);
function playersOf(id){const a=players.get(id);
 if(!a||a.loading)return 'reading api/round-result…';if(a.error)return 'could not read api/round-result: '+esc(a.error);
 if(!(a.players||[]).length)return 'no players in this round';
 return '<table><tr><th>Player</th><th>Outcome</th><th class="n">Score</th><th class="n">Signed by</th><th class="n">Stake</th><th>Won or lost</th><th class="n">Net</th><th>Replay</th></tr>'+a.players.map(p=>{const n=p.netMsat;const c=n===null||n===undefined?'':Number(n)>0?'ok':Number(n)<0?'bad':'';
  return '<tr><td>'+esc(p.name||'')+'</td><td>'+esc(p.outcome||'not signed yet')+'</td><td class="n">'+score(p.score)+'</td><td class="n">'+(p.signedBy|0)+'</td><td class="n">'+sat(p.stakeMsat)+'</td><td class="'+c+'">'+esc(p.result||'')+'</td><td class="n '+c+'">'+signedSat(n)+'</td><td><a href="replay?round='+esc(a.id)+'&entry='+esc(p.entry)+'" target="_blank" rel="noopener">replay</a></td></tr>'}).join('')+'</table>'}
function readPlayers(id){players.set(id,{loading:true});fetch('api/round-result?round='+id,{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status))).then(j=>{players.set(id,j);tables()}).catch(e=>{players.set(id,{error:e.message});tables()})}
function totals(){const T=D.totals[period];const names=[['gameVerifyMsat','Game/verify fee'],['settlementMsat','Settlement fee'],['guardianMsat','Guardian/custody fee'],['otherMsat','Other earnings'],['lightningCostMsat','Lightning costs'],['gatewayCostMsat','Gateway costs']];
el('totals').innerHTML='<div class="card"><h3>'+({day:'Today',month:'This month',year:'This year'}[period])+' (earned: settlement ACCEPTED)</h3>'+names.map(([k,n])=>'<div class="row"><span>'+n+'</span><b>'+(k.includes('Cost')&&T[k]!=='0'?'−':'')+sat(T[k])+'</b></div>').join('')+'<div class="row profit"><span>Absolute profit</span><b>'+sat(T.profitMsat)+'</b></div></div>'
 +'<div class="card"><h3>Owed (rounds not settled yet)</h3><div class="row"><span>Game/verify</span><b>'+sat(D.totals.owed.gameVerifyMsat)+'</b></div><div class="row"><span>Settlement</span><b>'+sat(D.totals.owed.settlementMsat)+'</b></div><div class="row"><span>Guardian</span><b>'+sat(D.totals.owed.guardianMsat)+'</b></div></div>'
 +'<div class="card"><h3>Notes</h3><div class="notes"><p>'+keep(D.notes.guardian)+'</p><p>'+keep(D.notes.lightning)+'</p><p>'+keep(D.notes.gateway)+'</p></div></div>'+hostsCard();
el('tabs').innerHTML=['day','month','year'].map(p=>'<button class="'+(p===period?'on':'')+'" data-p="'+p+'">'+({day:'Day',month:'Month',year:'Year'}[p])+'</button>').join('');
el('tabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{period=b.dataset.p;totals()});}
// THE HOSTS CARD (node 1: gateway A + LND 1, node 2: gateway B + LND 2): only on a node that hosts them
function hostsCard(){const H=D.hosts;if(!H)return '';const r=(k,v)=>'<div class="row"><span>'+k+'</span><b>'+v+'</b></div>';let s='<div class="card" id="hosts"><h3>Hosts</h3>';
 const L=H.lnd;if(L)s+=L.error?r('LND','not read: '+esc(L.error)):r('LND',esc(L.alias))+r('Node key',esc(L.pubkey.slice(0,16))+'…')+r('Active channels',L.activeChannels)+r('Local balance',sat(L.localMsat))+r('Remote balance',sat(L.remoteMsat))+r('Routing fees, 30 days',sat(L.routingFeesMsat30d)+' · '+L.forwards30d+' forwards')+r('Fees its payments paid',sat(L.paidFeesMsat)+' · '+L.paymentsWithFee+' payments');
 const G=H.gateway;if(G)s+=G.error?r('Gateway '+esc(G.name),'not read: '+esc(G.error)):r('Gateway',esc(G.name)+' · '+esc(G.state))+(G.federations||[]).map(f=>r('E-cash in '+esc(f.name||f.id.slice(0,12)),sat(f.ecashMsat))).join('')+r('Lightning balance',sat(G.lightningMsat))+r('Inbound liquidity',sat(G.inboundMsat))+r('On-chain',G.onchainSat+' sat')+(G.payments30d?r('Payments in, 30 days',G.payments30d.incoming.success+' ok · '+G.payments30d.incoming.failure+' failed · fees '+sat(G.payments30d.incoming.feesMsat))+r('Payments out, 30 days',G.payments30d.outgoing.success+' ok · '+G.payments30d.outgoing.failure+' failed · fees '+sat(G.payments30d.outgoing.feesMsat)):'');
 const at=Math.max((L&&L.readAtMs)||0,(G&&G.readAtMs)||0);return s+'<div class="sub" style="margin:6px 0 0">read '+t(at)+'</div></div>'}
function chart(){const W=1000,H=220,P=34,days=D.days,max=Math.max(1,...days.map(d=>Number(d.gameVerifyMsat)+Number(d.settlementMsat)+Number(d.guardianMsat)));const bw=(W-P)/days.length;
let s='<svg viewBox="0 0 '+W+' '+(H+24)+'" role="img" aria-label="fee per day">';for(let i=0;i<=4;i++){const y=H-(H-10)*i/4;s+='<line x1="'+P+'" x2="'+W+'" y1="'+y+'" y2="'+y+'" stroke="var(--line)"/><text x="0" y="'+(y+4)+'" fill="var(--dim)" font-size="11">'+Math.round(max*i/4)+'</text>'}
days.forEach((d,i)=>{const g=Number(d.gameVerifyMsat),st=Number(d.settlementMsat),gd=Number(d.guardianMsat),hg=(H-10)*g/max,hs=(H-10)*st/max,hd=(H-10)*gd/max,x=P+i*bw+2;
s+='<g><title>'+d.day+': game/verify '+g+' msat, settlement '+st+' msat, guardian '+gd+' msat</title><rect x="'+x+'" y="'+(H-hg)+'" width="'+(bw-4)+'" height="'+hg+'" fill="var(--gv)"/><rect x="'+x+'" y="'+(H-hg-hs)+'" width="'+(bw-4)+'" height="'+hs+'" fill="var(--st)"/><rect x="'+x+'" y="'+(H-hg-hs-hd)+'" width="'+(bw-4)+'" height="'+hd+'" fill="var(--gd)"/></g>';
if(i%5===0)s+='<text x="'+x+'" y="'+(H+16)+'" fill="var(--dim)" font-size="11">'+d.day.slice(5)+'</text>'});el('chart').innerHTML=s+'</svg>';
// THE DAY UNDER THE POINTER OR A TAP (kanban #125): its date and its three amounts, in a box beside it - the SVG title stays.
const svg=el('chart').querySelector('svg'),tip=el('tip'),box=el('chartbox');const show=(ev)=>{const r=svg.getBoundingClientRect();const vx=(ev.clientX-r.left)*W/r.width;const i=Math.floor((vx-P)/bw);
if(i<0||i>=days.length){tip.style.display='none';return}const d=days[i],g=Number(d.gameVerifyMsat),st=Number(d.settlementMsat),gd=Number(d.guardianMsat);
tip.textContent=d.day+': game/verify '+g+' msat · settlement '+st+' msat · guardian '+gd+' msat';tip.style.display='block';const b=box.getBoundingClientRect();
tip.style.left=Math.max(4,Math.min(ev.clientX-b.left+10,b.width-tip.offsetWidth-4))+'px';tip.style.top=Math.max(4,ev.clientY-b.top-34)+'px'};
svg.addEventListener('pointermove',show);svg.addEventListener('pointerdown',show);svg.addEventListener('pointerleave',()=>{tip.style.display='none'})}
function tables(){el('rounds').innerHTML='<tr><th>Round</th><th>Start</th><th>Kind</th><th class="n">Entries</th><th class="n">Checked</th><th class="n">Game/verify</th><th class="n">Settlement</th><th class="n">Guardian</th><th>Settlement</th></tr>'+D.rounds.map(r=>'<tr class="rr" data-r="'+r.id+'"><td>'+(open.has(r.id)?'&#9662; ':'&#9656; ')+r.id.slice(0,12)+'</td><td>'+t(r.startMs)+'</td><td>'+(r.free?'free':sat(r.stakeMsat))+'</td><td class="n">'+r.entries+'</td><td class="n">'+r.checked+'</td><td class="n">'+sat(r.gameVerifyMsat)+'</td><td class="n">'+sat(r.settlementMsat)+'</td><td class="n">'+sat(r.guardianMsat)+'</td><td class="'+(r.earned?'ok':'')+'">'+(r.settlement?r.settlement.state:'-')+'</td></tr>'+(open.has(r.id)?'<tr class="pl"><td colspan="9">'+playersOf(r.id)+'</td></tr>':'')).join('');
el('rounds').onclick=(ev)=>{const tr=ev.target.closest('tr.rr');if(!tr)return;const id=tr.dataset.r;if(open.has(id))open.delete(id);else{open.add(id);if(!players.has(id)||players.get(id).error)readPlayers(id)}tables()};
el('sstate').textContent=Object.entries(D.settlementsByState).map(([k,v])=>k+' '+v).join(' · ')||'none yet';
el('settle').innerHTML='<tr><th>Round</th><th>Made</th><th>State</th><th>What</th></tr>'+D.settlements.map(s=>'<tr><td>'+s.round.slice(0,12)+'</td><td>'+t(s.madeMs)+'</td><td class="'+(s.state==='ACCEPTED'?'ok':s.state==='REFUSED'?'bad':'')+'">'+s.state+'</td><td>'+s.why.replace(/[<>&]/g,'')+'</td></tr>').join('');
el('feds').innerHTML='<tr><th>Federation</th><th class="n">Paid rounds</th><th>First</th><th>Last</th></tr>'+D.federations.map(f=>'<tr><td>'+f.federation.slice(0,16)+'…</td><td class="n">'+f.rounds+'</td><td>'+t(f.firstMs)+'</td><td>'+t(f.lastMs)+'</td></tr>').join('')}
async function load(){D=await (await fetch('dashboard.json',{cache:'no-store'})).json();
el('who').textContent='node '+D.node+' · active since '+t(D.sinceMs)+' · '+D.roundsChecked+' rounds checked · as of '+t(D.nowMs);totals();chart();tables()}
load().catch(e=>{el('who').textContent='could not read dashboard.json: '+e.message});setInterval(()=>load().catch(()=>{}),60000);
</script></body></html>`;
}
