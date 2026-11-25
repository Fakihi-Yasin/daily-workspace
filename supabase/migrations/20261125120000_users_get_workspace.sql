-- Daily Workspace — migration 3: every active account gets its own workspace on signup.
--
-- Before: role 'user' (the default for new signups) meant "Waiting for access" until a Super Admin
-- promoted the account. Now:
--   user         own personal dashboard (read + save) and the teams they've been added to.
--   admin        the same, plus creating teams and managing the teams they own.
--   super_admin  admin features + User Management + read access to every team.
-- 'user' stays the default role. Blocked accounts are still refused everywhere, whatever their role.
-- No role is changed by this migration and no data is touched: only functions are replaced.
--
-- What changes
--   * app_private.require_active(): new caller check: signed in, registered, status 'active', any role.
--   * app_private.has_workspace_access() (snapshots RLS): now true for any active account.
--   * get_snapshot / save_snapshot, and the team functions where team membership decides access
--     (team_stats, team_list, team_get, team_task_create/update/delete, team_scores), use
--     require_active() instead of require_access('admin'). Inside those, ownership, membership and
--     Super Admin checks (app_private.team_access, team_list 'all') are unchanged, so a User only
--     ever sees teams they belong to.
--   * app_private.require_access() is NOT changed: everything still calling it stays as strict as before
--     (User Management: super_admin; team_create, rename, delete, add/remove member, future
--     projects: admin or super_admin).

begin;

create function app_private.require_active()
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
  if not found or u.status <> 'active' then
    raise exception 'workspace_access_denied' using errcode = '42501',
      hint = 'This account is blocked or not registered yet.';
  end if;
  return u;
end;
$$;
revoke all on function app_private.require_active() from public, anon, authenticated;
-- get_snapshot / save_snapshot are SECURITY INVOKER and call it as the signed-in user.
grant execute on function app_private.require_active() to authenticated;

-- Used by the snapshots RLS policies: true for an active caller, whatever their role.
create or replace function app_private.has_workspace_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_users u
     where u.user_id = auth.jwt() ->> 'sub' and u.status = 'active');
$$;

create or replace function public.get_snapshot(p_slot text, p_with_data boolean default true)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare r jsonb;
begin
  perform app_private.require_active();
  select jsonb_build_object('rev', s.rev, 'updated_at', s.updated_at) || case when p_with_data then jsonb_build_object('snapshot', s.snapshot) else '{}'::jsonb end
    into r
    from public.snapshots s
   where s.user_id = auth.jwt() ->> 'sub' and s.slot = p_slot;
  return r;
end;
$$;

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
  perform app_private.require_active();

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

create or replace function public.team_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_active();
begin
  return jsonb_build_object('my_teams', (select count(distinct m.team_id) from public.team_members m where m.user_id = me.user_id))
      || case when me.role = 'super_admin' then jsonb_build_object('total_teams', (select count(*) from public.teams)) else '{}'::jsonb end;
end;
$$;

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
             'open', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status <> 'done'),
             'blocked', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status = 'blocked'),
             'done', (select count(*) from public.team_tasks k where k.team_id = t.id and k.status = 'done'))
           order by lower(t.name))
      from public.teams t
      left join public.team_members m on m.team_id = t.id and m.user_id = me.user_id
     where p_scope = 'all' or m.user_id is not null), '[]'::jsonb);
end;
$$;

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

create or replace function public.team_task_create(p_team_id uuid, p_title text, p_assignee_id text default null, p_due_date date default null, p_status text default 'todo')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
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

create or replace function public.team_task_update(p_task_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  k public.team_tasks;
  acc text;
  n_title text; n_assignee text; n_due date; n_status text;
  bad_key text;
begin
  select * into k from public.team_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'PT404'; end if;
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

create or replace function public.team_task_delete(p_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  k public.team_tasks;
  acc text;
begin
  select * into k from public.team_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'PT404'; end if;
  acc := app_private.team_access(k.team_id, me);
  if not (acc = 'owner' or (acc = 'member' and k.created_by = me.user_id)) then
    raise exception 'Only the team owner or the task''s creator can delete it.' using errcode = '42501';
  end if;
  delete from public.team_tasks where id = k.id;
  perform app_private.log_team(k.team_id, me.user_id, 'task_deleted', k.title);
  return jsonb_build_object('deleted', k.id);
end;
$$;

create or replace function public.team_scores(p_team_id uuid, p_date date, p_tz text default 'UTC')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
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

-- create or replace keeps each function's existing grants (execute for authenticated only); checked here.
do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_snapshot', 'save_snapshot', 'team_stats', 'team_list', 'team_get',
                       'team_task_create', 'team_task_update', 'team_task_delete', 'team_scores')
     and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute'));
  if bad is not null then raise exception 'Unexpected function privileges: %', bad; end if;
end $$;

commit;
