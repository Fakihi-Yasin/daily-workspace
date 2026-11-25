-- Daily Workspace — migration 6: PC Work Time.
--
-- A small agent on the user's computer (agent/pc-time, Ubuntu) counts active time: it stops after N
-- minutes without keyboard/mouse input, while the screen is locked and while the PC is suspended or off.
-- What is stored, and only this: one number of seconds per computer per day, plus the account's
-- settings (idle minutes, paused). No screenshots, no window titles, no keystrokes, no timestamps of
-- activity.
--
-- Pairing: in Settings → PC Work Time a signed-in user creates a device key for one computer. Only its
-- SHA-256 hash is stored. The agent sends it with pc_agent_sync(), the only function callable without
-- a signed-in session: it can only add PC time for that key's own account, and only while the key is
-- not revoked and the account is active (a blocked account is refused). Everything else needs the
-- account's own session.

begin;

create table public.pc_devices (
  id             uuid        primary key default gen_random_uuid(),
  user_id        text        not null references public.app_users (user_id) on delete cascade,
  name           text        not null,
  key_hash       bytea       not null unique,
  created_at     timestamptz not null default now(),
  last_seen_at   timestamptz,
  agent_version  text,
  revoked_at     timestamptz,
  constraint pc_devices_name_valid check (length(btrim(name)) between 1 and 80),
  constraint pc_devices_version_len check (agent_version is null or length(agent_version) <= 40)
);
create index pc_devices_user_idx on public.pc_devices (user_id);

create table public.pc_work_days (
  device_id   uuid        not null references public.pc_devices (id) on delete cascade,
  user_id     text        not null references public.app_users (user_id) on delete cascade,
  day         date        not null,
  seconds     integer     not null,
  updated_at  timestamptz not null default now(),
  primary key (device_id, day),
  constraint pc_work_days_seconds_valid check (seconds between 0 and 86400)
);
create index pc_work_days_user_day_idx on public.pc_work_days (user_id, day);

create table public.pc_settings (
  user_id             text        primary key references public.app_users (user_id) on delete cascade,
  idle_minutes        integer     not null default 5,
  idle_changed_at     timestamptz not null default '-infinity',
  paused              boolean     not null default false,
  paused_changed_at   timestamptz not null default '-infinity',
  constraint pc_settings_idle_valid check (idle_minutes between 1 and 120)
);

do $$
declare t text;
begin
  foreach t in array array['pc_devices', 'pc_work_days', 'pc_settings'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- The caller's settings row (created with defaults on first use).
create function app_private.pc_settings_for(p_user text)
returns public.pc_settings language plpgsql security definer set search_path = '' as $$
declare s public.pc_settings;
begin
  insert into public.pc_settings (user_id) values (p_user) on conflict (user_id) do nothing;
  select * into s from public.pc_settings where user_id = p_user;
  return s;
end;
$$;

create function app_private.pc_settings_json(s public.pc_settings)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('idle_minutes', s.idle_minutes, 'paused', s.paused,
    'idle_changed_at', case when s.idle_changed_at = '-infinity' then null else s.idle_changed_at end,
    'paused_changed_at', case when s.paused_changed_at = '-infinity' then null else s.paused_changed_at end);
$$;

-- ---------------------------------------------------------------- signed-in account (dashboard)
create function public.pc_device_create(p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
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
$$;

create function public.pc_device_list()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'created_at', d.created_at,
      'last_seen_at', d.last_seen_at, 'agent_version', d.agent_version) order by d.created_at)
    from public.pc_devices d where d.user_id = me.user_id and d.revoked_at is null), '[]'::jsonb);
end;
$$;

-- Disconnect a computer: its key stops working at once. Its recorded days stay in the totals.
create function public.pc_device_revoke(p_device_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  update public.pc_devices set revoked_at = now() where id = p_device_id and user_id = me.user_id and revoked_at is null;
  if not found then raise exception 'Computer not found' using errcode = 'PT404'; end if;
  return jsonb_build_object('revoked', p_device_id);
end;
$$;

create function public.pc_settings_set(p_idle_minutes integer default null, p_paused boolean default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
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
$$;

-- Totals for the dashboard: seconds per day (all of the account's computers added up) in a range.
create function public.pc_time_summary(p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
  s public.pc_settings := app_private.pc_settings_for(me.user_id);
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a range of up to 400 days.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', x.day, 'seconds', x.seconds) order by x.day)
      from (select w.day, sum(w.seconds)::int as seconds from public.pc_work_days w
             where w.user_id = me.user_id and w.day between p_from and p_to group by w.day) x), '[]'::jsonb),
    'total', coalesce((select sum(w.seconds)::int from public.pc_work_days w where w.user_id = me.user_id and w.day between p_from and p_to), 0),
    'settings', app_private.pc_settings_json(s),
    'devices', (select count(*) from public.pc_devices d where d.user_id = me.user_id and d.revoked_at is null),
    'last_seen_at', (select max(d.last_seen_at) from public.pc_devices d where d.user_id = me.user_id and d.revoked_at is null));
end;
$$;

-- ---------------------------------------------------------------- the agent (device key, no session)
-- p_days: {"YYYY-MM-DD": seconds, …} — this computer's running total for each day (idempotent: a
-- retry or an older copy never lowers a total). Days from the last 35 days up to tomorrow (time zones).
-- p_paused / p_paused_at and p_idle_minutes / p_idle_at: changes made on the computer; the most recent
-- change, on the computer or in the dashboard, wins. Returns the settings the agent must apply.
create function public.pc_agent_sync(p_key text, p_days jsonb default '{}'::jsonb,
  p_paused boolean default null, p_paused_at timestamptz default null,
  p_idle_minutes integer default null, p_idle_at timestamptz default null, p_version text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d public.pc_devices;
  u public.app_users;
  s public.pc_settings;
  k text; v jsonb; dd date; secs int;
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
    if jsonb_typeof(v) <> 'number' then raise exception 'Invalid seconds for %', k using errcode = '22023'; end if;
    secs := round((v #>> '{}')::numeric);
    if secs < 0 or secs > 86400 then raise exception 'Seconds out of range for %', k using errcode = '22023'; end if;
    if dd < current_date - 35 or dd > current_date + 1 then continue; end if; -- too old or in the future: ignored
    insert into public.pc_work_days as w (device_id, user_id, day, seconds) values (d.id, d.user_id, dd, secs)
    on conflict (device_id, day) do update set seconds = greatest(w.seconds, excluded.seconds),
      updated_at = case when excluded.seconds > w.seconds then now() else w.updated_at end;
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
$$;

-- ---------------------------------------------------------------- privileges
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, n.nspname as ns, p.proname as name
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname = 'app_private' and p.proname in ('pc_settings_for', 'pc_settings_json'))
               or (n.nspname = 'public' and p.proname in ('pc_device_create', 'pc_device_list', 'pc_device_revoke',
                                                          'pc_settings_set', 'pc_time_summary', 'pc_agent_sync'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.ns = 'public' then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    if f.name = 'pc_agent_sync' then
      execute format('grant execute on function %s to anon', f.sig); -- the agent has a device key, not a session
    end if;
  end loop;
end $$;

commit;
