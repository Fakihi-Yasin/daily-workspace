// Date helpers. All "dates" are local calendar dates (YYYY-MM-DD) in the configured timezone.

function partsIn(tz, ms) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

function todayIn(tz, ms = Date.now()) {
  const p = partsIn(tz, ms);
  return `${p.year}-${p.month}-${p.day}`;
}

function parse(d) { return new Date(d + 'T00:00:00Z'); }
function fmt(dt) { return dt.toISOString().slice(0, 10); }

function addDays(d, n) {
  const dt = parse(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fmt(dt);
}

function addMonths(d, n) {
  const dt = parse(d);
  const day = dt.getUTCDate();
  dt.setUTCDate(1);
  dt.setUTCMonth(dt.getUTCMonth() + n);
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(day, last));
  return fmt(dt);
}

function weekday(d) { return parse(d).getUTCDay(); } // 0 = dimanche

function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }

function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// Offset (ms) of tz at instant ms: local wall time - UTC.
function tzOffset(tz, ms) {
  const p = partsIn(tz, ms);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

// UTC instant (ms) for a local wall time in tz.
function localToUTC(tz, date, time = '00:00') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffset(tz, guess);
  t = guess - tzOffset(tz, t);
  return t;
}

function isValidTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parse(s)); }

module.exports = { todayIn, addDays, addMonths, weekday, diffDays, eachDay, localToUTC, isValidTz, isDate };
