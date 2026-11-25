-- Daily Workspace — migration 4: unique team names per owner, picking members from a list,
-- and editing / deleting accounts from the Users page.
--
--   * Team names: one owner can't have two teams with the same name (case and surrounding spaces
--     ignored). Two different owners may use the same name.
--   * Add a member: the team owner (an Admin or Super Admin) gets the list of active accounts not yet in
--     the team (name, email, whether the email is confirmed) and adds one by its id. Adding by exact
--     verified email still works. Blocked accounts are never listed or added.
--   * Users page (Super Admin only): edit an account's display name and email; delete an account.
--     Deleting removes the account from the app and from its teams. Tasks it created pass to each team's
--     owner; tasks assigned to it become unassigned. Its personal dashboard is moved to a private
--     recovery table (app_private.deleted_snapshots, SQL editor only), not destroyed. An account
--     that owns teams can't be deleted until those teams are deleted. The Auth0 login itself is not
--     touched: signing in again creates a new User with an empty dashboard (Block stops that instead).
-- No existing row is changed by this migration.

begin;

-- ---------------------------------------------------------------- team names: unique per owner
-- Fails (and changes nothing) if an owner already has two teams with the same name.
create unique index teams_owner_name_uniq on public.teams (owner_id, lower(btrim(name)));

create or replace function app_private.assert_team_name_free(p_owner text, p_name text, p_except uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if exists (select 1 from public.teams t
              where t.owner_id = p_owner and lower(btrim(t.name)) = lower(btrim(p_name))
                and t.id is distinct from p_except) then
    raise exception 'You already have a team called "%". Pick another name.', btrim(p_name) using errcode = 'PT409';
  end if;
end;
$$;

create or replace function public.team_create(p_name text)
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
  perform app_private.assert_team_name_free(me.user_id, p_name, null);
  insert into public.teams (name, owner_id) values (btrim(p_name), me.user_id) returning id into tid;
  insert into public.team_members (team_id, user_id, added_by) values (tid, me.user_id, me.user_id);
  perform app_private.log_team(tid, me.user_id, 'team_created', btrim(p_name));
  return jsonb_build_object('id', tid);
end;
$$;

create or replace function public.team_rename(p_team_id uuid, p_name text)
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
  perform app_private.assert_team_name_free(me.user_id, p_name, p_team_id);
  update public.teams set name = btrim(p_name), updated_at = now() where id = p_team_id;
  perform app_private.log_team(p_team_id, me.user_id, 'team_renamed', btrim(p_name));
  return jsonb_build_object('id', p_team_id);
end;
$$;

-- ---------------------------------------------------------------- add a member: pick from the list
create function public.team_member_candidates(p_team_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin');
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner can add members.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.user_id, 'name', u.name, 'email', u.email,
                                        'email_verified', u.email_verified, 'signed_up_at', u.signed_up_at)
           order by lower(coalesce(nullif(u.name, ''), u.email, u.user_id)))
      from public.app_users u
     where u.status = 'active'
       and not exists (select 1 from public.team_members m where m.team_id = p_team_id and m.user_id = u.user_id)),
    '[]'::jsonb);
end;
$$;

create function public.team_add_member_id(p_team_id uuid, p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin');
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

-- ---------------------------------------------------------------- Users page: edit and delete
alter table public.user_audit drop constraint user_audit_action_valid;
alter table public.user_audit add constraint user_audit_action_valid
  check (action in ('role', 'status', 'bootstrap', 'backfill', 'profile', 'delete'));

-- Name and email shown in the app. An email set here counts as confirmed (a Super Admin vouches for
-- it), so the account can be added to teams by that email. The next sign-in whose token carries a
-- name or email replaces these values.
create function public.admin_update_user(p_user_id text, p_name text, p_email text)
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
begin
  select * into t from public.app_users where user_id = p_user_id for update;
  if not found then raise exception 'User not found' using errcode = 'PT404'; end if;
  if n is not null and length(n) > 200 then
    raise exception 'The name is too long (200 characters at most).' using errcode = '22023';
  end if;
  if e is not null and (length(e) > 320 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'That doesn''t look like an email address.' using errcode = '22023';
  end if;
  update public.app_users
     set name = n,
         email = e,
         email_verified = (e is not null)
   where user_id = t.user_id;
  insert into public.user_audit (actor_id, target_id, action, old_value, new_value)
  values (me.user_id, t.user_id, 'profile',
          left(coalesce(t.name, '—') || ' <' || coalesce(t.email, '—') || '>', 600),
          left(coalesce(n, '—') || ' <' || coalesce(e, '—') || '>', 600));
  return jsonb_build_object('user_id', t.user_id, 'name', n, 'email', e);
end;
$$;

-- Recovery copy of a deleted account's dashboard. Not in the Data API; SQL editor only.
create table app_private.deleted_snapshots (
  user_id     text        not null,
  slot        text        not null,
  rev         text,
  snapshot    jsonb,
  created_at  timestamptz,
  updated_at  timestamptz,
  deleted_at  timestamptz not null default now(),
  deleted_by  text        not null
);
revoke all on table app_private.deleted_snapshots from public, anon, authenticated;
alter table app_private.deleted_snapshots enable row level security;

-- snapshots has FORCE row level security, so even this function's owner sees no rows without a
-- policy. This one lets the owner role (never anon/authenticated) reach exactly the account named in
-- the transaction-local setting that admin_delete_user sets just before it moves the rows.
create policy snapshots_owner_move_deleted on public.snapshots
  for all to current_user
  using (user_id = current_setting('app.delete_user', true))
  with check (false);

create function public.admin_delete_user(p_user_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('super_admin');
  t public.app_users;
  owned text;
  moved int;
  r record;
begin
  if p_user_id = me.user_id then
    raise exception 'You can''t delete your own account.' using errcode = 'P0001';
  end if;
  select * into t from public.app_users where user_id = p_user_id for update;
  if not found then raise exception 'User not found' using errcode = 'PT404'; end if;
  if t.role = 'super_admin' and t.status = 'active' then
    perform app_private.assert_not_last_super_admin(t.user_id);
  end if;
  select string_agg('"' || name || '"', ', ' order by lower(name)) into owned from public.teams where owner_id = t.user_id;
  if owned is not null then
    raise exception 'This account owns % — delete those teams first.', owned using errcode = 'P0001';
  end if;

  -- Teams they are in: tasks they created pass to the team owner; their assigned tasks become unassigned.
  for r in select m.team_id, tm.owner_id from public.team_members m join public.teams tm on tm.id = m.team_id where m.user_id = t.user_id loop
    perform app_private.log_team(r.team_id, me.user_id, 'member_removed', coalesce(nullif(t.name, ''), t.email, 'An account') || ' (account deleted)');
  end loop;
  update public.team_tasks k set created_by = tm.owner_id, updated_at = now(), updated_by = me.user_id
    from public.teams tm where tm.id = k.team_id and k.created_by = t.user_id;
  update public.team_tasks set assignee_id = null, updated_at = now(), updated_by = me.user_id where assignee_id = t.user_id;
  delete from public.team_members where user_id = t.user_id;

  -- Personal dashboard: moved to the private recovery table.
  perform set_config('app.delete_user', t.user_id, true);
  insert into app_private.deleted_snapshots (user_id, slot, rev, snapshot, created_at, updated_at, deleted_by)
  select s.user_id, s.slot, s.rev, s.snapshot, s.created_at, s.updated_at, me.user_id from public.snapshots s where s.user_id = t.user_id;
  get diagnostics moved = row_count;
  delete from public.snapshots where user_id = t.user_id;
  perform set_config('app.delete_user', '', true);

  delete from public.app_users where user_id = t.user_id;
  insert into public.user_audit (actor_id, target_id, action, old_value, new_value)
  values (me.user_id, t.user_id, 'delete',
          left(coalesce(t.name, '—') || ' <' || coalesce(t.email, '—') || '> ' || t.role, 600),
          moved || ' dashboard(s) kept for recovery');
  return jsonb_build_object('deleted', t.user_id, 'dashboards_kept', moved);
end;
$$;

-- The audit log still names a deleted account: person() falls back to the details saved in the log.
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
            where (n.nspname = 'app_private' and p.proname = 'assert_team_name_free')
               or (n.nspname = 'public' and p.proname in ('team_member_candidates', 'team_add_member_id',
                                                          'admin_update_user', 'admin_delete_user'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.ns = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

commit;
