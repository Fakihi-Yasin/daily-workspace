-- Daily Workspace — migration 9: in-app team invitations (no email provider needed).
--
-- An invite is addressed to an EMAIL, not to an account. team_invite_create still never looks up
-- accounts, so a regular Admin learns nothing about who is registered. Every signed-in account whose
-- VERIFIED email equals the invited address sees the invite under Team Work → Invitations (now, or
-- after signing up with that email) and joins only by clicking Accept. If an email provider is set up,
-- the link is also emailed (status 'sent'); without one it stays 'pending' and works in the app.
--   * Statuses: 'pending' (usable in the app), 'sent' (also emailed), 'accepted', 'declined',
--     'revoked'; 'created' / 'failed' (migration 8) are no longer produced.
--   * Same rules as before: 7 days, single use, verified matching email, that team only, role unchanged.
-- No existing team, membership, role or task is changed.

begin;

alter table public.team_invites drop constraint team_invites_status_valid;
alter table public.team_invites add constraint team_invites_status_valid
  check (status in ('created', 'pending', 'sent', 'failed', 'revoked', 'accepted', 'declined'));
alter table public.team_invites alter column status set default 'pending';
alter table public.team_invites add column declined_at timestamptz;
create index team_invites_email_idx on public.team_invites (email) where status in ('pending', 'sent');

-- Invites created before this migration that were never emailed become usable in the app.
update public.team_invites set status = 'pending' where status in ('created', 'failed');

create or replace function public.team_invite_create(p_team_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  e text := lower(btrim(coalesce(p_email, '')));
  t public.teams;
  tok text;
  inv public.team_invites;
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can invite people.' using errcode = '42501';
  end if;
  if length(e) > 254 or e !~ '^[^@\s<>",;]+@[^@\s<>",;]+\.[a-z]{2,}$' then
    raise exception 'Enter the full email address, like name@example.com.' using errcode = '22023';
  end if;
  -- Members' emails are already shown to the owner in People, so this reveals nothing new.
  if exists (select 1 from public.team_members m join public.app_users u on u.user_id = m.user_id
              where m.team_id = p_team_id and lower(u.email) = e) then
    raise exception 'Someone with that email is already in this team.' using errcode = 'P0001';
  end if;
  if (select count(*) from public.team_invites i where i.invited_by = me.user_id and i.created_at > now() - interval '24 hours') >= 50 then
    raise exception 'You sent a lot of invites today. Try again tomorrow.' using errcode = 'P0001';
  end if;
  select * into t from public.teams where id = p_team_id;
  update public.team_invites set status = 'revoked'
   where team_id = p_team_id and email = e and status in ('created', 'pending', 'sent');
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.team_invites (team_id, email, token_hash, invited_by, status)
  values (p_team_id, e, app_private.token_hash(tok), me.user_id, 'pending') returning * into inv;
  perform app_private.log_team(p_team_id, me.user_id, 'member_invited', e);
  return jsonb_build_object('id', inv.id, 'token', tok, 'email', e, 'expires_at', inv.expires_at,
                            'team_name', t.name, 'inviter_name', (app_private.person(me.user_id)) ->> 'name');
end;
$$;

-- The mailer reports the outcome. 'sent': the email went out. 'failed': it didn't; the invite stays
-- pending and still works in the app.
create or replace function public.team_invite_mark(p_invite_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  inv public.team_invites;
begin
  if p_status not in ('sent', 'failed') then raise exception 'Unknown status' using errcode = '22023'; end if;
  select * into inv from public.team_invites where id = p_invite_id for update;
  if not found or inv.invited_by <> me.user_id then raise exception 'Invite not found' using errcode = 'PT404'; end if;
  if p_status = 'sent' and inv.status = 'pending' then
    update public.team_invites set status = 'sent', sent_at = now() where id = inv.id;
    return jsonb_build_object('id', inv.id, 'status', 'sent');
  end if;
  return jsonb_build_object('id', inv.id, 'status', inv.status);
end;
$$;

create or replace function public.team_invite_list(p_team_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin');
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can see invites.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'created_at', i.created_at, 'sent_at', i.sent_at,
                                        'emailed', i.status = 'sent', 'expires_at', i.expires_at)
           order by i.created_at desc)
      from public.team_invites i
     where i.team_id = p_team_id and i.status in ('pending', 'sent') and i.expires_at > now()), '[]'::jsonb);
end;
$$;

create or replace function public.team_invite_revoke(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  inv public.team_invites;
begin
  select * into inv from public.team_invites where id = p_invite_id for update;
  if not found then raise exception 'Invite not found' using errcode = 'PT404'; end if;
  if app_private.team_access(inv.team_id, me) <> 'owner' then
    raise exception 'Only the team owner can cancel invites.' using errcode = '42501';
  end if;
  if inv.status in ('created', 'pending', 'sent') then
    update public.team_invites set status = 'revoked' where id = inv.id;
  end if;
  return jsonb_build_object('id', inv.id, 'status', 'revoked');
end;
$$;

-- One rule for accepting, whether from the emailed link or from Team Work → Invitations.
create function app_private.invite_join(inv public.team_invites, me public.app_users)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if inv.status = 'accepted' then raise exception 'This invite was already used.' using errcode = 'P0001'; end if;
  if inv.status = 'declined' then raise exception 'This invite was declined. Ask the team owner for a new one.' using errcode = 'P0001'; end if;
  if inv.status = 'revoked' then raise exception 'This invite was cancelled. Ask the team owner for a new one.' using errcode = 'P0001'; end if;
  if inv.status not in ('pending', 'sent') then raise exception 'This invite link isn''t valid.' using errcode = 'PT404'; end if;
  if inv.expires_at <= now() then raise exception 'This invite has expired. Ask the team owner for a new one.' using errcode = 'P0001'; end if;
  if lower(coalesce(me.email, '')) <> inv.email then
    raise exception 'This invite is for a different email address. Sign in with the email it was sent to.' using errcode = '42501';
  end if;
  if not me.email_verified then
    raise exception 'Confirm your email address first, then try again.' using errcode = '42501';
  end if;
  update public.team_invites set status = 'accepted', accepted_at = now(), accepted_by = me.user_id where id = inv.id;
  if not app_private.is_member(inv.team_id, me.user_id) then
    insert into public.team_members (team_id, user_id, added_by) values (inv.team_id, me.user_id, inv.invited_by);
    perform app_private.log_team(inv.team_id, me.user_id, 'invite_accepted', (app_private.person(me.user_id)) ->> 'name');
  end if;
  return jsonb_build_object('team_id', inv.team_id);
end;
$$;

create or replace function public.team_invite_accept(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  inv public.team_invites;
begin
  select * into inv from public.team_invites where token_hash = app_private.token_hash(p_token) for update;
  if not found then raise exception 'This invite link isn''t valid.' using errcode = 'PT404'; end if;
  return app_private.invite_join(inv, me);
end;
$$;

create or replace function public.team_invite_peek(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  inv public.team_invites;
  t public.teams;
  st text;
begin
  select * into inv from public.team_invites where token_hash = app_private.token_hash(p_token);
  if not found or inv.status in ('created', 'failed') then
    return jsonb_build_object('state', 'invalid');
  end if;
  select * into t from public.teams where id = inv.team_id;
  st := case when inv.status = 'accepted' then 'used' when inv.status in ('revoked', 'declined') then 'revoked'
             when inv.expires_at <= now() then 'expired' else 'ok' end;
  if st <> 'ok' then
    return jsonb_build_object('state', st, 'team_name', t.name);
  end if;
  return jsonb_build_object('state', 'ok', 'team_id', t.id, 'team_name', t.name,
    'inviter_name', (app_private.person(inv.invited_by)) ->> 'name', 'expires_at', inv.expires_at,
    'invited_email', app_private.mask_email(inv.email),
    'my_email', me.email, 'my_email_verified', me.email_verified,
    'email_matches', lower(coalesce(me.email, '')) = inv.email,
    'already_member', app_private.is_member(t.id, me.user_id));
end;
$$;

-- Team Work → Invitations: open invites for the caller's own verified email. Nothing is shown for an
-- unconfirmed email except that confirming it is needed (only to the account holder).
create function public.my_invites()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  e text := lower(coalesce(me.email, ''));
  waiting int;
begin
  if e = '' then return jsonb_build_object('email_verified', false, 'waiting', 0, 'invites', '[]'::jsonb); end if;
  if not me.email_verified then
    select count(*) into waiting from public.team_invites i
     where i.email = e and i.status in ('pending', 'sent') and i.expires_at > now();
    return jsonb_build_object('email_verified', false, 'waiting', waiting, 'invites', '[]'::jsonb);
  end if;
  return jsonb_build_object('email_verified', true, 'invites', coalesce((
    select jsonb_agg(jsonb_build_object('id', i.id, 'team_id', t.id, 'team_name', t.name,
                                        'inviter', app_private.person(i.invited_by), 'invited_at', i.created_at,
                                        'expires_at', i.expires_at)
           order by i.created_at desc)
      from public.team_invites i join public.teams t on t.id = i.team_id
     where i.email = e and i.status in ('pending', 'sent') and i.expires_at > now()
       and not app_private.is_member(t.id, me.user_id)), '[]'::jsonb));
end;
$$;

create function public.my_invite_accept(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  inv public.team_invites;
begin
  select * into inv from public.team_invites where id = p_invite_id for update;
  -- Someone else's invite looks exactly like one that doesn't exist.
  if not found or inv.email <> lower(coalesce(me.email, '')) then raise exception 'Invite not found' using errcode = 'PT404'; end if;
  return app_private.invite_join(inv, me);
end;
$$;

create function public.my_invite_decline(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  inv public.team_invites;
begin
  select * into inv from public.team_invites where id = p_invite_id for update;
  if not found or inv.email <> lower(coalesce(me.email, '')) or not me.email_verified then
    raise exception 'Invite not found' using errcode = 'PT404';
  end if;
  if inv.status in ('pending', 'sent') then
    update public.team_invites set status = 'declined', declined_at = now() where id = inv.id;
    perform app_private.log_team(inv.team_id, me.user_id, 'invite_declined', inv.email);
  end if;
  return jsonb_build_object('id', inv.id, 'status', 'declined');
end;
$$;

-- team_unread also reports open invitations (shown on Team Work's sidebar link).
create or replace function public.team_unread()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_active();
begin
  return (
    select jsonb_build_object('total', coalesce(sum(x.n), 0)::int,
                              'teams', coalesce(jsonb_object_agg(x.team_id, x.n) filter (where x.n > 0), '{}'::jsonb),
                              'invites', (select count(*) from public.team_invites i
                                           where me.email_verified and i.email = lower(coalesce(me.email, ''))
                                             and i.status in ('pending', 'sent') and i.expires_at > now()
                                             and not app_private.is_member(i.team_id, me.user_id))::int)
      from (select m.team_id,
                   (select count(*) from public.team_tasks k
                     where k.team_id = m.team_id and k.created_by <> me.user_id
                       and k.created_at > coalesce(s.seen_at, m.added_at))::int as n
              from public.team_members m
              left join public.team_task_seen s on s.user_id = me.user_id and s.team_id = m.team_id
             where m.user_id = me.user_id) x);
end;
$$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname as ns
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'app_private' and p.proname = 'invite_join')
               or (n.nspname = 'public' and p.proname in ('my_invites', 'my_invite_accept', 'my_invite_decline'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.ns = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like any (array['team\_%', 'my\_%', 'profile\_%'])
     and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'Unexpected function privileges: %', bad; end if;
end $$;

commit;
