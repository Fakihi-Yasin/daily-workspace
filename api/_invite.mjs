// Team invites (used by api/invite.mjs on Vercel, and by scripts/preview.js in local tests).
//
// It holds no database power of its own: every database call is made with the signed-in user's own
// access token and the public (publishable) key, so the database decides who may invite (the team
// owner) exactly as for any other call. The only secret here is the email provider's API key.
//
//   1. team_invite_create (owner only) saves an invitation addressed to the EMAIL. It never looks up
//      accounts, so the answer is the same whether the address is registered or not. Any account whose
//      verified email is that address sees it under Team Work → Invitations and can Accept it.
//   2. If an email provider is set up, the link is also emailed; only when the provider accepted it is
//      the answer "Invite sent". Without a provider (or if sending fails) the answer says clearly that
//      no email was sent; the invitation still works in the app.

const IN_APP = 'If this address belongs to an account with a confirmed email, they’ll find the invitation under Team Work → Invitations (or after they sign up with it).';
export const MISSING_EMAIL_MESSAGE = 'Invitation saved, but no email was sent: no email provider is set up for this app. ' + IN_APP;

export function emailConfig(env) {
  const missing = [];
  if (!env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!env.INVITE_FROM_EMAIL) missing.push('INVITE_FROM_EMAIL');
  // Local test builds only: write emails to a file instead of sending them. Refused on Vercel.
  if (env.INVITE_TEST_OUTBOX && !env.VERCEL) return { ok: true, outbox: env.INVITE_TEST_OUTBOX, from: 'Dashboard <invites@test.invalid>' };
  return missing.length ? { ok: false, missing } : { ok: true, key: env.RESEND_API_KEY, from: env.INVITE_FROM_EMAIL };
}

// The link's origin never comes from the request (a forged Host header can't redirect invitees).
export function appUrl(env) {
  const u = (env.APP_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL : '')).replace(/\/+$/, '');
  return /^https?:\/\/[a-z0-9.:-]+$/i.test(u) ? u : '';
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Plain one-line text for subject lines and the text part (no control characters).
const plain = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

export function inviteEmail({ inviter, team, link, email, expiresAt }) {
  const until = new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const subject = `${plain(inviter)} invited you to the team “${plain(team)}”`;
  const text = `${plain(inviter)} invited you to join the team “${plain(team)}” on Dashboard.\n\n`
    + `Open this link to join:\n${link}\n\n`
    + `Sign in, or create an account, with this email address: ${email}. The invite works once and expires on ${until}.\n`
    + `If you didn't expect this, ignore this email.`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1b1f1d;max-width:520px">
<p><strong>${esc(plain(inviter))}</strong> invited you to join the team <strong>“${esc(plain(team))}”</strong> on Dashboard.</p>
<p><a href="${esc(link)}" style="display:inline-block;background:#1f7a4d;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Join the team</a></p>
<p style="color:#555">Sign in, or create an account, with this email address: <strong>${esc(email)}</strong>. The invite works once and expires on ${esc(until)}.</p>
<p style="color:#888;font-size:13px">If the button doesn't work, copy this link: ${esc(link)}<br>If you didn't expect this, ignore this email.</p></div>`;
  return { subject, text, html };
}

async function sendEmail(cfg, msg, fetchImpl) {
  if (cfg.outbox) {
    const fs = await import('node:fs');
    fs.appendFileSync(cfg.outbox, JSON.stringify({ at: new Date().toISOString(), ...msg }) + '\n');
    return { ok: true };
  }
  let res;
  try {
    res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      signal: AbortSignal.timeout(7000),
      headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
  } catch {
    return { ok: false, reason: 'the email service could not be reached' };
  }
  let body = null;
  try { body = await res.json(); } catch { /* provider response was unreadable */ }
  if (res.ok) {
    return typeof body?.id === 'string' && body.id.trim()
      ? { ok: true }
      : { ok: false, reason: 'the email service did not confirm acceptance' };
  }
  const detail = body && (body.message || body.name) ? String(body.message || body.name).slice(0, 200) : '';
  return { ok: false, reason: `the email service refused it (HTTP ${res.status}${detail ? ': ' + detail : ''})` };
}

function rpcClient(env, token, fetchImpl) {
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '') + '/rest/v1/rpc/';
  return async (name, args) => {
    const res = await fetchImpl(base + name, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) throw Object.assign(new Error((body && body.message) || `HTTP ${res.status}`), { status: res.status, code: body && body.code });
    return body;
  };
}

// → { status, body } for the HTTP response.
export async function handleInvite({ method, headers, body }, env, fetchImpl = globalThis.fetch.bind(globalThis)) {
  if (method !== 'POST') return { status: 405, body: { message: 'Use POST.' } };
  const auth = String(headers.authorization || '');
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{10,4096})$/.exec(auth);
  if (!m) return { status: 401, body: { message: 'Sign in again to send invites.' } };
  let input = body;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = null; } }
  if (!input || typeof input !== 'object' || typeof input.team_id !== 'string' || typeof input.email !== 'string' || input.email.length > 320) {
    return { status: 400, body: { message: 'Enter the full email address.' } };
  }
  const cfg = emailConfig(env);
  const origin = appUrl(env);
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
    return { status: 503, body: { code: 'server_not_configured', message: 'The invite service isn’t set up (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY). No invitation was saved and no email was sent.' } };
  }
  const rpc = rpcClient(env, m[1], fetchImpl);

  let inv;
  try {
    inv = await rpc('team_invite_create', { p_team_id: input.team_id, p_email: input.email });
  } catch (e) {
    const status = e.status === 401 ? 401 : e.status === 403 ? 403 : e.status === 404 ? 404 : 400;
    const msg = /workspace_access_denied/.test(e.message) ? 'This account is blocked.' : e.message;
    return { status, body: { message: msg } };
  }

  const saved = { saved: true, expires_at: inv.expires_at };
  const link = origin ? `${origin}/#/invite/${inv.token}` : null;
  if (!cfg.ok || !origin) {
    return { status: 200, body: { ...saved, emailed: false, code: 'email_not_configured', missing: cfg.ok ? ['APP_URL'] : cfg.missing, invite_url: link, message: MISSING_EMAIL_MESSAGE } };
  }
  const sent = await sendEmail(cfg, { to: inv.email, ...inviteEmail({ inviter: inv.inviter_name, team: inv.team_name, link, email: inv.email, expiresAt: inv.expires_at }) }, fetchImpl);
  if (!sent.ok) {
    await rpc('team_invite_mark', { p_invite_id: inv.id, p_status: 'failed' }).catch(() => {});
    return { status: 200, body: { ...saved, emailed: false, code: 'email_failed', invite_url: link, message: `Invitation saved, but no email was sent: ${sent.reason}. ${IN_APP}` } };
  }
  await rpc('team_invite_mark', { p_invite_id: inv.id, p_status: 'sent' }).catch(() => {});
  return { status: 200, body: { ...saved, emailed: true, sent: true, message: 'Invite sent' } };
}
