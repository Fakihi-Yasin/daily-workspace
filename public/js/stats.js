import { Select, DateField } from './controls.js';
// Stats: asset counts, actual activity, target completion — kept separate.
import { html, useState, useResource, Bar, Chip, Modal, Empty, Icon, Ring, fmtDay, fmtShort, fmtDur, addDays, pct, KIND_PLURAL, KIND_LABELS } from './lib.js';
import { CompletedModal } from './history.js';
import { TeamCountTiles } from './teamwork.js';
import { PcTimeTile } from './pctime.js';

function rangeFor(kind, today, custom) {
  if (kind === 'day') return [today, today];
  if (kind === 'week') { const wd = (new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7; return [addDays(today, -wd), today]; }
  if (kind === 'month') return [today.slice(0, 8) + '01', today];
  return custom;
}

export function Stats() {
  const { data: boot } = useResource('/api/bootstrap');
  const [kind, setKind] = useState('week');
  const [custom, setCustom] = useState(null);
  const [inspect, setInspect] = useState(null);
  const today = boot && boot.today;
  const cr = custom || (today ? [addDays(today, -29), today] : null);
  const r = today ? rangeFor(kind, today, cr) : null;
  const { data } = useResource(r ? `/api/stats?from=${r[0]}&to=${r[1]}` : null);
  if (!boot || !data) return html`<p class="muted">Loading…</p>`;
  const a = data.activity;
  const counts = data.assetCounts;
  const countTile = (k, label) => { const c = counts[k] || { active: 0 }; return html`<div class="tile"><span class="v">${c.active || 0}</span><span class="k">${label}</span>
    ${(c.paused || c.archived || c.pending) ? html`<span class="small muted">${[c.paused && c.paused + ' paused', c.archived && c.archived + ' archived', c.pending && c.pending + ' upcoming'].filter(Boolean).join(' · ')}</span>` : ''}</div>`; };
  const maxOf = (l) => Math.max(1, ...l.map(x => x.count));
  // Only what this account uses: a kind of site/account it has, or activity in the period.
  const has = (...ks) => ks.some(k => counts[k] && (counts[k].active || counts[k].paused || counts[k].pending || counts[k].archived));
  const assetKinds = Object.keys(KIND_PLURAL).filter(k => has(k));
  const tile = (show, v, k) => show ? html`<div class="tile"><span class="v">${v}</span><span class="k">${k}</span></div>` : '';
  const inspectList = boot.assets.filter(x => x.status !== 'pending');
  return html`<div>
    <header class="page-head"><h1>Stats</h1></header>
    <div class="row wrap" style="margin-bottom:18px">
      <div class="seg">${[['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['custom', 'Custom']].map(([k, l]) => html`<button class=${kind === k ? 'on' : ''} onClick=${() => setKind(k)}>${l}</button>`)}</div>
      ${kind === 'custom' && html`<${DateField} value=${cr[0]} max=${cr[1]} onInput=${(e) => setCustom([e.target.value, cr[1]])} aria-label="From" style="width:auto" />
        <${DateField} value=${cr[1]} min=${cr[0]} onInput=${(e) => setCustom([cr[0], e.target.value])} aria-label="To" style="width:auto" />`}
      <span class="muted small">${data.from === data.to ? fmtDay(data.from) : `${fmtShort(data.from)} → ${fmtShort(data.to)}`}</span>
      <span class="spacer"></span>
      <label class="row small">Inspect<${Select} style="width:auto" value="" onChange=${(e) => e.target.value && setInspect(+e.target.value)}>
        <option value="">a site or account…</option>${inspectList.map(x => html`<option value=${x.id}>${x.name} (${KIND_LABELS[x.kind]})</option>`)}<//></label>
    </div>

    <section><div class="section-head"><h3>My sites, accounts & projects</h3><span class="muted small">today</span></div>
      <div class="tiles">
        ${assetKinds.map(k => countTile(k, KIND_PLURAL[k]))}
        <div class="tile"><span class="v">${counts.projects.active}</span><span class="k">Open projects</span>${counts.projects.done ? html`<span class="small muted">${counts.projects.done} done</span>` : ''}</div>
        ${(counts.digital_projects.active || counts.digital_projects.done) ? html`<div class="tile"><span class="v">${counts.digital_projects.active}</span><span class="k">Digital products</span>${counts.digital_projects.done ? html`<span class="small muted">${counts.digital_projects.done} done</span>` : ''}</div>` : ''}
      </div></section>

    ${window.__dash && window.__dash.rpc && html`<section class="section"><div class="section-head"><h3>Team Work</h3><span class="muted small">shared teams, kept apart from your personal scores</span></div><${TeamCountTiles} /></section>`}

    <section class="section"><div class="section-head"><h3>Actual activity</h3><span class="muted small">what was really done, extras included</span></div>
      <div class="tiles">
        <div class="tile"><span class="v">${a.tasksCompleted}<small class="muted" style="font-size:16px">/${a.tasksScheduled}</small></span><span class="k">Tasks completed</span></div>
        ${a.unitsByRoutine.map(u => html`<div class="tile"><span class="v">${u.count}</span><span class="k">${u.unit_label}</span><span class="small muted">${u.name}</span></div>`)}
        ${tile(a.pins || has('pinterest'), a.pins, 'Pins published')}
        ${tile(a.articles || has('site_iptv', 'site_blog'), a.articles, 'Articles published')}
        ${tile(a.videos, a.videos, 'Videos produced')}
        ${tile(a.publications || has('facebook', 'instagram'), a.publications, 'Social posts published')}
        ${tile(a.youtube, a.youtube, 'YouTube videos published')}
        <${PcTimeTile} from=${data.from} to=${data.to} />
        <div class="tile"><span class="v">${fmtDur(data.coding.total_sec)}</span><span class="k">Focus (${data.coding.sessions} session${data.coding.sessions > 1 ? 's' : ''})</span></div>
        <div class="tile"><span class="v">${fmtDur(data.study.total_min * 60)}</span><span class="k">Study</span></div>
      </div>
      <div class="grid2" style="margin-top:12px">
        ${(a.pinsByAccount.length || has('pinterest')) && html`<${HList} title="Pins per account" list=${a.pinsByAccount} max=${maxOf(a.pinsByAccount)} onPick=${setInspect} color="pink" />`}
        ${(a.articlesBySite.length || has('site_iptv', 'site_blog', 'site_other')) && html`<${HList} title="Articles per site" list=${a.articlesBySite} max=${maxOf(a.articlesBySite)} onPick=${setInspect} color="mint" />`}
        ${(a.publicationsByPage.length || has('facebook', 'instagram')) && html`<${HList} title="Posts per page" list=${a.publicationsByPage} max=${maxOf(a.publicationsByPage)} onPick=${setInspect} color="sky"
          extra=${Object.entries(a.publicationsByPlatform).map(([k, n]) => `${KIND_LABELS[k] || k}: ${n}`).join(' · ')} />`}
        <div class="card"><h4 style="margin-bottom:8px">Focus time per project</h4>
          ${Object.keys(data.coding.byProject).length ? Object.entries(data.coding.byProject).sort((x, y) => y[1] - x[1]).map(([n, s]) => html`<div class="hbar"><span class="name">${n}</span><${Bar} value=${(s / Math.max(...Object.values(data.coding.byProject))) * 100} thin /><span class="v">${fmtDur(s)}</span></div>`)
            : html`<p class="muted small">No finished sessions.</p>`}
          ${data.study.byCourse.length > 0 && html`<h4 style="margin:12px 0 8px">Study per course</h4>${data.study.byCourse.map(c => html`<div class="hbar"><span class="name">${c.name}</span><${Bar} value=${(c.m / Math.max(...data.study.byCourse.map(x => x.m))) * 100} thin color="mint" /><span class="v">${fmtDur(c.m * 60)}</span></div>`)}`}
        </div>
      </div></section>

    <section class="section"><div class="section-head"><h3>Targets reached</h3><span class="muted small">capped at 100% per task</span></div>
      ${data.target.categories.length === 0 ? html`<${Empty} title="No routines scheduled in this period" />` : html`
      <div class="grid2">
        <div class="card">
          ${data.target.categories.map(c => html`<div class="hbar"><span class="name">${c.category}</span><${Bar} value=${c.pct} /><span class="v">${c.done}/${c.target}</span></div>`)}
          <p class="small" style="margin-top:10px">Average daily score: <strong>${pct(data.avgDaily)}</strong> (tasks done ÷ tasks due, averaged over days with tasks).</p>
        </div>
        <div class="card"><h4>Daily score</h4>
          <div class="daybars" role="img" aria-label="Daily score over the period">${data.daily.map(d => html`<div class=${'b' + (d.overall == null ? ' none' : '')} style=${{ height: (d.overall || 0) + '%' }} title=${`${fmtShort(d.date)} : ${d.overall == null ? 'no score recorded' : `${d.done}/${d.total} tasks · ${pct(d.overall)}`}`}></div>`)}</div>
          <p class="small muted" style="margin-top:6px">Hatched: no score recorded for that day (excluded from averages).</p>
        </div>
      </div>`}
    </section>
    <${ScoreHistory} />
    ${inspect && html`<${AssetDetail} id=${inspect} range=${r} onClose=${() => setInspect(null)} />`}
  </div>`;
}

// Every date with recorded activity, newest first: its recorded score, a link to open that day on Today,
// and its completed tasks.
function ScoreHistory() {
  const { data } = useResource('/api/history/scores');
  const [limit, setLimit] = useState(30);
  const [popup, setPopup] = useState(null);
  if (!data) return null;
  const days = data.days.slice(0, limit);
  return html`<section class="section score-history" aria-label="Daily score history">
    <div class="section-head"><h3>Daily score history</h3><span class="muted small">${data.days.length} day${data.days.length === 1 ? '' : 's'} with recorded activity</span></div>
    ${data.days.length === 0 ? html`<${Empty} title="No activity recorded yet" />` : html`
    <ul class="hist-list card">${days.map(d => html`<li key=${d.date}>
      <${Ring} value=${d.pct} size=${36} stroke=${5}><span style="font-size:11px">${d.pct == null ? '—' : d.pct}</span></${Ring}>
      <div class="hist-main">
        <strong>${d.date === data.today ? 'Today · ' : ''}${fmtDay(d.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</strong>
        <span class="small muted">${d.pct == null ? 'No score recorded' : `${d.done}/${d.total} tasks done · ${d.pct}%${d.source === 'backfill' ? ' · from saved records' : ''}`}</span>
      </div>
      <div class="hist-actions">
        <a class="btn sm" href=${'#/today?date=' + d.date}>Open day</a>
        <button class="btn sm" onClick=${() => setPopup(d.date)} aria-label=${'View completed tasks on ' + fmtShort(d.date)}><${Icon} name="history" size=${14} />View completed tasks</button>
      </div>
    </li>`)}</ul>
    ${data.days.length > limit && html`<button class="btn sm" style="margin-top:10px" onClick=${() => setLimit(limit + 60)}>Show older days</button>`}`}
    ${popup && html`<${CompletedModal} date=${popup} onClose=${() => setPopup(null)} />`}
  </section>`;
}

function HList({ title, list, max, onPick, color, extra }) {
  return html`<div class="card"><h4 style="margin-bottom:8px">${title}</h4>
    ${list.length ? list.map(x => html`<div class="hbar"><button class="name link-btn" style="text-align:left;color:var(--ink);text-decoration:none" onClick=${() => onPick(x.asset_id)}>${x.name}</button><${Bar} value=${(x.count / max) * 100} thin color=${color} /><span class="v">${x.count}</span></div>`)
      : html`<p class="muted small">Nothing in this period.</p>`}
    ${extra && html`<p class="small muted" style="margin-top:6px">${extra}</p>`}
  </div>`;
}

const REC_LABEL = { pin: 'Pins', article: 'Articles', publication: 'Publications', youtube: 'YouTube videos', unit: 'Units' };
function AssetDetail({ id, range, onClose }) {
  const { data } = useResource(`/api/stats/asset/${id}?from=${range[0]}&to=${range[1]}`);
  return html`<${Modal} title=${data ? data.asset.name : 'Detail'} onClose=${onClose} wide>
    ${!data ? html`<p class="muted">Loading…</p>` : html`<div class="stack">
      <div class="row wrap"><${Chip} color="blue">${KIND_LABELS[data.asset.kind]}</${Chip}>
        ${data.asset.timeline.map(t => html`<span class="small muted">${t.status === 'active' ? 'active' : t.status === 'paused' ? 'paused' : 'archived'} from ${fmtShort(t.from_date)}</span>`)}</div>
      <div class="tiles">
        <div class="tile"><span class="v">${pct(data.target.pct)}</span><span class="k">Target reached (${data.target.done}/${data.target.target})</span></div>
        ${Object.entries(data.totals).filter(([k]) => REC_LABEL[k]).map(([k, n]) => html`<div class="tile"><span class="v">${n}</span><span class="k">${REC_LABEL[k]}</span></div>`)}
      </div>
      <table class="data"><thead><tr><th>Day</th><th class="r">Done</th><th class="r">Target</th><th class="r">%</th><th class="r">Actual</th></tr></thead>
        <tbody>${data.days.slice().reverse().map(d => html`<tr><td>${fmtShort(d.date)}</td><td class="r">${d.done}</td><td class="r">${d.target || '—'}</td><td class="r">${d.pct == null ? '—' : d.pct + '%'}</td>
          <td class="r">${Object.entries(d.records).filter(([k]) => REC_LABEL[k]).map(([k, n]) => `${n} ${REC_LABEL[k].toLowerCase()}`).join(', ') || '—'}</td></tr>`)}</tbody></table>
    </div>`}
  </${Modal}>`;
}
