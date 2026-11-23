// "View completed tasks" for one date: what was marked Done that day (the local day it was marked),
// from the completion history, so it outlives later edits, moves and deletion.
import { html, useResource, Modal, Icon, TaskText, fmtDay } from './lib.js';

const time = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';

export function CompletedModal({ date, onClose }) {
  const { data, error } = useResource(`/api/history/completions?date=${date}`);
  const title = 'Completed · ' + fmtDay(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return html`<${Modal} title=${title} onClose=${onClose}>
    ${error ? html`<p class="notice" role="alert">${error}</p>`
      : !data ? html`<p class="muted">Loading…</p>`
      : html`<div class="stack completed-history">
        ${data.history !== 'none' && html`<p class="completed-count"><strong class="num">${data.count}</strong> task${data.count === 1 ? '' : 's'} completed</p>`}
        ${data.history === 'none'
          ? html`<p class="notice blue">No completion history available for this day. It predates the completion history, so this doesn’t mean nothing was completed.</p>`
          : data.items.length === 0
            ? html`<p class="muted">No tasks completed on this day.</p>`
            : html`<ul class="done-list">${data.items.map(i => html`<li class=${i.kind === 'parent' ? 'parent-only' : ''}>
                <div class="done-line">
                  ${i.kind === 'parent' ? html`<span class="done-ic muted" aria-hidden="true">•</span>` : html`<span class="done-ic" aria-hidden="true"><${Icon} name="check" size=${14} /></span>`}
                  <span class="done-title"><${TaskText} text=${i.title} />${i.kind === 'parent' ? html` <span class="small muted">(not completed — subtasks only)</span>` : ''}${i.deleted ? html` <span class="small muted">(since deleted)</span>` : ''}</span>
                  ${i.done_at && html`<span class="small muted num done-time">${time(i.done_at)}</span>`}
                </div>
                ${i.subtasks && i.subtasks.length > 0 && html`<ul class="done-subs" aria-label="Completed subtasks">${i.subtasks.map(st => html`<li>
                  <span class="done-title"><${TaskText} text=${st.title} /></span>${st.done_at && html`<span class="small muted num done-time">${time(st.done_at)}</span>`}</li>`)}</ul>`}
              </li>`)}</ul>`}
        ${data.history === 'partial' && html`<p class="hint">This day predates the completion history (started ${fmtDay(data.log_since, { day: 'numeric', month: 'short', year: 'numeric' })}): one-off tasks deleted before then may be missing.</p>`}
        <p class="hint">Grouped by the day each task was marked Done. Subtasks are listed under their task and aren’t counted separately.</p>
      </div>`}
  </${Modal}>`;
}
