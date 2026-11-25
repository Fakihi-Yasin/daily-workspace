-- Daily Workspace — migration 2: user roles, user management, private teams (Team Work).
--
-- Identity: the Auth0 user id (JWT `sub`) is the only key used for permissions. Name and email are
-- display data copied from signed Auth0 token claims; they are never used to decide access.
--
-- Roles (public.app_users.role)
--   user         default for every new signup: "Waiting for access", no workspace, no Team Work.
--   admin        personal workspace + Team Work for teams they own or have joined.
--   super_admin  admin features + User Management + read access to every team.
-- Status: 'active' or 'blocked'. A blocked account is refused on its next request, whatever its role.
--
-- Access model
--   * The new tables have row-level security enabled and NO policies and NO grants for anon or
--     authenticated: they cannot be read or written through the Data API directly.
--   * Every read and write goes through the public functions below. They are SECURITY DEFINER with
--     an empty search_path, take the caller from auth.jwt() ->> 'sub' (never from a parameter), and
--     check role, blocked status and team membership on every call.
--   * Personal snapshots (migration 1) now also require an active admin/super_admin account: the
--     RLS policies and save_snapshot() check it, and reads go through get_snapshot(), which refuses
--     a blocked or waiting account with an explicit error instead of an empty result.
--   * Shared team data lives in its own tables, never inside personal snapshots.
--
-- Rollout
--   * Every account that already has a synced snapshot is registered as 'admin' (it already had
--     workspace access), so existing users keep their dashboard. Nobody is made Super Admin here.
--   * The first Super Admin is set explicitly afterwards, from the SQL editor, with their verified
--     Auth0 user id:   select app_private.bootstrap_super_admin('auth0|…');
--     (see DEPLOY.md). It refuses to run once an active Super Admin exists.

begin;

-- ---------------------------------------------------------------- private helpers (not in the Data API)
create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

-- ---------------------------------------------------------------- tables
create table public.app_users (
  user_id            text        primary key,
  email              text,
  email_verified     boolean     not null default false,
  name               text,
  role               text        not null default 'user',
  status             text        not null default 'active',
  signed_up_at       timestamptz not null default now(),
  last_seen_at       timestamptz,
  role_changed_at    timestamptz,
  role_changed_by    text,
  status_changed_at  timestamptz,
  status_changed_by  text,
  constraint app_users_id_valid     check (length(user_id) between 3 and 255),
  constraint app_users_role_valid   check (role in ('user', 'admin', 'super_admin')),
  constraint app_users_status_valid check (status in ('active', 'blocked')),
  constraint app_users_email_len    check (email is null or length(email) <= 320),
  constraint app_users_name_len     check (name is null or length(name) <= 200)
);
create index app_users_email_idx on public.app_users (lower(email));
comment on table public.app_users is 'Daily Workspace: every Auth0 account that signed in (sub = user_id), with its role and status. Access only through functions.';

create table public.user_audit (
  id         bigint      generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   text        not null,
  target_id  text        not null,
  action     text        not null,
  old_value  text,
  new_value  text,
  constraint user_audit_action_valid check (action in ('role', 'status', 'bootstrap', 'backfill'))
);
create index user_audit_target_idx on public.user_audit (target_id, at desc);
comment on table public.user_audit is 'Who changed a role or blocked/unblocked an account, and when.';

create table public.teams (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  owner_id    text        not null references public.app_users (user_id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint teams_name_valid check (length(btrim(name)) between 1 and 80)
);
create index teams_owner_idx on public.teams (owner_id);

create table public.team_members (
  team_id   uuid        not null references public.teams (id) on delete cascade,
  user_id   text        not null references public.app_users (user_id),
  added_by  text        not null,
  added_at  timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);

create table public.team_tasks (
  id            uuid        primary key default gen_random_uuid(),
  team_id       uuid        not null references public.teams (id) on delete cascade,
  title         text        not null,
  assignee_id   text        references public.app_users (user_id),
  due_date      date,
  status        text        not null default 'todo',
  created_by    text        not null references public.app_users (user_id),
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  constraint team_tasks_title_valid  check (length(btrim(title)) between 1 and 500),
  constraint team_tasks_status_valid check (status in ('todo', 'in_progress', 'blocked', 'done')),
  constraint team_tasks_done_has_completion check ((status = 'done') = (completed_at is not null))
);
create index team_tasks_team_idx on public.team_tasks (team_id);
create index team_tasks_assignee_idx on public.team_tasks (team_id, assignee_id, due_date);

create table public.team_future_projects (
  id             uuid        primary key default gen_random_uuid(),
  team_id        uuid        not null references public.teams (id) on delete cascade,
  title          text        not null,
  notes          text,
  created_by     text        not null,
  created_at     timestamptz not null default now(),
  moved_at       timestamptz,
  moved_task_id  uuid        references public.team_tasks (id) on delete set null,
  constraint team_future_projects_title_valid check (length(btrim(title)) between 1 and 200),
  constraint team_future_projects_notes_len   check (notes is null or length(notes) <= 2000)
);
create index team_future_projects_team_idx on public.team_future_projects (team_id);

create table public.team_events (
  id        bigint      generated always as identity primary key,
  team_id   uuid        not null references public.teams (id) on delete cascade,
  at        timestamptz not null default now(),
  actor_id  text        not null,
  action    text        not null,
  detail    text
);
create index team_events_team_idx on public.team_events (team_id, at desc);

-- No direct access through the Data API: RLS on, no policies, no grants.
do $$
declare t text;
begin
  foreach t in array array['app_users', 'user_audit', 'teams', 'team_members', 'team_tasks', 'team_future_projects', 'team_events'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- caller checks
-- The caller's account, refused unless it is signed in, registered, active and not a waiting 'user'.
create function app_private.require_access(p_min_role text default 'admin')
returns public.app_users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid text := nullif(auth.jwt() ->> 'sub', '');
  u public.app_users;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into u from public.app_users where user_id = uid;
  if not found or u.status <> 'active' or u.role not in ('admin', 'super_admin') then
    raise exception 'workspace_access_denied' using errcode = '42501',
      hint = 'This account is blocked or waiting for access.';
  end if;
  if p_min_role = 'super_admin' and u.role <> 'super_admin' then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  return u;
end;
$$;

-- Used by the snapshots RLS policies: true only for an active admin/super_admin caller.
create function app_private.has_workspace_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_users u
     where u.user_id = auth.jwt() ->> 'sub' and u.status = 'active' and u.role in ('admin', 'super_admin'));
$$;

create function app_private.is_member(p_team uuid, p_user text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.team_members m where m.team_id = p_team and m.user_id = p_user);
$$;

-- Team access for the caller: 'owner', 'member', 'viewer' (Super Admin, not a member), else refused.
create function app_private.team_access(p_team uuid, p_me public.app_users)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare owner text;
begin
  select t.owner_id into owner from public.teams t where t.id = p_team;
  if not found then
    raise exception 'Team not found' using errcode = 'P0002';
  end if;
  if owner = p_me.user_id then return 'owner'; end if;
  if app_private.is_member(p_team, p_me.user_id) then return 'member'; end if;
  if p_me.role = 'super_admin' then return 'viewer'; end if;
  -- Same answer as a team that doesn't exist: a non-member learns nothing about other teams.
  raise exception 'Team not found' using errcode = 'P0002';
end;
$$;

create function app_private.log_team(p_team uuid, p_actor text, p_action text, p_detail text)
returns void language sql security definer set search_path = '' as $$
  insert into public.team_events (team_id, actor_id, action, detail) values (p_team, p_actor, p_action, left(p_detail, 300));
$$;

create function app_private.person(p_user text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p_user is null then null else
    coalesce((select jsonb_build_object('id', u.user_id, 'name', coalesce(nullif(u.name, ''), u.email, 'Unknown'), 'email', u.email)
                from public.app_users u where u.user_id = p_user),
             jsonb_build_object('id', p_user, 'name', 'Unknown', 'email', null)) end;
$$;

-- ---------------------------------------------------------------- registration and own access
-- Called by the app after every sign-in. Registers the account on first sign-in (role 'user') and
-- refreshes name/email from the signed Auth0 token claims. It can never change role or status.
create function public.register_me()
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

  insert into public.app_users as a (user_id, email, email_verified, name, signed_up_at, last_seen_at)
  values (uid, left(c_email, 320), c_verified and c_email is not null, left(c_name, 200), c_created, now())
  on conflict (user_id) do update
     set email          = coalesce(excluded.email, a.email),
         email_verified = case when excluded.email is not null then excluded.email_verified else a.email_verified end,
         name           = coalesce(excluded.name, a.name),
         -- Accounts backfilled by this migration get their real Auth0 signup date on first sign-in.
         signed_up_at   = least(a.signed_up_at, excluded.signed_up_at),
         last_seen_at   = now()
  returning * into u;

  return jsonb_build_object('user_id', u.user_id, 'role', u.role, 'status', u.status, 'name', u.name, 'email', u.email);
end;
$$;

-- Cheap, read-only access check (polled by signed-in browsers so a block or role change applies fast).
create function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('registered', true, 'role', u.role, 'status', u.status)
       from public.app_users u where u.user_id = auth.jwt() ->> 'sub'),
    jsonb_build_object('registered', false, 'role', 'user', 'status', 'active'));
$$;

-- ---------------------------------------------------------------- User Management (Super Admin only)
create function public.admin_list_users()
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
             'user_id', u.user_id, 'name', u.name, 'email', u.email, 'email_verified', u.email_verified,
             'role', u.role, 'status', u.status, 'signed_up_at', u.signed_up_at, 'last_seen_at', u.last_seen_at,
             'role_changed_at', u.role_changed_at, 'role_changed_by', app_private.person(u.role_changed_by),
             'status_changed_at', u.status_changed_at, 'status_changed_by', app_private.person(u.status_changed_by))
           order by u.signed_up_at desc)
      from public.app_users u), '[]'::jsonb);
end;
$$;

create function public.admin_audit(p_limit int default 50)
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
                                'actor', app_private.person(a.actor_id), 'target', app_private.person(a.target_id)) as x
        from public.user_audit a
       order by a.at desc, a.id desc
       limit least(greatest(coalesce(p_limit, 50), 1), 200)) s), '[]'::jsonb);
end;
$$;

-- Locks every Super Admin row, so two concurrent demotions/blocks can't both pass the "last one" check.
create function app_private.assert_not_last_super_admin(p_target text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare others int;
begin
  perform 1 from public.app_users where role = 'super_admin' for update;
  select count(*) into others from public.app_users
   where role = 'super_admin' and status = 'active' and user_id <> p_target;
  if others = 0 then
    raise exception 'This is the last active Super Admin. Promote another Super Admin first.' using errcode = 'P0001';
  end if;
end;
$$;

create function public.admin_set_role(p_user_id text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('super_admin');
  t public.app_users;
begin
  if p_role not in ('user', 'admin', 'super_admin') then
    raise exception 'Unknown role' using errcode = '22023';
  end if;
  if p_user_id = me.user_id then
    raise exception 'You can''t change your own role. Ask another Super Admin.' using errcode = 'P0001';
  end if;
  select * into t from public.app_users where user_id = p_user_id for update;
  if not found then raise exception 'User not found' using errcode = 'P0002'; end if;
  if t.role = p_role then
    return jsonb_build_object('user_id', t.user_id, 'role', t.role, 'status', t.status);
  end if;
  if t.role = 'super_admin' and t.status = 'active' then
    perform app_private.assert_not_last_super_admin(t.user_id);
  end if;
  update public.app_users set role = p_role, role_changed_at = now(), role_changed_by = me.user_id where user_id = t.user_id;
  insert into public.user_audit (actor_id, target_id, action, old_value, new_value) values (me.user_id, t.user_id, 'role', t.role, p_role);
  return jsonb_build_object('user_id', t.user_id, 'role', p_role, 'status', t.status);
end;
$$;

create function public.admin_set_status(p_user_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('super_admin');
  t public.app_users;
begin
  if p_status not in ('active', 'blocked') then
    raise exception 'Unknown status' using errcode = '22023';
  end if;
  if p_user_id = me.user_id then
    raise exception 'You can''t block or unblock your own account.' using errcode = 'P0001';
  end if;
  select * into t from public.app_users where user_id = p_user_id for update;
  if not found then raise exception 'User not found' using errcode = 'P0002'; end if;
  if t.status = p_status then
    return jsonb_build_object('user_id', t.user_id, 'role', t.role, 'status', t.status);
  end if;
  if p_status = 'blocked' and t.role = 'super_admin' then
    perform app_private.assert_not_last_super_admin(t.user_id);
  end if;
  update public.app_users set status = p_status, status_changed_at = now(), status_changed_by = me.user_id where user_id = t.user_id;
  insert into public.user_audit (actor_id, target_id, action, old_value, new_value) values (me.user_id, t.user_id, 'status', t.status, p_status);
  return jsonb_build_object('user_id', t.user_id, 'role', t.role, 'status', p_status);
end;
$$;

-- SQL editor only (no grant to any API role): makes the first Super Admin from a verified Auth0 user id.
create function app_private.bootstrap_super_admin(p_user_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare prev text;
begin
  if p_user_id is null or p_user_id !~ '^[A-Za-z0-9_.-]+\|[A-Za-z0-9_.|-]+$' then
    raise exception 'Pass the Auth0 user id exactly as Auth0 shows it, e.g. auth0|64f0c0ffee…';
  end if;
  if exists (select 1 from public.app_users where role = 'super_admin' and status = 'active') then
    raise exception 'An active Super Admin already exists. Use User Management in the app instead.';
  end if;
  select role into prev from public.app_users where user_id = p_user_id;
  insert into public.app_users (user_id, role, status, role_changed_at, role_changed_by)
  values (p_user_id, 'super_admin', 'active', now(), 'sql-editor')
  on conflict (user_id) do update set role = 'super_admin', status = 'active', role_changed_at = now(), role_changed_by = 'sql-editor';
  insert into public.user_audit (actor_id, target_id, action, old_value, new_value)
  values ('sql-editor', p_user_id, 'bootstrap', prev, 'super_admin');
  return 'Super Admin set for ' || p_user_id;
end;
$$;

-- ---------------------------------------------------------------- personal snapshots: active accounts only
drop policy snapshots_select_own on public.snapshots;
drop policy snapshots_insert_own on public.snapshots;
drop policy snapshots_update_own on public.snapshots;
drop policy snapshots_delete_own on public.snapshots;

create policy snapshots_select_own on public.snapshots
  for select to authenticated
  using (user_id = (select auth.jwt() ->> 'sub') and (select app_private.has_workspace_access()));
create policy snapshots_insert_own on public.snapshots
  for insert to authenticated
  with check (user_id = (select auth.jwt() ->> 'sub') and (select app_private.has_workspace_access()));
create policy snapshots_update_own on public.snapshots
  for update to authenticated
  using (user_id = (select auth.jwt() ->> 'sub') and (select app_private.has_workspace_access()))
  with check (user_id = (select auth.jwt() ->> 'sub') and (select app_private.has_workspace_access()));
create policy snapshots_delete_own on public.snapshots
  for delete to authenticated
  using (user_id = (select auth.jwt() ->> 'sub') and (select app_private.has_workspace_access()));

-- Reads for the sync client: an explicit refusal (not an empty result) for blocked/waiting accounts,
-- so a device never mistakes "access revoked" for "no cloud data".
create function public.get_snapshot(p_slot text, p_with_data boolean default true)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare r jsonb;
begin
  perform app_private.require_access('admin');
  select jsonb_build_object('rev', s.rev, 'updated_at', s.updated_at) || case when p_with_data then jsonb_build_object('snapshot', s.snapshot) else '{}'::jsonb end
    into r
    from public.snapshots s
   where s.user_id = auth.jwt() ->> 'sub' and s.slot = p_slot;
  return r;
end;
$$;

-- Same compare-and-swap as migration 1, refused for blocked/waiting accounts.
create or replace function public.save_snapshot(p_slot text, p_expected_rev text, p_new_rev text, p_snapshot jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  uid text := auth.jwt() ->> 'sub';
  cur text;
begin
  if uid is null or uid = '' then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  perform app_private.require_access('admin');

  select s.rev into cur from public.snapshots s where s.user_id = uid and s.slot = p_slot for update;

  if not found then
    if p_expected_rev is not null then
      return jsonb_build_object('status', 'conflict', 'rev', null);
    end if;
    insert into public.snapshots (user_id, slot, rev, snapshot)
      values (uid, p_slot, p_new_rev, p_snapshot)
      on conflict (user_id, slot) do nothing;
    if found then
      return jsonb_build_object('status', 'ok', 'rev', p_new_rev);
    end if;
    select s.rev into cur from public.snapshots s where s.user_id = uid and s.slot = p_slot;
  end if;

  if cur = p_new_rev then
    return jsonb_build_object('status', 'ok', 'rev', cur);
  end if;
  if cur is distinct from p_expected_rev then
    return jsonb_build_object('status', 'conflict', 'rev', cur);
  end if;

  update public.snapshots s
     set rev = p_new_rev, snapshot = p_snapshot, version = s.version + 1, updated_at = now()
   where s.user_id = uid and s.slot = p_slot;
  return jsonb_build_object('status', 'ok', 'rev', p_new_rev);
end;
$$;

-- ---------------------------------------------------------------- Team Work
create function public.team_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin');
begin
  return jsonb_build_object('my_teams', (select count(distinct m.team_id) from public.team_members m where m.user_id = me.user_id))
      || case when me.role = 'super_admin' then jsonb_build_object('total_teams', (select count(*) from public.teams)) else '{}'::jsonb end;
end;
$$;

-- p_scope 'mine' = teams the caller owns or has joined; 'all' = every team (Super Admin only).
create function public.team_list(p_scope text default 'mine')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin');
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
             'open', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status <> 'done'),
             'blocked', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status = 'blocked'),
             'done', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status = 'done'))
           order by lower(t.name))
      from public.teams t
      left join public.team_members m on m.team_id = t.id and m.user_id = me.user_id
     where p_scope = 'all' or m.user_id is not null), '[]'::jsonb);
end;
$$;

create function public.team_create(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  tid uuid;
begin
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Give the team a name (up to 80 characters).' using errcode = '22023';
  end if;
  insert into public.teams (name, owner_id) values (btrim(p_name), me.user_id) returning id into tid;
  insert into public.team_members (team_id, user_id, added_by) values (tid, me.user_id, me.user_id);
  perform app_private.log_team(tid, me.user_id, 'team_created', btrim(p_name));
  return jsonb_build_object('id', tid);
end;
$$;

create function public.team_rename(p_team_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin');
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can rename the team.' using errcode = '42501';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Give the team a name (up to 80 characters).' using errcode = '22023';
  end if;
  update public.teams set name = btrim(p_name), updated_at = now() where id = p_team_id;
  perform app_private.log_team(p_team_id, me.user_id, 'team_renamed', btrim(p_name));
  return jsonb_build_object('id', p_team_id);
end;
$$;

create function public.team_delete(p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin');
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can delete the team.' using errcode = '42501';
  end if;
  delete from public.teams where id = p_team_id;
  return jsonb_build_object('deleted', p_team_id);
end;
$$;

-- Everything the team page shows. Members' name and email are only returned inside their team.
create function public.team_get(p_team_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  acc text := app_private.team_access(p_team_id, me);
  t public.teams;
begin
  select * into t from public.teams where id = p_team_id;
  return jsonb_build_object(
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

-- Add a registered account by exact email (verified emails only, so nobody can claim a friend's address).
-- No search and no listing: the directory of users stays private to Super Admins.
create function public.team_add_member(p_team_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  found_ids text[];
  target text;
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can add members.' using errcode = '42501';
  end if;
  select array_agg(u.user_id) into found_ids from public.app_users u
   where lower(u.email) = lower(btrim(p_email)) and u.email_verified and u.status = 'active';
  if found_ids is null then
    raise exception 'No registered account with that verified email. Ask them to sign up and confirm their email first.' using errcode = 'P0002';
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

create function public.team_remove_member(p_team_id uuid, p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  n int;
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can remove members.' using errcode = '42501';
  end if;
  if exists (select 1 from public.teams where id = p_team_id and owner_id = p_user_id) then
    raise exception 'The owner can''t be removed from their own team.' using errcode = 'P0001';
  end if;
  delete from public.team_members where team_id = p_team_id and user_id = p_user_id;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Not a member of this team.' using errcode = 'P0002'; end if;
  -- Only current members can be assignees: their open and done tasks here become unassigned.
  update public.team_tasks set assignee_id = null, updated_at = now(), updated_by = me.user_id
   where team_id = p_team_id and assignee_id = p_user_id;
  perform app_private.log_team(p_team_id, me.user_id, 'member_removed', (app_private.person(p_user_id)) ->> 'name');
  return jsonb_build_object('removed', p_user_id);
end;
$$;

create function app_private.check_task_fields(p_team uuid, p_title text, p_assignee text, p_status text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_title is null or length(btrim(p_title)) not between 1 and 500 then
    raise exception 'A task needs a title (up to 500 characters).' using errcode = '22023';
  end if;
  if p_status not in ('todo', 'in_progress', 'blocked', 'done') then
    raise exception 'Unknown status' using errcode = '22023';
  end if;
  if p_assignee is not null and not app_private.is_member(p_team, p_assignee) then
    raise exception 'Only current team members can be assigned.' using errcode = 'P0001';
  end if;
end;
$$;

create function public.team_task_create(p_team_id uuid, p_title text, p_assignee_id text default null, p_due_date date default null, p_status text default 'todo')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  acc text := app_private.team_access(p_team_id, me);
  tid uuid;
  st text := coalesce(p_status, 'todo');
begin
  if acc not in ('owner', 'member') then
    raise exception 'Only team members can add tasks.' using errcode = '42501';
  end if;
  perform app_private.check_task_fields(p_team_id, p_title, p_assignee_id, st);
  insert into public.team_tasks (team_id, title, assignee_id, due_date, status, created_by, updated_by, completed_at)
  values (p_team_id, btrim(p_title), p_assignee_id, p_due_date, st, me.user_id, me.user_id, case when st = 'done' then now() end)
  returning id into tid;
  perform app_private.log_team(p_team_id, me.user_id, 'task_created', btrim(p_title));
  return jsonb_build_object('id', tid);
end;
$$;

-- p_patch: any of {"title", "assignee_id", "due_date", "status"} (a key set to null clears it).
-- Owner: everything. Task creator: everything on their task. Assignee (not creator): status only.
create function public.team_task_update(p_task_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  k public.team_tasks;
  acc text;
  n_title text; n_assignee text; n_due date; n_status text;
  bad_key text;
begin
  select * into k from public.team_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  acc := app_private.team_access(k.team_id, me);
  if acc not in ('owner', 'member') then
    raise exception 'Only team members can change tasks.' using errcode = '42501';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Nothing to change' using errcode = '22023';
  end if;
  select key into bad_key from jsonb_object_keys(p_patch) key where key not in ('title', 'assignee_id', 'due_date', 'status') limit 1;
  if bad_key is not null then raise exception 'Unknown field: %', bad_key using errcode = '22023'; end if;

  if acc <> 'owner' and k.created_by <> me.user_id then
    if k.assignee_id is distinct from me.user_id then
      raise exception 'You can only change tasks you created or that are assigned to you.' using errcode = '42501';
    end if;
    if exists (select 1 from jsonb_object_keys(p_patch) key where key <> 'status') then
      raise exception 'On a task assigned to you, you can change its status. Ask its creator or the team owner for other changes.' using errcode = '42501';
    end if;
  end if;

  n_title    := case when p_patch ? 'title' then p_patch ->> 'title' else k.title end;
  n_assignee := case when p_patch ? 'assignee_id' then nullif(p_patch ->> 'assignee_id', '') else k.assignee_id end;
  n_due      := case when p_patch ? 'due_date' then nullif(p_patch ->> 'due_date', '')::date else k.due_date end;
  n_status   := case when p_patch ? 'status' then p_patch ->> 'status' else k.status end;
  perform app_private.check_task_fields(k.team_id, n_title, case when n_assignee is distinct from k.assignee_id then n_assignee end, n_status);

  update public.team_tasks
     set title = btrim(n_title), assignee_id = n_assignee, due_date = n_due, status = n_status,
         completed_at = case when n_status = 'done' then coalesce(k.completed_at, now()) else null end,
         updated_at = now(), updated_by = me.user_id
   where id = k.id;
  if n_status <> k.status then
    perform app_private.log_team(k.team_id, me.user_id, 'task_status', n_status || ': ' || btrim(n_title));
  elsif n_assignee is distinct from k.assignee_id then
    perform app_private.log_team(k.team_id, me.user_id, 'task_assigned', coalesce((app_private.person(n_assignee)) ->> 'name', 'nobody') || ': ' || btrim(n_title));
  else
    perform app_private.log_team(k.team_id, me.user_id, 'task_edited', btrim(n_title));
  end if;
  return jsonb_build_object('id', k.id);
end;
$$;

create function public.team_task_delete(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  k public.team_tasks;
  acc text;
begin
  select * into k from public.team_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  acc := app_private.team_access(k.team_id, me);
  if not (acc = 'owner' or (acc = 'member' and k.created_by = me.user_id)) then
    raise exception 'Only the team owner or the task''s creator can delete it.' using errcode = '42501';
  end if;
  delete from public.team_tasks where id = k.id;
  perform app_private.log_team(k.team_id, me.user_id, 'task_deleted', k.title);
  return jsonb_build_object('deleted', k.id);
end;
$$;

-- Future Projects: planned work, managed by the team owner, later moved into active work.
create function public.team_project_save(p_team_id uuid, p_project_id uuid, p_title text, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  pid uuid := p_project_id;
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can manage future projects.' using errcode = '42501';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 200 then
    raise exception 'A project needs a title (up to 200 characters).' using errcode = '22023';
  end if;
  if pid is null then
    insert into public.team_future_projects (team_id, title, notes, created_by)
    values (p_team_id, btrim(p_title), nullif(btrim(p_notes), ''), me.user_id) returning id into pid;
    perform app_private.log_team(p_team_id, me.user_id, 'project_added', btrim(p_title));
  else
    update public.team_future_projects set title = btrim(p_title), notes = nullif(btrim(p_notes), '')
     where id = pid and team_id = p_team_id;
    if not found then raise exception 'Project not found' using errcode = 'P0002'; end if;
  end if;
  return jsonb_build_object('id', pid);
end;
$$;

create function public.team_project_delete(p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  p public.team_future_projects;
begin
  select * into p from public.team_future_projects where id = p_project_id;
  if not found then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if app_private.team_access(p.team_id, me) <> 'owner' then
    raise exception 'Only the team owner can manage future projects.' using errcode = '42501';
  end if;
  delete from public.team_future_projects where id = p.id;
  return jsonb_build_object('deleted', p.id);
end;
$$;

create function public.team_project_activate(p_project_id uuid, p_assignee_id text default null, p_due_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  p public.team_future_projects;
  tid uuid;
begin
  select * into p from public.team_future_projects where id = p_project_id for update;
  if not found then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if app_private.team_access(p.team_id, me) <> 'owner' then
    raise exception 'Only the team owner can manage future projects.' using errcode = '42501';
  end if;
  if p.moved_at is not null then
    raise exception 'This project is already in active work.' using errcode = 'P0001';
  end if;
  perform app_private.check_task_fields(p.team_id, p.title, p_assignee_id, 'todo');
  insert into public.team_tasks (team_id, title, assignee_id, due_date, status, created_by, updated_by)
  values (p.team_id, p.title, p_assignee_id, p_due_date, 'todo', me.user_id, me.user_id) returning id into tid;
  update public.team_future_projects set moved_at = now(), moved_task_id = tid where id = p.id;
  perform app_private.log_team(p.team_id, me.user_id, 'project_started', p.title);
  return jsonb_build_object('task_id', tid);
end;
$$;

-- Daily team score for one day, per member (kept separate from the personal Daily Score):
--   due       = tasks assigned to the member with due_date = p_date
--   on_time   = those of them that are done, completed on or before p_date (in p_tz)
--   score     = on_time / due  (null when nothing was due)
--   completed = tasks assigned to the member that were completed on p_date (in p_tz), whatever their due date
create function public.team_scores(p_team_id uuid, p_date date, p_tz text default 'UTC')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('admin');
  tz text := coalesce((select name from pg_catalog.pg_timezone_names where name = p_tz limit 1), 'UTC');
begin
  perform app_private.team_access(p_team_id, me);
  if p_date is null then raise exception 'Pick a date' using errcode = '22023'; end if;
  return jsonb_build_object('date', p_date, 'tz', tz, 'members', coalesce((
    select jsonb_agg(app_private.person(m.user_id) || jsonb_build_object(
             'due', s.due, 'on_time', s.on_time,
             'score', case when s.due > 0 then round(100.0 * s.on_time / s.due) end,
             'completed', s.completed)
           order by (m.user_id = t.owner_id) desc, m.added_at)
      from public.team_members m
      join public.teams t on t.id = m.team_id
      cross join lateral (
        select
          count(*) filter (where k.due_date = p_date) as due,
          count(*) filter (where k.due_date = p_date and k.status = 'done' and (k.completed_at at time zone tz)::date <= p_date) as on_time,
          coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'due_date', k.due_date) order by k.completed_at)
                     filter (where k.status = 'done' and (k.completed_at at time zone tz)::date = p_date), '[]'::jsonb) as completed
          from public.team_tasks k
         where k.team_id = m.team_id and k.assignee_id = m.user_id) s
     where m.team_id = p_team_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- privileges on functions
-- Nothing for signed-out visitors; only the API functions above for signed-in users. Helpers in
-- app_private aren't exposed by the Data API; the ones RLS/invoker functions need are executable.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname as ns, p.proname as name
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'app_private'
               or (n.nspname = 'public' and p.proname in ('register_me', 'my_access', 'admin_list_users', 'admin_audit', 'admin_set_role',
                   'admin_set_status', 'get_snapshot', 'save_snapshot', 'team_stats', 'team_list', 'team_create', 'team_rename',
                   'team_delete', 'team_get', 'team_add_member', 'team_remove_member', 'team_task_create', 'team_task_update',
                   'team_task_delete', 'team_project_save', 'team_project_delete', 'team_project_activate', 'team_scores'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.ns = 'public' or f.name in ('require_access', 'has_workspace_access') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- rollout: keep existing accounts working
-- Accounts that already have a synced dashboard had workspace access: they become 'admin'.
insert into public.app_users (user_id, role, status, signed_up_at, role_changed_at, role_changed_by)
select s.user_id, 'admin', 'active', min(s.created_at), now(), 'migration'
  from public.snapshots s
 group by s.user_id
on conflict (user_id) do nothing;

insert into public.user_audit (actor_id, target_id, action, old_value, new_value)
select 'migration', u.user_id, 'backfill', null, 'admin'
  from public.app_users u where u.role_changed_by = 'migration';

commit;
