-- Daily Workspace — migration 5: new accounts are Admins; pick members while creating a team.
--
--   * Role of a NEW account: 'admin' (was 'user'), set where the account is created (register_me) and
--     as the column default. Existing accounts keep their role; this migration changes no rows.
--     Super Admin stays manual (Users page or the SQL-editor bootstrap). 'user' remains a valid role
--     a Super Admin can give.
--   * Create Team: team_member_directory() lists active accounts (name, email, whether the email is
--     confirmed) for the people allowed to create teams (active Admins and Super Admins), so they can
--     search by email and pick members. team_create_with_members() creates the team and adds them in
--     one transaction: either everything is created or nothing is.

begin;

alter table public.app_users alter column role set default 'admin';

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

  -- A new account is an Admin from its first sign-in (own dashboard + creating and managing teams).
  -- On conflict (an existing account) the role is never touched.
  insert into public.app_users as a (user_id, email, email_verified, name, role, signed_up_at, last_seen_at)
  values (uid, left(c_email, 320), c_verified and c_email is not null, left(c_name, 200), 'admin', c_created, now())
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


create function public.team_member_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare me public.app_users := app_private.require_access('admin'); -- Admins and Super Admins only
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.user_id, 'name', u.name, 'email', u.email, 'email_verified', u.email_verified)
           order by lower(coalesce(u.email, u.name, u.user_id)))
      from public.app_users u
     where u.status = 'active' and u.user_id <> me.user_id), '[]'::jsonb);
end;
$$;

create function public.team_create_with_members(p_name text, p_member_ids jsonb default '[]'::jsonb)
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
  -- The owner is always a member; duplicates are ignored.
  ids := array(select distinct x from jsonb_array_elements_text(coalesce(p_member_ids, '[]'::jsonb)) x where x <> me.user_id);
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

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('team_member_directory', 'team_create_with_members', 'register_me')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

commit;
