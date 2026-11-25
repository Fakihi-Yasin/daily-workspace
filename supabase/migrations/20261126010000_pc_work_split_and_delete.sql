-- Daily Workspace — migration 7: Work / Personal daily totals and "Delete history" for PC Work Time.
--
-- Activity Details (which app or website domain) stay on the computer. When the user turns them on,
-- the agent classifies its own local time as Work, Personal or Uncategorized and sends only the two
-- daily totals below; nothing about apps or sites ever reaches the account.

begin;

alter table public.pc_work_days
  add column work_seconds integer not null default 0,
  add column personal_seconds integer not null default 0,
  add constraint pc_work_days_split_valid check (work_seconds >= 0 and personal_seconds >= 0 and work_seconds + personal_seconds <= seconds);

-- p_days values: a number (total seconds, as before) or {"total": s, "work": s, "personal": s}.
create or replace function public.pc_agent_sync(p_key text, p_days jsonb default '{}'::jsonb,
  p_paused boolean default null, p_paused_at timestamptz default null,
  p_idle_minutes integer default null, p_idle_at timestamptz default null, p_version text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
$$;

create or replace function public.pc_time_summary(p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
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
$$;

-- Delete history: removes this account's synced PC Work Time totals (all, or before a date).
create function public.pc_history_delete(p_before date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
  n int;
begin
  delete from public.pc_work_days where user_id = me.user_id and (p_before is null or day < p_before);
  get diagnostics n = row_count;
  return jsonb_build_object('deleted_days', n);
end;
$$;
revoke all on function public.pc_history_delete(date) from public, anon, authenticated;
grant execute on function public.pc_history_delete(date) to authenticated;

commit;
