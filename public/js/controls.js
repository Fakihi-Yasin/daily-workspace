// Shared select and calendar fields. Native popovers put the panels in the top layer,
// above overflowing cards and dialogs, while retaining ordinary button focus and touch input.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';
const html = htm.bind(h);

function useFieldPopup(id) {
  const trigger = useRef(null);
  const panel = useRef(null);
  const [open, setOpen] = useState(false);

  function place() {
    const box = trigger.current?.getBoundingClientRect();
    const popup = panel.current;
    if (!box || !popup) return;
    const gap = 6;
    const bounds = window.visualViewport;
    const left = bounds?.offsetLeft || 0;
    const top = bounds?.offsetTop || 0;
    const right = left + (bounds?.width || window.innerWidth);
    const bottom = top + (bounds?.height || window.innerHeight);
    const desiredWidth = popup.classList.contains('calendar-popup') ? 310 : Math.max(box.width, 180);
    const width = Math.min(desiredWidth, right - left - 2 * gap);
    const below = bottom - box.bottom - 2 * gap;
    const above = box.top - top - 2 * gap;
    const useAbove = below < 275 && above > below;
    const room = Math.max(0, useAbove ? above : below);
    Object.assign(popup.style, {
      width: width + 'px',
      maxHeight: Math.min(room, 360) + 'px',
      left: Math.max(left + gap, Math.min(box.left, right - width - gap)) + 'px',
      top: (useAbove ? Math.max(top + gap, box.top - gap - Math.min(popup.scrollHeight + 2, room, 360)) : box.bottom + gap) + 'px',
    });
  }
  function close(focus = true) {
    panel.current?.hidePopover();
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  function show(focus = true) {
    if (panel.current.matches(':popover-open')) return;
    panel.current.showPopover();
    setOpen(true);
    place();
    if (focus) requestAnimationFrame(() => {
      const picked = panel.current?.querySelector('[data-popup-focus]:not([disabled]), [role=option][aria-selected=true]:not([disabled])');
      (picked || panel.current?.querySelector('button:not([disabled])'))?.focus();
    });
  }
  function toggle() {
    if (panel.current.matches(':popover-open')) close();
    else show();
  }
  useEffect(() => {
    if (!open) return;
    const handleScroll = (e) => { if (!panel.current?.contains(e.target)) place(); };
    const closeOnFocus = e => {
      if (e.target !== trigger.current && !panel.current?.contains(e.target)) close(false);
    };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', handleScroll, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    document.addEventListener('focusin', closeOnFocus);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', handleScroll, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      document.removeEventListener('focusin', closeOnFocus);
    };
  }, [open]);

  const escape = e => {
    if (e.key !== 'Escape' || !panel.current?.matches(':popover-open')) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  return {
    open, close, show, toggle, place,
    triggerProps: { ref: trigger, id, 'aria-expanded': open, onKeyDown: escape },
    panelProps: {
      ref: panel, popover: 'auto', onToggle: e => setOpen(e.newState === 'open'),
      onKeyDown: escape,
    },
  };
}

function optionsFrom(children) {
  if (Array.isArray(children)) return children.flatMap(optionsFrom);
  if (children?.type === 'optgroup') {
    const group = optionsFrom(children.props.children);
    return group.map((option,index) => ({ ...option,
      heading: index === 0 ? children.props.label : undefined, disabled: children.props.disabled || option.disabled }));
  }
  if (children?.type === 'option') {
    const { value, children: content, disabled } = children.props;
    return [{ value: String(value ?? content ?? ''), content, label: String(content ?? ''), disabled }];
  }
  return [];
}

export function Select({ children, options = optionsFrom(children), value, onChange, disabled, id,
  class: className = '', style, 'aria-label': label, title }) {
  const popup = useFieldPopup(id);
  const selected = options.find(o => String(o.value) === String(value)) || options[0];
  const search = useRef({ key: '', at: 0 });
  const choose = o => {
    if (o.disabled) return;
    popup.close();
    if (String(o.value) !== String(value)) {
      const target = { value: String(o.value) };
      onChange?.({ target, currentTarget: target });
    }
  };
  const navigate = e => {
    popup.panelProps.onKeyDown(e);
    const items = [...e.currentTarget.querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    let next;
    if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = items[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items.at(-1);
    else if (e.key.length === 1 && e.key !== ' ' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const key = e.key.toLocaleLowerCase();
      const prefix = performance.now() - search.current.at < 650 ? search.current.key : '';
      search.current = { key: prefix + key, at: performance.now() };
      next = [...items.slice(i + 1), ...items.slice(0, i + 1)]
        .find(item => item.dataset.label.startsWith(search.current.key));
    } else return;
    e.preventDefault();
    next?.focus();
  };
  return html`<span class=${'shared-field select-field ' + className} style=${style}>
    <button type="button" class="field-trigger" disabled=${disabled} aria-label=${label} title=${title}
      aria-haspopup="listbox" ...${popup.triggerProps} onClick=${popup.toggle}
      onKeyDown=${e => {
        popup.triggerProps.onKeyDown(e);
        if (['ArrowDown','ArrowUp'].includes(e.key) && !popup.open) { e.preventDefault(); popup.toggle(); }
      }}>
      <span class="field-value">${selected?.content}</span><span class="field-chevron" aria-hidden="true">▾</span>
    </button>
    <span class="field-popup select-popup" role="listbox" aria-label=${label || 'Options'}
      ...${popup.panelProps} onKeyDown=${navigate}>
      ${options.map(o => html`<span key=${o.value} class="select-option-row">
        ${o.heading && html`<span class="select-option-heading">${o.heading}</span>`}
        <button type="button" role="option" tabindex="-1" disabled=${o.disabled}
          aria-selected=${String(o.value) === String(selected?.value)}
          data-label=${String(o.label || '').toLocaleLowerCase()} onClick=${() => choose(o)}>${o.content}</button>
      </span>`)}
    </span>
  </span>`;
}

const toIso = (d) => d.toISOString().slice(0, 10);
const utc = (y, m, d = 1) => new Date(Date.UTC(y,m,d));
const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthName = (d, short) => d.toLocaleDateString(undefined, { month: short ? 'short' : 'long', timeZone: 'UTC' });
const todayIso = () => {
  const d = new Date();
  return toIso(utc(d.getFullYear(),d.getMonth(),d.getDate()));
};

export function DateField({ value = '', min, max, disabled, required, onInput, onChange, id, month = false,
  class: className = '', style, 'aria-label': label = month ? 'Month' : 'Date' }) {
  const popup = useFieldPopup(id);
  const initial = value || todayIso();
  const [page, setPage] = useState(() => initial.slice(0,7));
  const [year, index] = page.split('-').map(Number);
  const first = utc(year,index-1);
  const offset = (first.getUTCDay()+6)%7;
  const days = Array.from({length: Math.ceil((offset + utc(year,index,0).getUTCDate())/7)*7}, (_,i) => utc(year,index-1,i-offset+1));
  const step = pageOffset => toIso(utc(year,index-1+pageOffset)).slice(0,7);
  const pick = next => {
    const target = { value: next };
    popup.close();
    (onInput || onChange)?.({ target, currentTarget: target });
  };
  const show = () => {
    if (!popup.open) setPage((value || todayIso()).slice(0,7));
    popup.toggle();
  };
  const prev = step(month ? -12 : -1);
  const next = step(month ? 12 : 1);
  const blocked = iso => (min && iso < min) || (max && iso > max);
  const moveFocus = (e) => {
    popup.panelProps.onKeyDown(e);
    const iso = e.target.dataset.date;
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: month ? -3 : -7, ArrowDown: month ? 3 : 7 }[e.key];
    if (!iso || (!delta && e.key !== 'PageUp' && e.key !== 'PageDown')) return;
    e.preventDefault();
    const d = new Date(iso.length === 7 ? iso + '-01T00:00:00Z' : iso + 'T00:00:00Z');
    if (month || !delta) {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + (delta || (e.key === 'PageUp' ? -1 : 1)));
      d.setUTCDate(Math.min(day, utc(d.getUTCFullYear(),d.getUTCMonth()+1,0).getUTCDate()));
    } else d.setUTCDate(d.getUTCDate()+delta);
    const destination = toIso(d).slice(0, month ? 7 : 10);
    if (blocked(destination)) return;
    setPage(destination.slice(0,7));
    const root = e.currentTarget;
    requestAnimationFrame(() => root.querySelector('[data-date="' + destination + '"]')?.focus());
  };
  const shown = value ? new Date(value + (month ? '-01' : '') + 'T00:00:00Z').toLocaleDateString(undefined, {
    month: 'short', year: 'numeric', ...(month ? {} : { day: 'numeric' }), timeZone: 'UTC',
  }) : month ? 'Choose month' : 'Choose date';
  return html`<span class=${'shared-field date-field ' + className} style=${style}>
    <button type="button" class="field-trigger" aria-haspopup="dialog" aria-label=${label + (value ? ': ' + shown : '')}
      disabled=${disabled} ...${popup.triggerProps} onClick=${show}>
      <span class="field-value">${shown}</span>
      <svg class="field-calendar-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4m8-4v4"/></svg>
    </button>
    ${required && html`<input type="text" class="sr-only" tabindex="-1" aria-hidden="true" required value=${value}
      disabled=${disabled} onInvalid=${e => { e.preventDefault(); if (!popup.open) show(); }} />`}
    <span class="field-popup calendar-popup" role="dialog" aria-label=${month ? 'Choose month' : 'Choose date'}
      ...${popup.panelProps} onKeyDown=${moveFocus}>
      <span class="calendar-controls">
        <button type="button" aria-label=${month ? 'Previous year' : 'Previous month'} disabled=${min && (month ? prev.slice(0,4) < min.slice(0,4) : prev < min.slice(0,7))}
          onClick=${() => setPage(prev)}>‹</button>
        <strong aria-live="polite">${month ? year : monthName(first) + ' ' + year}</strong>
        <button type="button" aria-label=${month ? 'Next year' : 'Next month'} disabled=${max && (month ? next.slice(0,4) > max.slice(0,4) : next > max.slice(0,7))}
          onClick=${() => setPage(next)}>›</button>
      </span>
      ${!month && html`<span class="calendar-grid calendar-weekdays" aria-hidden="true">${labels.map(l => html`<span>${l}</span>`)}</span>`}
      <span class=${month ? 'calendar-grid months' : 'calendar-grid'}>
        ${(month ? Array.from({length:12},(_,i) => utc(year,i)) : days).map(d => {
          const iso = toIso(d).slice(0,month ? 7 : 10);
          return html`<button type="button" key=${iso} disabled=${blocked(iso)} data-date=${iso}
            data-popup-focus=${(value || todayIso().slice(0,month ? 7 : 10)) === iso ? '' : undefined}
            aria-label=${iso} aria-pressed=${value === iso}
            class=${!month && d.getUTCMonth() !== index-1 ? 'adjacent' : ''}
            onClick=${() => pick(iso)}>${month ? monthName(d,true) : d.getUTCDate()}</button>`;
        })}
      </span>
      ${!required && value && html`<button type="button" class="calendar-clear" onClick=${() => pick('')}>Clear</button>`}
    </span>
  </span>`;
}

export function SuggestField({ value = '', choices, onInput, id, maxlength, placeholder, label }) {
  const popup = useFieldPopup(id);
  const matches = choices.filter(choice => choice.toLocaleLowerCase().includes(value.toLocaleLowerCase())).slice(0, 75);
  useEffect(() => { if (popup.open) popup.place(); }, [value, popup.open]);
  const choose = choice => { popup.close(); onInput(choice); };
  const open = () => popup.show(false);
  return html`<span class="shared-field suggest-field">
    <input type="text" maxlength=${maxlength} autocomplete="off" value=${value} placeholder=${placeholder} aria-label=${label}
      ...${popup.triggerProps} onClick=${open} onInput=${e => { onInput(e.target.value); open(); }}
      aria-haspopup="listbox" onKeyDown=${e => {
        popup.triggerProps.onKeyDown(e);
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!popup.open) popup.show();
          else e.currentTarget.nextElementSibling.querySelector('button')?.focus();
        }
      }} />
    <span class="field-popup select-popup" role="listbox" aria-label=${label || 'Suggestions'}
      ...${popup.panelProps} onKeyDown=${e => {
        popup.panelProps.onKeyDown(e);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          (e.key === 'ArrowDown' ? e.target.nextElementSibling : e.target.previousElementSibling)?.focus();
        }
      }}>
      ${matches.map(choice => html`<button key=${choice} type="button" role="option" tabindex="-1" aria-selected=${choice === value} onClick=${() => choose(choice)}>${choice}</button>`)}
      ${!matches.length && html`<span class="suggest-empty">No matching suggestions</span>`}
    </span>
  </span>`;
}

export function TimeField({ value = '', onInput, style, 'aria-label': label = 'Time' }) {
  const popup = useFieldPopup();
  const [hour, setHour] = useState('');
  const [minute, setMinute] = useState('');
  const valid = /^\d{1,2}$/.test(hour) && /^\d{1,2}$/.test(minute) && +hour < 24 && +minute < 60;
  const save = next => { popup.close(); onInput({ target: { value: next } }); };
  const apply = () => { if (valid) save(hour.padStart(2,'0') + ':' + minute.padStart(2,'0')); };
  return html`<span class="shared-field time-field" style=${style}>
    <button type="button" class="field-trigger" aria-haspopup="dialog" aria-label=${label + (value ? ': ' + value : '')}
      ...${popup.triggerProps} onClick=${() => {
        if (!popup.open) {
          const [h,m] = value.split(':');
          setHour(h || ''); setMinute(m || '');
        }
        popup.toggle();
      }}>
      <span class="field-value">${value || 'Choose time'}</span><span class="field-chevron" aria-hidden="true">▾</span>
    </button>
    <span class="field-popup time-popup" role="dialog" aria-label="Choose time" ...${popup.panelProps}
      onKeyDown=${e => { popup.panelProps.onKeyDown(e); if (e.key==='Enter' && e.target.matches('input')) { e.preventDefault(); apply(); } }}>
      <span class="time-grid">
        <label class="field">Hour<input type="text" inputmode="numeric" maxlength="2" placeholder="00" data-popup-focus
          value=${hour} onInput=${e => setHour(e.target.value)} /></label>
        <label class="field">Minute<input type="text" inputmode="numeric" maxlength="2" placeholder="00"
          value=${minute} onInput=${e => setMinute(e.target.value)} /></label>
      </span>
      <span class="row">${value && html`<button type="button" onClick=${() => save('')}>Clear</button>`}
        <span class="spacer"></span><button type="button" disabled=${!valid} onClick=${apply}>Set time</button></span>
    </span>
  </span>`;
}
