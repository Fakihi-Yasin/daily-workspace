-- Daily Workspace — migration 8: private user directory, team invites by email, profiles,
-- unread team tasks, and Super Admin team deletion.
--
--   * Directory: only an active Super Admin can list accounts and their emails. team_member_directory,
--     team_member_candidates, team_add_member (by email, which told whether an email was registered)
--     and team_add_member_id now require super_admin; team_create_with_members accepts members from a
--     Super Admin only (everyone else creates a team with its name alone).
--   * Invites: a team owner invites a full email address. team_invite_create never looks at accounts,
--     so the answer is the same whether the email is registered or not. Only a SHA-256 hash of the
--     random token is stored. An invite works once, for 7 days, and only after the mailer marked it
--     sent; it is accepted only by a signed-in active account whose VERIFIED email is the invited one,
--     and adds that account to that team only. Roles are never changed.
--   * Profiles: each user edits their own display name and photo (an upload, or their Google photo).
--     Photos are only readable by the user, people who share a team with them, and Super Admins.
--   * Unread: public.team_task_seen keeps, per user and per team, when the user last saw the board.
--     team_unread counts tasks created by someone else after that (or after joining). Existing
--     memberships start "seen now", so nobody gets a badge for old tasks.
--   * Team delete: the owner (unchanged) or any active Super Admin. Every team deletion is written to
--     user_audit (who, team name, when, what was deleted).
-- Existing teams, memberships, roles, tasks and dashboards are not changed.

begin;

-- ---------------------------------------------------------------- 1. directory: Super Admin only
create or replace function public.team_member_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('super_admin');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.user_id, 'name', coalesce(nullif(u.display_name, ''), u.name), 'email', u.email, 'email_verified', u.email_verified)
           order by lower(coalesce(u.email, u.name, u.user_id)))
      from public.app_users u
     where u.status = 'active' and u.user_id <> me.user_id), '[]'::jsonb);
end;
$$;

create or replace function public.team_member_candidates(p_team_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('super_admin');
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can add members.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.user_id, 'name', coalesce(nullif(u.display_name, ''), u.name), 'email', u.email,
                                        'email_verified', u.email_verified, 'signed_up_at', u.signed_up_at)
           order by lower(coalesce(nullif(u.display_name, ''), nullif(u.name, ''), u.email, u.user_id)))
      from public.app_users u
     where u.status = 'active'
       and not exists (select 1 from public.team_members m where m.team_id = p_team_id and m.user_id = u.user_id)),
    '[]'::jsonb);
end;
$$;

create or replace function public.team_add_member_id(p_team_id uuid, p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('super_admin');
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can add members.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_users u where u.user_id = p_user_id and u.status = 'active') then
    raise exception 'No active account with that id.' using errcode = 'PT404';
  end if;
  if app_private.is_member(p_team_id, p_user_id) then
    raise exception 'Already a member of this team.' using errcode = 'P0001';
  end if;
  insert into public.team_members (team_id, user_id, added_by) values (p_team_id, p_user_id, me.user_id);
  perform app_private.log_team(p_team_id, me.user_id, 'member_added', (app_private.person(p_user_id)) ->> 'name');
  return app_private.person(p_user_id);
end;
$$;

-- Adding by email answers "no registered account", so it is a directory lookup: Super Admin only.
create or replace function public.team_add_member(p_team_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('super_admin');
  found_ids text[];
  target text;
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can add members.' using errcode = '42501';
  end if;
  select array_agg(u.user_id) into found_ids from public.app_users u
   where lower(u.email) = lower(btrim(p_email)) and u.email_verified and u.status = 'active';
  if found_ids is null then
    raise exception 'No registered account with that verified email. Ask them to sign up and confirm their email first.' using errcode = 'PT404';
  end if;
  if array_length(found_ids, 1) > 1 then
    raise exception 'Several accounts use that email. Ask a Super Admin to sort it out.' using errcode = 'P0001';
  end if;
  target := found_ids[1];
  if app_private.is_member(p_team_id, target) then
    raise exception 'Already a member of this team.' using errcode = 'P0001';
  end if;
  insert into public.team_members (team_id, user_id, added_by) values (p_team_id, target, me.user_id);
  perform app_private.log_team(p_team_id, me.user_id, 'member_added', (app_private.person(target)) ->> 'name');
  return app_private.person(target);
end;
$$;

create or replace function public.team_create_with_members(p_name text, p_member_ids jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  tid uuid;
  ids text[];
  bad text;
  m text;
begin
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Give the team a name (up to 80 characters).' using errcode = '22023';
  end if;
  if p_member_ids is not null and jsonb_typeof(p_member_ids) <> 'array' then
    raise exception 'Members must be a list of account ids.' using errcode = '22023';
  end if;
  ids := array(select distinct x from jsonb_array_elements_text(coalesce(p_member_ids, '[]'::jsonb)) x where x <> me.user_id);
  -- Picking accounts needs the directory, which only a Super Admin has. Others invite by email.
  if coalesce(array_length(ids, 1), 0) > 0 and me.role <> 'super_admin' then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  if array_length(ids, 1) > 200 then
    raise exception 'Add at most 200 members at a time.' using errcode = '22023';
  end if;
  select string_agg(x, ', ') into bad from unnest(ids) x
   where not exists (select 1 from public.app_users u where u.user_id = x and u.status = 'active');
  if bad is not null then
    raise exception 'Some selected accounts are blocked or no longer exist. Refresh the list and try again.' using errcode = 'PT404';
  end if;
  perform app_private.assert_team_name_free(me.user_id, p_name, null);
  insert into public.teams (name, owner_id) values (btrim(p_name), me.user_id) returning id into tid;
  insert into public.team_members (team_id, user_id, added_by) values (tid, me.user_id, me.user_id);
  perform app_private.log_team(tid, me.user_id, 'team_created', btrim(p_name));
  foreach m in array ids loop
    insert into public.team_members (team_id, user_id, added_by) values (tid, m, me.user_id);
    perform app_private.log_team(tid, me.user_id, 'member_added', (app_private.person(m)) ->> 'name');
  end loop;
  return jsonb_build_object('id', tid, 'members_added', coalesce(array_length(ids, 1), 0));
end;
$$;

-- ---------------------------------------------------------------- 2. profiles
alter table public.app_users
  add column display_name   text,
  add column photo_kind     text,
  add column photo_url      text,
  add column photo_at       timestamptz,
  add constraint app_users_display_name_len check (display_name is null or length(display_name) between 1 and 80),
  add constraint app_users_photo_kind_valid check (photo_kind is null or photo_kind in ('upload', 'google')),
  add constraint app_users_photo_url_len    check (photo_url is null or length(photo_url) <= 1000);

-- Uploaded photos (small, resized in the browser), apart from app_users so listings stay light.
create table public.user_photos (
  user_id     text        primary key references public.app_users (user_id) on delete cascade,
  data        text        not null,
  updated_at  timestamptz not null default now(),
  constraint user_photos_data_valid check (length(data) <= 400000 and data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')
);
revoke all on table public.user_photos from public, anon, authenticated;
alter table public.user_photos enable row level security;

-- Display name first; 'photo_v' changes whenever the photo does (null = show initials).
create or replace function app_private.person(p_user text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p_user is null then null else
    coalesce((select jsonb_build_object('id', u.user_id,
                                        'name', coalesce(nullif(u.display_name, ''), nullif(u.name, ''), u.email, 'Unknown'),
                                        'email', u.email,
                                        'photo_v', case when u.photo_kind is not null then (extract(epoch from u.photo_at) * 1000)::bigint::text end)
                from public.app_users u where u.user_id = p_user),
             jsonb_build_object('id', p_user, 'name', 'Unknown', 'email', null, 'photo_v', null)) end;
$$;

create or replace function app_private.profile_json(u public.app_users)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', u.user_id, 'display_name', u.display_name, 'sign_in_name', u.name, 'email', u.email,
                            'email_verified', u.email_verified, 'photo_kind', u.photo_kind,
                            'name', coalesce(nullif(u.display_name, ''), nullif(u.name, ''), u.email, 'Unknown'),
                            'photo_v', case when u.photo_kind is not null then (extract(epoch from u.photo_at) * 1000)::bigint::text end);
$$;

create function public.profile_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  return app_private.profile_json(me);
end;
$$;

-- Empty or null clears it (the name from sign-in is shown again).
create function public.profile_set_name(p_display_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
  n text := nullif(regexp_replace(btrim(coalesce(p_display_name, '')), '\s+', ' ', 'g'), '');
begin
  if n is not null and length(n) > 80 then
    raise exception 'Keep the display name to 80 characters.' using errcode = '22023';
  end if;
  update public.app_users set display_name = n where user_id = me.user_id returning * into me;
  return app_private.profile_json(me);
end;
$$;

create function public.profile_set_photo(p_data text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  if p_data is null or length(p_data) > 400000 or p_data !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' then
    raise exception 'Use a JPEG, PNG or WebP image (the app shrinks it before upload).' using errcode = '22023';
  end if;
  insert into public.user_photos (user_id, data, updated_at) values (me.user_id, p_data, now())
  on conflict (user_id) do update set data = excluded.data, updated_at = now();
  update public.app_users set photo_kind = 'upload', photo_url = null, photo_at = clock_timestamp() where user_id = me.user_id returning * into me;
  return app_private.profile_json(me);
end;
$$;

-- The Google photo from the user's own sign-in profile. Only Google accounts, only Google's image host.
create function public.profile_use_google_photo(p_url text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  if me.user_id not like 'google-oauth2|%' then
    raise exception 'Only an account that signs in with Google has a Google photo.' using errcode = '22023';
  end if;
  if p_url is null or length(p_url) > 1000 or p_url !~ '^https://lh[0-9]+\.googleusercontent\.com/[A-Za-z0-9_/=.%~+-]+$' then
    raise exception 'That isn''t a Google profile photo address.' using errcode = '22023';
  end if;
  delete from public.user_photos where user_id = me.user_id;
  update public.app_users set photo_kind = 'google', photo_url = p_url, photo_at = clock_timestamp() where user_id = me.user_id returning * into me;
  return app_private.profile_json(me);
end;
$$;

create function public.profile_remove_photo()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  delete from public.user_photos where user_id = me.user_id;
  update public.app_users set photo_kind = null, photo_url = null, photo_at = clock_timestamp() where user_id = me.user_id returning * into me;
  return app_private.profile_json(me);
end;
$$;

-- Photos of: yourself, people who share a team with you, anyone for a Super Admin. Others are left out.
create function public.profile_photos(p_ids jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  if p_ids is null or jsonb_typeof(p_ids) <> 'array' or jsonb_array_length(p_ids) > 200 then
    raise exception 'Pass a list of up to 200 account ids.' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_object_agg(u.user_id, case when u.photo_kind = 'google' then u.photo_url else ph.data end)
      from public.app_users u
      left join public.user_photos ph on ph.user_id = u.user_id
     where u.user_id in (select jsonb_array_elements_text(p_ids))
       and u.photo_kind is not null
       and (u.user_id = me.user_id or me.role = 'super_admin'
            or exists (select 1 from public.team_members a join public.team_members b on b.team_id = a.team_id
                        where a.user_id = me.user_id and b.user_id = u.user_id))
       and (u.photo_kind = 'google' or ph.data is not null)), '{}'::jsonb);
end;
$$;

-- register_me: same as before, plus the profile fields the app shows (display name, photo version).
create or replace function public.register_me()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  claims jsonb := auth.jwt();
  ns text := 'https://daily-workspace/';
  uid text := nullif(claims ->> 'sub', '');
  c_email text := nullif(btrim(claims ->> (ns || 'email')), '');
  c_verified boolean := coalesce((claims ->> (ns || 'email_verified'))::boolean, false);
  c_name text := nullif(btrim(claims ->> (ns || 'name')), '');
  c_created timestamptz;
  u public.app_users;
begin
  if uid is null or length(uid) < 3 then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  begin
    c_created := (claims ->> (ns || 'created_at'))::timestamptz;
  exception when others then
    c_created := null;
  end;
  if c_created is null or c_created > now() then c_created := now(); end if;

  insert into public.app_users as a (user_id, email, email_verified, name, role, signed_up_at, last_seen_at)
  values (uid, left(c_email, 320), c_verified and c_email is not null, left(c_name, 200), 'admin', c_created, now())
  on conflict (user_id) do update
     set email          = coalesce(excluded.email, a.email),
         email_verified = case when excluded.email is not null then excluded.email_verified else a.email_verified end,
         name           = coalesce(excluded.name, a.name),
         signed_up_at   = least(a.signed_up_at, excluded.signed_up_at),
         last_seen_at   = now()
  returning * into u;

  return jsonb_build_object('user_id', u.user_id, 'role', u.role, 'status', u.status, 'name', u.name, 'email', u.email)
      || jsonb_build_object('profile', app_private.profile_json(u));
end;
$$;

-- Users page: the shown name is the display name when the user set one; photo version for avatars.
create or replace function public.admin_list_users()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_access('super_admin');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'user_id', u.user_id, 'name', coalesce(nullif(u.display_name, ''), u.name), 'sign_in_name', u.name,
             'email', u.email, 'email_verified', u.email_verified,
             'photo_v', case when u.photo_kind is not null then (extract(epoch from u.photo_at) * 1000)::bigint::text end,
             'role', u.role, 'status', u.status, 'signed_up_at', u.signed_up_at, 'last_seen_at', u.last_seen_at,
             'role_changed_at', u.role_changed_at, 'role_changed_by', app_private.person(u.role_changed_by),
             'status_changed_at', u.status_changed_at, 'status_changed_by', app_private.person(u.status_changed_by))
           order by u.signed_up_at desc)
      from public.app_users u), '[]'::jsonb);
end;
$$;

-- A Super Admin's name edit is the display name (a sign-in no longer overwrites it).
create or replace function public.admin_update_user(p_user_id text, p_name text, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('super_admin');
  t public.app_users;
  n text := nullif(btrim(p_name), '');
  e text := lower(nullif(btrim(p_email), ''));
  old_name text;
begin
  select * into t from public.app_users where user_id = p_user_id for update;
  if not found then raise exception 'User not found' using errcode = 'PT404'; end if;
  if n is not null and length(n) > 80 then
    raise exception 'The name is too long (80 characters at most).' using errcode = '22023';
  end if;
  if e is not null and (length(e) > 320 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'That doesn''t look like an email address.' using errcode = '22023';
  end if;
  old_name := coalesce(nullif(t.display_name, ''), t.name);
  update public.app_users
     set display_name = n,
         name = coalesce(n, name),
         email = e,
         email_verified = (e is not null)
   where user_id = t.user_id;
  insert into public.user_audit (actor_id, target_id, action, old_value, new_value)
  values (me.user_id, t.user_id, 'profile',
          left(coalesce(old_name, '—') || ' <' || coalesce(t.email, '—') || '>', 600),
          left(coalesce(n, '—') || ' <' || coalesce(e, '—') || '>', 600));
  return jsonb_build_object('user_id', t.user_id, 'name', n, 'email', e);
end;
$$;

-- ---------------------------------------------------------------- 3. invites by email
create table public.team_invites (
  id           uuid        primary key default gen_random_uuid(),
  team_id      uuid        not null references public.teams (id) on delete cascade,
  email        text        not null,
  token_hash   text        not null unique,
  invited_by   text        not null references public.app_users (user_id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '7 days',
  status       text        not null default 'created',
  sent_at      timestamptz,
  accepted_at  timestamptz,
  accepted_by  text        references public.app_users (user_id) on delete set null,
  constraint team_invites_status_valid check (status in ('created', 'sent', 'failed', 'revoked', 'accepted')),
  constraint team_invites_email_valid  check (length(email) <= 320 and email = lower(email))
);
create index team_invites_team_idx on public.team_invites (team_id, created_at desc);
create index team_invites_inviter_idx on public.team_invites (invited_by, created_at desc);
revoke all on table public.team_invites from public, anon, authenticated;
alter table public.team_invites enable row level security;

create function app_private.token_hash(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

-- Owner only. Never reads accounts: the same answer whether the email is registered or not.
-- Returns the raw token once, to the mailer (/api/invite), which emails the link and then calls
-- team_invite_mark. An invite that was never marked 'sent' can't be accepted.
create function public.team_invite_create(p_team_id uuid, p_email text)
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
  -- A new invite to the same address replaces the previous one.
  update public.team_invites set status = 'revoked'
   where team_id = p_team_id and email = e and status in ('created', 'sent');
  -- Two random UUIDs: 244 random bits, 64 hex characters.
  tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.team_invites (team_id, email, token_hash, invited_by)
  values (p_team_id, e, app_private.token_hash(tok), me.user_id) returning * into inv;
  return jsonb_build_object('id', inv.id, 'token', tok, 'email', e, 'expires_at', inv.expires_at,
                            'team_name', t.name, 'inviter_name', (app_private.person(me.user_id)) ->> 'name');
end;
$$;

-- The mailer reports the outcome: 'sent' once the email provider accepted the message, else 'failed'.
create function public.team_invite_mark(p_invite_id uuid, p_status text)
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
  if inv.status <> 'created' then raise exception 'This invite was already handled.' using errcode = 'P0001'; end if;
  update public.team_invites set status = p_status, sent_at = case when p_status = 'sent' then now() end where id = inv.id;
  if p_status = 'sent' then
    perform app_private.log_team(inv.team_id, me.user_id, 'member_invited', inv.email);
  end if;
  return jsonb_build_object('id', inv.id, 'status', p_status);
end;
$$;

create function public.team_invite_list(p_team_id uuid)
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
    select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'sent_at', i.sent_at, 'expires_at', i.expires_at)
           order by i.sent_at desc)
      from public.team_invites i
     where i.team_id = p_team_id and i.status = 'sent' and i.expires_at > now()), '[]'::jsonb);
end;
$$;

create function public.team_invite_revoke(p_invite_id uuid)
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
  if inv.status in ('created', 'sent') then
    update public.team_invites set status = 'revoked' where id = inv.id;
  end if;
  return jsonb_build_object('id', inv.id, 'status', 'revoked');
end;
$$;

create function app_private.mask_email(e text)
returns text language sql immutable set search_path = '' as $$
  select case when e is null or position('@' in e) = 0 then e
         else left(split_part(e, '@', 1), 1) || repeat('•', greatest(length(split_part(e, '@', 1)) - 1, 2)) || '@' || split_part(e, '@', 2) end;
$$;

-- What the invite page shows to the signed-in person who opened the link.
create function public.team_invite_peek(p_token text)
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
  st := case when inv.status = 'accepted' then 'used' when inv.status = 'revoked' then 'revoked'
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

-- Joins the invited team only. Single use; the account's role is never changed.
create function public.team_invite_accept(p_token text)
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
  if not found or inv.status in ('created', 'failed') then
    raise exception 'This invite link isn''t valid.' using errcode = 'PT404';
  end if;
  if inv.status = 'accepted' then raise exception 'This invite was already used.' using errcode = 'P0001'; end if;
  if inv.status = 'revoked' then raise exception 'This invite was cancelled. Ask the team owner for a new one.' using errcode = 'P0001'; end if;
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
    -- New member: the board's existing tasks aren't "new" for them.
    insert into public.team_task_seen (user_id, team_id, seen_at) values (me.user_id, inv.team_id, now())
    on conflict (user_id, team_id) do update set seen_at = greatest(public.team_task_seen.seen_at, excluded.seen_at);
    perform app_private.log_team(inv.team_id, me.user_id, 'invite_accepted', (app_private.person(me.user_id)) ->> 'name');
  end if;
  return jsonb_build_object('team_id', inv.team_id);
end;
$$;

-- ---------------------------------------------------------------- 4. unread team tasks
create table public.team_task_seen (
  user_id  text        not null references public.app_users (user_id) on delete cascade,
  team_id  uuid        not null references public.teams (id) on delete cascade,
  seen_at  timestamptz not null,
  primary key (user_id, team_id)
);
create index team_task_seen_team_idx on public.team_task_seen (team_id);
create index team_tasks_team_created_idx on public.team_tasks (team_id, created_at);
revoke all on table public.team_task_seen from public, anon, authenticated;
alter table public.team_task_seen enable row level security;

-- Existing memberships: everything already on the boards counts as seen.
insert into public.team_task_seen (user_id, team_id, seen_at)
select m.user_id, m.team_id, now() from public.team_members m
on conflict do nothing;

-- Tasks created by someone else, after I last opened the board (or joined), in teams I'm a member of.
create function public.team_unread()
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
                              'teams', coalesce(jsonb_object_agg(x.team_id, x.n) filter (where x.n > 0), '{}'::jsonb))
      from (select m.team_id,
                   (select count(*) from public.team_tasks k
                     where k.team_id = m.team_id and k.created_by <> me.user_id
                       and k.created_at > coalesce(s.seen_at, m.added_at))::int as n
              from public.team_members m
              left join public.team_task_seen s on s.user_id = me.user_id and s.team_id = m.team_id
             where m.user_id = me.user_id) x);
end;
$$;

-- Called when the board has loaded: p_upto is the 'loaded_at' that team_get returned.
create function public.team_mark_seen(p_team_id uuid, p_upto timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  acc text := app_private.team_access(p_team_id, me);
  at timestamptz := least(coalesce(p_upto, now()), now());
begin
  if acc in ('owner', 'member') then
    insert into public.team_task_seen (user_id, team_id, seen_at) values (me.user_id, p_team_id, at)
    on conflict (user_id, team_id) do update set seen_at = greatest(public.team_task_seen.seen_at, excluded.seen_at);
  end if;
  return jsonb_build_object('team_id', p_team_id);
end;
$$;

-- team_get: unchanged, plus 'loaded_at' (the server time of this read).
create or replace function public.team_get(p_team_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  acc text := app_private.team_access(p_team_id, me);
  t public.teams;
begin
  select * into t from public.teams where id = p_team_id;
  return jsonb_build_object(
    'loaded_at', now(),
    'team', jsonb_build_object('id', t.id, 'name', t.name, 'created_at', t.created_at, 'owner', app_private.person(t.owner_id)),
    'me', jsonb_build_object('id', me.user_id, 'access', acc),
    'members', coalesce((
      select jsonb_agg(app_private.person(m.user_id) || jsonb_build_object('owner', m.user_id = t.owner_id, 'added_at', m.added_at)
                       order by (m.user_id = t.owner_id) desc, m.added_at)
        from public.team_members m where m.team_id = t.id), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id, 'title', k.title, 'status', k.status, 'due_date', k.due_date,
               'assignee', app_private.person(k.assignee_id), 'created_by', app_private.person(k.created_by),
               'created_at', k.created_at, 'updated_at', k.updated_at, 'completed_at', k.completed_at)
             order by k.due_date nulls last, k.created_at)
        from public.team_tasks k where k.team_id = t.id), '[]'::jsonb),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'notes', p.notes, 'created_at', p.created_at,
                                          'moved_at', p.moved_at, 'moved_task_id', p.moved_task_id)
             order by p.moved_at nulls first, p.created_at)
        from public.team_future_projects p where p.team_id = t.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.at, 'action', e.action, 'detail', e.detail, 'actor', app_private.person(e.actor_id)) order by e.at desc, e.id desc)
        from (select * from public.team_events where team_id = t.id order by at desc, id desc limit 40) e), '[]'::jsonb));
end;
$$;

-- team_list: unchanged, plus 'tasks' (all tasks) and 'projects' (planned) for the delete confirmation.
create or replace function public.team_list(p_scope text default 'mine')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_active();
begin
  if p_scope = 'all' and me.role <> 'super_admin' then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', t.id, 'name', t.name, 'created_at', t.created_at,
             'owner', app_private.person(t.owner_id),
             'my_role', case when t.owner_id = me.user_id then 'owner' when m.user_id is not null then 'member' else null end,
             'members', (select count(*) from public.team_members x where x.team_id = t.id),
             'tasks', (select count(*) from public.team_tasks k where k.team_id = t.id),
             'projects', (select count(*) from public.team_future_projects p where p.team_id = t.id and p.moved_at is null),
             'open', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status <> 'done'),
             'blocked', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status = 'blocked'),
             'done', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status = 'done'))
           order by lower(t.name))
      from public.teams t
      left join public.team_members m on m.team_id = t.id and m.user_id = me.user_id
     where p_scope = 'all' or m.user_id is not null), '[]'::jsonb);
end;
$$;

-- New members added directly (Super Admin) also start with the existing board seen.
create function app_private.member_seen_baseline()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.team_task_seen (user_id, team_id, seen_at) values (new.user_id, new.team_id, now())
  on conflict (user_id, team_id) do nothing;
  return new;
end;
$$;
create trigger team_members_seen_baseline after insert on public.team_members
  for each row execute function app_private.member_seen_baseline();

-- ---------------------------------------------------------------- 5. team delete: owner or Super Admin, audited
alter table public.user_audit drop constraint user_audit_action_valid;
alter table public.user_audit add constraint user_audit_action_valid
  check (action in ('role', 'status', 'bootstrap', 'backfill', 'profile', 'delete', 'team_delete'));

create or replace function public.team_delete(p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  t public.teams;
  acc text;
  n_tasks int; n_members int; n_projects int;
begin
  -- Same rule for owners as before (an Admin or Super Admin who owns the team); plus any Super Admin.
  acc := app_private.team_access(p_team_id, me);
  if not (acc = 'owner' or me.role = 'super_admin') then
    raise exception 'Only the team owner can delete the team.' using errcode = '42501';
  end if;
  select * into t from public.teams where id = p_team_id for update;
  select count(*) into n_tasks from public.team_tasks where team_id = t.id;
  select count(*) into n_members from public.team_members where team_id = t.id;
  select count(*) into n_projects from public.team_future_projects where team_id = t.id;
  delete from public.teams where id = t.id;
  insert into public.user_audit (actor_id, target_id, action, old_value, new_value)
  values (me.user_id, t.id::text, 'team_delete', left(t.name, 200),
          n_tasks || ' task(s), ' || n_projects || ' future project(s), ' || n_members || ' member(s); owner ' ||
          left(coalesce((app_private.person(t.owner_id)) ->> 'name', t.owner_id), 200));
  return jsonb_build_object('deleted', p_team_id, 'tasks', n_tasks, 'members', n_members);
end;
$$;

create or replace function public.admin_audit(p_limit int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app_private.require_access('super_admin');
  return coalesce((
    select jsonb_agg(x order by (x ->> 'at') desc) from (
      select jsonb_build_object('at', a.at, 'action', a.action, 'old', a.old_value, 'new', a.new_value,
                                'actor', app_private.person(a.actor_id),
                                'target', case when a.action = 'delete' then jsonb_build_object('id', a.target_id, 'name', split_part(a.old_value, ' <', 1))
                                               when a.action = 'team_delete' then jsonb_build_object('id', a.target_id, 'name', a.old_value, 'team', true)
                                               else app_private.person(a.target_id) end) as x
        from public.user_audit a
       order by a.at desc, a.id desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200)) s), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- privileges
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname as ns
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'app_private' and p.proname in ('profile_json', 'token_hash', 'mask_email', 'member_seen_baseline'))
               or (n.nspname = 'public' and p.proname in ('profile_get', 'profile_set_name', 'profile_set_photo', 'profile_use_google_photo',
                   'profile_remove_photo', 'profile_photos', 'team_invite_create', 'team_invite_mark', 'team_invite_list',
                   'team_invite_revoke', 'team_invite_peek', 'team_invite_accept', 'team_unread', 'team_mark_seen'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.ns = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- create or replace keeps grants; check that nothing became callable by signed-out visitors.
do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like any (array['team\_%', 'admin\_%', 'profile\_%', 'register_me'])
     and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'Unexpected function privileges: %', bad; end if;
end $$;

commit;
