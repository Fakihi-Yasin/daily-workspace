-- Daily Workspace — migration 10: team categories, feature grants (PC Work Time), one Super Admin,
-- and "My team tasks" for saved views.
--
--   * Team categories: public.team_categories, managed by the team owner (create, rename, archive).
--     They are the team's own: personal categories live in each user's private dashboard and never
--     reach the team. team_tasks.category_id points at them; archiving hides a category from pickers
--     but keeps it on old tasks.
--   * Feature grants: app_private.feature_grants (user, feature). PC Work Time ('pc_time') is granted
--     to the current active Super Admin only; every pc_* function checks it. Its data stays private
--     to the account (unchanged).
--   * Super Admin: only one. admin_set_role can no longer make anyone Super Admin (the first and only
--     one is set from the SQL editor, as before).
--   * my_team_tasks(): open tasks assigned to the caller in teams they belong to.
--   * register_me / my_access also return the caller's feature list.
-- No existing team, membership, role, task or dashboard is changed.

begin;

-- Enforce a single Super Admin even if two bootstrap calls run concurrently.
create unique index app_users_one_super_admin on public.app_users (role)
where role = 'super_admin';

-- ---------------------------------------------------------------- feature grants
create table app_private.feature_grants (
  user_id     text        not null references public.app_users (user_id) on delete cascade,
  feature     text        not null,
  granted_at  timestamptz not null default now(),
  granted_by  text        not null default 'migration',
  primary key (user_id, feature),
  constraint feature_grants_feature_valid check (feature in ('pc_time'))
);
revoke all on table app_private.feature_grants from public, anon, authenticated;
alter table app_private.feature_grants enable row level security;

insert into app_private.feature_grants (user_id, feature)
select user_id, 'pc_time' from public.app_users where role = 'super_admin' and status = 'active'
on conflict do nothing;

create function app_private.has_feature(p_user text, p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app_private.feature_grants g where g.user_id = p_user and g.feature = p_feature);
$$;

create function app_private.features_of(p_user text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(g.feature order by g.feature), '[]'::jsonb) from app_private.feature_grants g where g.user_id = p_user;
$$;

-- Active account with the feature, else refused (same error for "not granted" whatever the feature).
create function app_private.require_feature(p_feature text)
returns public.app_users language plpgsql stable security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  if not app_private.has_feature(me.user_id, p_feature) then
    raise exception 'feature_not_available' using errcode = '42501', hint = 'This feature isn''t available for this account.';
  end if;
  return me;
end;
$$;

create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('registered', true, 'role', u.role, 'status', u.status, 'features', app_private.features_of(u.user_id))
       from public.app_users u where u.user_id = auth.jwt() ->> 'sub'),
    jsonb_build_object('registered', false, 'role', 'user', 'status', 'active', 'features', '[]'::jsonb));
$$;

-- ---------------------------------------------------------------- PC Work Time: granted accounts only
-- pc_agent_sync
CREATE OR REPLACE FUNCTION public.pc_agent_sync(p_key text, p_days jsonb DEFAULT '{}'::jsonb, p_paused boolean DEFAULT NULL::boolean, p_paused_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_idle_minutes integer DEFAULT NULL::integer, p_idle_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_version text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d public.pc_devices;
  u public.app_users;
  s public.pc_settings;
  k text; v jsonb; dd date; secs int; w int; p int;
  num jsonb;
begin
  if p_key is null or length(p_key) not between 20 and 100 then
    raise exception 'invalid_device_key' using errcode = '42501';
  end if;
  select * into d from public.pc_devices where key_hash = sha256(convert_to(p_key, 'UTF8')) and revoked_at is null for update;
  if not found then
    raise exception 'invalid_device_key' using errcode = '42501', hint = 'This computer was disconnected. Connect it again from Settings → PC Work Time.';
  end if;
  select * into u from public.app_users where user_id = d.user_id;
  if not found or u.status <> 'active' then
    raise exception 'workspace_access_denied' using errcode = '42501', hint = 'This account is blocked.';
  end if;
  -- PC Work Time is only for accounts that were granted it (app_private.feature_grants).
  if not app_private.has_feature(u.user_id, 'pc_time') then
    raise exception 'feature_not_available' using errcode = '42501', hint = 'PC Work Time isn''t available for this account.';
  end if;
  if p_days is null then p_days := '{}'::jsonb; end if;
  if jsonb_typeof(p_days) <> 'object' or (select count(*) from jsonb_object_keys(p_days)) > 40 then
    raise exception 'Send at most 40 days as {"YYYY-MM-DD": seconds}.' using errcode = '22023';
  end if;
  for k, v in select * from jsonb_each(p_days) loop
    begin
      dd := k::date;
    exception when others then
      raise exception 'Invalid day: %', left(k, 20) using errcode = '22023';
    end;
    w := 0; p := 0;
    if jsonb_typeof(v) = 'number' then
      num := v;
    elsif jsonb_typeof(v) = 'object' and jsonb_typeof(v -> 'total') = 'number' then
      num := v -> 'total';
      if jsonb_typeof(v -> 'work') = 'number' then w := round((v ->> 'work')::numeric); end if;
      if jsonb_typeof(v -> 'personal') = 'number' then p := round((v ->> 'personal')::numeric); end if;
    else
      raise exception 'Invalid seconds for %', k using errcode = '22023';
    end if;
    secs := round((num #>> '{}')::numeric);
    if secs < 0 or secs > 86400 or w < 0 or p < 0 or w + p > secs then
      raise exception 'Seconds out of range for %', k using errcode = '22023';
    end if;
    if dd < current_date - 35 or dd > current_date + 1 then continue; end if;
    insert into public.pc_work_days as x (device_id, user_id, day, seconds, work_seconds, personal_seconds)
    values (d.id, d.user_id, dd, secs, w, p)
    on conflict (device_id, day) do update set
      -- Totals never go down (retries, older copies). The split follows the copy with the larger total.
      seconds = greatest(x.seconds, excluded.seconds),
      work_seconds = case when excluded.seconds >= x.seconds then excluded.work_seconds else x.work_seconds end,
      personal_seconds = case when excluded.seconds >= x.seconds then excluded.personal_seconds else x.personal_seconds end,
      updated_at = case when excluded.seconds > x.seconds then now() else x.updated_at end;
  end loop;

  s := app_private.pc_settings_for(d.user_id);
  if p_paused is not null and p_paused_at is not null and least(p_paused_at, now()) > s.paused_changed_at then
    update public.pc_settings set paused = p_paused, paused_changed_at = least(p_paused_at, now()) where user_id = d.user_id;
  end if;
  if p_idle_minutes is not null and p_idle_at is not null and p_idle_minutes between 1 and 120 and least(p_idle_at, now()) > s.idle_changed_at then
    update public.pc_settings set idle_minutes = p_idle_minutes, idle_changed_at = least(p_idle_at, now()) where user_id = d.user_id;
  end if;
  select * into s from public.pc_settings where user_id = d.user_id;
  update public.pc_devices set last_seen_at = now(), agent_version = left(p_version, 40) where id = d.id;
  return app_private.pc_settings_json(s) || jsonb_build_object('device', d.name, 'server_time', now());
end;
$function$;

-- pc_device_create
CREATE OR REPLACE FUNCTION public.pc_device_create(p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me public.app_users := app_private.require_feature('pc_time');
  k text := 'dwpc_' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  d uuid;
begin
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Give this computer a name (up to 80 characters).' using errcode = '22023';
  end if;
  if (select count(*) from public.pc_devices where user_id = me.user_id and revoked_at is null) >= 10 then
    raise exception 'You already have 10 connected computers. Disconnect one first.' using errcode = 'P0001';
  end if;
  insert into public.pc_devices (user_id, name, key_hash) values (me.user_id, btrim(p_name), sha256(convert_to(k, 'UTF8')))
  returning id into d;
  perform app_private.pc_settings_for(me.user_id);
  -- The key is returned once and never stored in clear.
  return jsonb_build_object('id', d, 'name', btrim(p_name), 'key', k);
end;
$function$;

-- pc_device_list
CREATE OR REPLACE FUNCTION public.pc_device_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare me public.app_users := app_private.require_feature('pc_time');
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'created_at', d.created_at,
      'last_seen_at', d.last_seen_at, 'agent_version', d.agent_version) order by d.created_at)
    from public.pc_devices d where d.user_id = me.user_id and d.revoked_at is null), '[]'::jsonb);
end;
$function$;

-- pc_device_revoke
CREATE OR REPLACE FUNCTION public.pc_device_revoke(p_device_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare me public.app_users := app_private.require_feature('pc_time');
begin
  update public.pc_devices set revoked_at = now() where id = p_device_id and user_id = me.user_id and revoked_at is null;
  if not found then raise exception 'Computer not found' using errcode = 'PT404'; end if;
  return jsonb_build_object('revoked', p_device_id);
end;
$function$;

-- pc_history_delete
CREATE OR REPLACE FUNCTION public.pc_history_delete(p_before date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me public.app_users := app_private.require_feature('pc_time');
  n int;
begin
  delete from public.pc_work_days where user_id = me.user_id and (p_before is null or day < p_before);
  get diagnostics n = row_count;
  return jsonb_build_object('deleted_days', n);
end;
$function$;

-- pc_settings_set
CREATE OR REPLACE FUNCTION public.pc_settings_set(p_idle_minutes integer DEFAULT NULL::integer, p_paused boolean DEFAULT NULL::boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me public.app_users := app_private.require_feature('pc_time');
  s public.pc_settings := app_private.pc_settings_for(me.user_id);
begin
  if p_idle_minutes is not null then
    if p_idle_minutes not between 1 and 120 then
      raise exception 'Choose between 1 and 120 minutes.' using errcode = '22023';
    end if;
    update public.pc_settings set idle_minutes = p_idle_minutes, idle_changed_at = now() where user_id = me.user_id;
  end if;
  if p_paused is not null then
    update public.pc_settings set paused = p_paused, paused_changed_at = now() where user_id = me.user_id;
  end if;
  select * into s from public.pc_settings where user_id = me.user_id;
  return app_private.pc_settings_json(s);
end;
$function$;

-- pc_time_summary
CREATE OR REPLACE FUNCTION public.pc_time_summary(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me public.app_users := app_private.require_feature('pc_time');
  s public.pc_settings := app_private.pc_settings_for(me.user_id);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a range of up to 400 days.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', x.day, 'seconds', x.seconds, 'work', x.work, 'personal', x.personal) order by x.day)
      from (select w.day, sum(w.seconds)::int as seconds, sum(w.work_seconds)::int as work, sum(w.personal_seconds)::int as personal
              from public.pc_work_days w where w.user_id = me.user_id and w.day between p_from and p_to group by w.day) x), '[]'::jsonb),
    'total', coalesce((select sum(w.seconds)::int from public.pc_work_days w where w.user_id = me.user_id and w.day between p_from and p_to), 0),
    'work', coalesce((select sum(w.work_seconds)::int from public.pc_work_days w where w.user_id = me.user_id and w.day between p_from and p_to), 0),
    'personal', coalesce((select sum(w.personal_seconds)::int from public.pc_work_days w where w.user_id = me.user_id and w.day between p_from and p_to), 0),
    'settings', app_private.pc_settings_json(s),
    'devices', (select count(*) from public.pc_devices d where d.user_id = me.user_id and d.revoked_at is null),
    'last_seen_at', (select max(d.last_seen_at) from public.pc_devices d where d.user_id = me.user_id and d.revoked_at is null));
end;
$function$;

-- ---------------------------------------------------------------- one Super Admin
create or replace function public.admin_set_role(p_user_id text, p_role text)
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
  if p_role = 'super_admin' then
    raise exception 'This workspace has a single Super Admin. That role can''t be given from the app.' using errcode = '42501';
  end if;
  if p_user_id = me.user_id then
    raise exception 'You can''t change your own role.' using errcode = 'P0001';
  end if;
  select * into t from public.app_users where user_id = p_user_id for update;
  if not found then raise exception 'User not found' using errcode = 'PT404'; end if;
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

-- ---------------------------------------------------------------- team categories (owner-managed)
create table public.team_categories (
  id          uuid        primary key default gen_random_uuid(),
  team_id     uuid        not null references public.teams (id) on delete cascade,
  name        text        not null,
  color       text        not null default 'blue',
  archived    boolean     not null default false,
  created_by  text        not null,
  created_at  timestamptz not null default now(),
  constraint team_categories_name_valid  check (length(btrim(name)) between 1 and 60),
  constraint team_categories_color_valid check (color in ('blue', 'pink', 'mint', 'yellow', 'sky', 'ink'))
);
create unique index team_categories_name_uniq on public.team_categories (team_id, lower(btrim(name)));
revoke all on table public.team_categories from public, anon, authenticated;
alter table public.team_categories enable row level security;

alter table public.team_tasks add column category_id uuid references public.team_categories (id) on delete set null;

create function app_private.team_category_json(c public.team_categories)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color, 'archived', c.archived);
$$;

-- Create (p_id null) or rename / recolour (p_id set). Owner only.
create function public.team_category_save(p_team_id uuid, p_id uuid, p_name text, p_color text default 'blue')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  n text := btrim(coalesce(p_name, ''));
  col text := coalesce(nullif(p_color, ''), 'blue');
  c public.team_categories;
begin
  if app_private.team_access(p_team_id, me) <> 'owner' then
    raise exception 'Only the team owner manages team categories.' using errcode = '42501';
  end if;
  if length(n) not between 1 and 60 then raise exception 'Give the category a name (up to 60 characters).' using errcode = '22023'; end if;
  if col not in ('blue', 'pink', 'mint', 'yellow', 'sky', 'ink') then col := 'blue'; end if;
  if exists (select 1 from public.team_categories x where x.team_id = p_team_id and lower(btrim(x.name)) = lower(n) and x.id is distinct from p_id) then
    raise exception 'This team already has a category called "%".', n using errcode = 'PT409';
  end if;
  if p_id is null then
    insert into public.team_categories (team_id, name, color, created_by) values (p_team_id, n, col, me.user_id) returning * into c;
    perform app_private.log_team(p_team_id, me.user_id, 'category_added', n);
  else
    update public.team_categories set name = n, color = col where id = p_id and team_id = p_team_id returning * into c;
    if not found then raise exception 'Category not found' using errcode = 'PT404'; end if;
  end if;
  return app_private.team_category_json(c);
end;
$$;

-- Archive: hidden from pickers, kept on the tasks that use it. Unarchive brings it back.
create function public.team_category_archive(p_id uuid, p_archived boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  c public.team_categories;
begin
  select * into c from public.team_categories where id = p_id;
  if not found then raise exception 'Category not found' using errcode = 'PT404'; end if;
  if app_private.team_access(c.team_id, me) <> 'owner' then
    raise exception 'Only the team owner manages team categories.' using errcode = '42501';
  end if;
  update public.team_categories set archived = coalesce(p_archived, true) where id = c.id returning * into c;
  return app_private.team_category_json(c);
end;
$$;

-- A task's category must be one of the team's own, and active (an archived one may stay where it is).
create function app_private.check_task_category(p_team uuid, p_category uuid, p_current uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_category is null or p_category is not distinct from p_current then return; end if;
  if not exists (select 1 from public.team_categories c where c.id = p_category and c.team_id = p_team and not c.archived) then
    raise exception 'Pick one of this team''s categories.' using errcode = '22023';
  end if;
end;
$$;

drop function public.team_task_create(uuid, text, text, date, text);
create function public.team_task_create(p_team_id uuid, p_title text, p_assignee_id text default null, p_due_date date default null,
                                        p_status text default 'todo', p_category_id uuid default null)
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
  perform app_private.check_task_category(p_team_id, p_category_id, null);
  insert into public.team_tasks (team_id, title, assignee_id, due_date, status, created_by, updated_by, completed_at, category_id)
  values (p_team_id, btrim(p_title), p_assignee_id, p_due_date, st, me.user_id, me.user_id, case when st = 'done' then now() end, p_category_id)
  returning id into tid;
  perform app_private.log_team(p_team_id, me.user_id, 'task_created', btrim(p_title));
  return jsonb_build_object('id', tid);
end;
$$;

-- Same rules as before; 'category_id' is a new editable field (owner / the task's creator).
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
  n_title text; n_assignee text; n_due date; n_status text; n_cat uuid;
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
  select key into bad_key from jsonb_object_keys(p_patch) key where key not in ('title', 'assignee_id', 'due_date', 'status', 'category_id') limit 1;
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
  begin
    n_cat    := case when p_patch ? 'category_id' then nullif(p_patch ->> 'category_id', '')::uuid else k.category_id end;
  exception when invalid_text_representation then
    raise exception 'Pick one of this team''s categories.' using errcode = '22023';
  end;
  perform app_private.check_task_fields(k.team_id, n_title, case when n_assignee is distinct from k.assignee_id then n_assignee end, n_status);
  perform app_private.check_task_category(k.team_id, n_cat, k.category_id);

  update public.team_tasks
     set title = btrim(n_title), assignee_id = n_assignee, due_date = n_due, status = n_status, category_id = n_cat,
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

-- team_get: as before, plus the team's categories and each task's category_id.
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
    'categories', coalesce((
      select jsonb_agg(app_private.team_category_json(c) order by c.archived, lower(c.name))
        from public.team_categories c where c.team_id = t.id), '[]'::jsonb),
    'members', coalesce((
      select jsonb_agg(app_private.person(m.user_id) || jsonb_build_object('owner', m.user_id = t.owner_id, 'added_at', m.added_at)
                       order by (m.user_id = t.owner_id) desc, m.added_at)
        from public.team_members m where m.team_id = t.id), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', k.id, 'title', k.title, 'status', k.status, 'due_date', k.due_date, 'category_id', k.category_id,
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

-- ---------------------------------------------------------------- saved view: my team tasks
create function public.my_team_tasks()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_active();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'status', k.status, 'due_date', k.due_date,
                                        'team_id', t.id, 'team_name', t.name,
                                        'category', case when c.id is not null then jsonb_build_object('name', c.name, 'color', c.color) end)
           order by k.due_date nulls last, k.created_at)
      from public.team_tasks k
      join public.teams t on t.id = k.team_id
      join public.team_members m on m.team_id = k.team_id and m.user_id = me.user_id
      left join public.team_categories c on c.id = k.category_id
     where k.assignee_id = me.user_id and k.status <> 'done'), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- privileges
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname as ns
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'app_private' and p.proname in ('has_feature', 'features_of', 'require_feature', 'team_category_json', 'check_task_category'))
               or (n.nspname = 'public' and p.proname in ('team_category_save', 'team_category_archive', 'team_task_create', 'my_team_tasks'))
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
   where n.nspname = 'public' and p.proname like any (array['team\_%', 'my\_%', 'pc\_%', 'admin\_%'])
     and has_function_privilege('anon', p.oid, 'execute') and p.proname <> 'pc_agent_sync';
  if bad is not null then raise exception 'Unexpected function privileges: %', bad; end if;
end $$;

commit;
