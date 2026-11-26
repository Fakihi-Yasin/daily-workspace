begin;

alter table public.team_tasks add column board_position bigint;

create table public.team_task_remarks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.team_tasks(id) on delete cascade,
  parent_id uuid references public.team_task_remarks(id) on delete cascade,
  author_id text not null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  urgent boolean not null default false,
  created_at timestamptz not null default now(),
  checked_at timestamptz,
  checked_by text
);
create index team_task_remarks_task_idx on public.team_task_remarks (task_id, created_at, id);
alter table public.team_task_remarks enable row level security;
revoke all on public.team_task_remarks from public, anon, authenticated;

-- The anchor is the next visible card, or null to append. Persist the complete
-- destination ordering so a filtered drag does not lose any hidden cards.
create function public.team_task_move(p_task_id uuid, p_status text, p_before_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
  k public.team_tasks;
  acc text;
  ordered uuid[];
  at_index int;
begin
  select * into k from public.team_tasks where id=p_task_id;
  if not found then raise exception 'Task not found' using errcode='PT404'; end if;
  acc := app_private.team_access(k.team_id, me);
  if acc not in ('owner','member') then
    raise exception 'Only team members can move tasks.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(k.team_id::text, 0));
  select * into k from public.team_tasks where id=p_task_id for update;
  if not found then raise exception 'Task not found' using errcode='PT404'; end if;
  if acc <> 'owner' and k.created_by <> me.user_id and k.assignee_id is distinct from me.user_id then
    raise exception 'You can only move tasks you created or that are assigned to you.' using errcode='42501';
  end if;
  if p_before_id = p_task_id then return jsonb_build_object('id', k.id); end if;
  if p_status is null then raise exception 'Choose a task status.' using errcode='22023'; end if;
  perform app_private.check_task_fields(k.team_id, k.title, null, p_status);
  select coalesce(array_agg(t.id order by t.board_position nulls last, t.due_date nulls last, t.created_at, t.id), '{}'::uuid[])
    into ordered from public.team_tasks t where t.team_id=k.team_id and t.status=p_status and t.id<>k.id;
  at_index := case when p_before_id is null then cardinality(ordered)+1 else array_position(ordered,p_before_id) end;
  if at_index is null then raise exception 'That drop position changed. Try again.' using errcode='PT409'; end if;
  ordered := ordered[:at_index-1] || array[k.id] || ordered[at_index:];
  if k.status <> p_status then
    perform public.team_task_update(k.id, jsonb_build_object('status',p_status));
  end if;
  update public.team_tasks t set board_position = place.position
    from unnest(ordered) with ordinality as place(id,position) where t.id=place.id;
  return jsonb_build_object('id', k.id);
end;
$$;

create function app_private.remark_task(p_task_id uuid, me public.app_users)
returns public.team_tasks language plpgsql stable security definer set search_path = '' as $$
declare k public.team_tasks;
begin
  select * into k from public.team_tasks where id=p_task_id;
  if not found then raise exception 'Task not found' using errcode='PT404'; end if;
  if app_private.team_access(k.team_id, me) not in ('owner','member') then
    raise exception 'Only team members can access remarks.' using errcode='42501';
  end if;
  return k;
end;
$$;

create function public.team_remarks(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
  k public.team_tasks := app_private.remark_task(p_task_id, me);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', r.id, 'parent_id', r.parent_id, 'author', app_private.person(r.author_id),
    'body',r.body,'urgent',r.urgent,'at',r.created_at,'checked_at',r.checked_at,
    'checked_by', app_private.person(r.checked_by),
    'can_check', r.parent_id is null and (me.user_id in (r.author_id,k.created_by,k.assignee_id)
      or app_private.team_access(k.team_id,me)='owner')
  ) order by r.created_at,r.id) from public.team_task_remarks r where r.task_id=k.id), '[]'::jsonb);
end;
$$;

create function public.team_remark_add(p_task_id uuid,p_body text,p_urgent boolean default false,p_parent_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
  k public.team_tasks := app_private.remark_task(p_task_id,me);
  remark_id uuid;
begin
  if p_body is null or char_length(btrim(p_body)) not between 1 and 2000 then
    raise exception 'Enter a remark of up to 2,000 characters.' using errcode='22023';
  end if;
  if p_parent_id is not null and not exists (
    select 1 from public.team_task_remarks where id=p_parent_id and task_id=k.id and parent_id is null
  ) then raise exception 'Remark not found on this task.' using errcode='PT404'; end if;
  insert into public.team_task_remarks(task_id,parent_id,author_id,body,urgent)
  values(k.id,p_parent_id,me.user_id,btrim(p_body),p_parent_id is null and coalesce(p_urgent,false)) returning id into remark_id;
  return jsonb_build_object('id',remark_id);
end;
$$;

create function public.team_remark_check(p_task_id uuid,p_remark_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me public.app_users := app_private.require_active();
  k public.team_tasks := app_private.remark_task(p_task_id,me);
begin
  update public.team_task_remarks r set checked_at=coalesce(r.checked_at,now()), checked_by=coalesce(r.checked_by,me.user_id)
  where r.id=p_remark_id and r.task_id=k.id and r.parent_id is null
    and (me.user_id in (r.author_id,k.created_by,k.assignee_id) or app_private.team_access(k.team_id,me)='owner');
  if not found then raise exception 'You cannot check this remark.' using errcode='42501'; end if;
  return jsonb_build_object('id',p_remark_id);
end;
$$;

revoke all on function app_private.remark_task(uuid, public.app_users) from public, anon, authenticated;
revoke all on function public.team_task_move(uuid,text,uuid), public.team_remarks(uuid),
  public.team_remark_add(uuid,text,boolean,uuid), public.team_remark_check(uuid,uuid) from public, anon, authenticated;
grant execute on function public.team_task_move(uuid,text,uuid), public.team_remarks(uuid),
  public.team_remark_add(uuid,text,boolean,uuid), public.team_remark_check(uuid,uuid) to authenticated;

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
               'remark_count', case when acc in ('owner','member') then r.total else 0 end,
               'urgent_remark', case when acc in ('owner','member') then coalesce(r.urgent,false) else false end,
               'created_at', k.created_at, 'updated_at', k.updated_at, 'completed_at', k.completed_at)
             order by k.board_position nulls last, k.due_date nulls last, k.created_at, k.id)
        from public.team_tasks k
        cross join lateral (
          select count(*) filter (where rr.parent_id is null) as total,
                 bool_or(rr.urgent and rr.checked_at is null) as urgent
          from public.team_task_remarks rr where rr.task_id=k.id and acc in ('owner','member')
        ) r where k.team_id = t.id), '[]'::jsonb),
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

create or replace function public.team_project_save(p_team_id uuid, p_project_id uuid, p_title text, p_notes text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  pid uuid := p_project_id;
  acc text := app_private.team_access(p_team_id, me);
begin
  if acc not in ('owner','member') or (pid is not null and acc <> 'owner') then
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
    if not found then raise exception 'Project not found' using errcode = 'PT404'; end if;
  end if;
  return jsonb_build_object('id', pid);
end;
$$;

create or replace function public.team_delete(p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_access('super_admin');
  t public.teams;
  n_tasks int; n_members int; n_projects int;
begin
  select * into t from public.teams where id = p_team_id for update;
  if not found then raise exception 'Team not found' using errcode='PT404'; end if;
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
    select jsonb_agg(app_private.person(u.user_id) || jsonb_build_object('email_verified', u.email_verified, 'signed_up_at', u.signed_up_at)
           order by lower(coalesce(nullif(u.display_name, ''), nullif(u.name, ''), u.email, u.user_id)))
      from public.app_users u
     where u.status = 'active'
       and not exists (select 1 from public.team_members m where m.team_id = p_team_id and m.user_id = u.user_id)),
    '[]'::jsonb);
end;
$$;

notify pgrst, 'reload schema';
commit;
