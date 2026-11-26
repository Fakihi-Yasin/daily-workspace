// Vercel Function: POST /api/invite  { team_id, email }  with the user's Auth0 access token.
// See api/_invite.mjs. Env: RESEND_API_KEY, INVITE_FROM_EMAIL (e.g. "Dashboard <invites@your-domain>"),
// SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and optionally APP_URL (defaults to the production URL).
import { handleInvite } from './_invite.mjs';

export default async function handler(req, res) {
  const r = await handleInvite({ method: req.method, headers: req.headers, body: req.body }, process.env);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(r.status).send(JSON.stringify(r.body));
}
