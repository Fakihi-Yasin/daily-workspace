begin;

alter table public.team_task_remarks add column team_id uuid references public.teams(id) on delete cascade;
update public.team_task_remarks r set team_id=t.team_id from public.team_tasks t where t.id=r.task_id;
alter table public.team_task_remarks alter column team_id set not null, alter column task_id drop not null;
create index team_remarks_team_idx on public.team_task_remarks(team_id, created_at);
create index team_remarks_parent_idx on public.team_task_remarks(parent_id);

-- Keep old task remark callers working and derive the team from the task.
create function app_private.set_remark_team() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.task_id is not null then
    select t.team_id into new.team_id from public.team_tasks t where t.id=new.task_id;
  end if;
  return new;
end;
$$;
create trigger set_remark_team before insert on public.team_task_remarks
for each row execute function app_private.set_remark_team();

create table public.team_remark_reads (
  remark_id uuid not null references public.team_task_remarks(id) on delete cascade,
  user_id text not null references public.app_users(user_id) on delete cascade,
  primary key (remark_id,user_id)
);
alter table public.team_remark_reads enable row level security;
revoke all on public.team_remark_reads from public, anon, authenticated;

create function app_private.require_team_member(p_team_id uuid, me public.app_users) returns text
language plpgsql stable security definer set search_path = '' as $$
declare access text := app_private.team_access(p_team_id,me);
begin
  if access not in ('owner','member') then raise exception 'Only team members can do this.' using errcode='42501'; end if;
  return access;
end;
$$;

create function public.team_remark_inbox(p_team_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  perform app_private.require_team_member(p_team_id,me);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id',r.id,'task_id',r.task_id,'task_title',t.title,'body',r.body,
      'author',app_private.person(r.author_id),'at',r.created_at,'urgent',r.urgent,'checked_at',r.checked_at,
      'unread',m.unread) order by m.latest desc, r.id)
    from public.team_task_remarks r
    left join public.team_tasks t on t.id=r.task_id
    cross join lateral (
      select count(*) filter (where x.author_id<>me.user_id and rr.remark_id is null) as unread,
             max(x.created_at) as latest
      from public.team_task_remarks x
      left join public.team_remark_reads rr on rr.remark_id=x.id and rr.user_id=me.user_id
      where x.id=r.id or x.parent_id=r.id
    ) m where r.team_id=p_team_id and r.parent_id is null
  ),'[]'::jsonb);
end;
$$;

create function public.team_remark_thread(p_team_id uuid,p_root_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
  access text := app_private.require_team_member(p_team_id,me);
  root public.team_task_remarks;
begin
  select * into root from public.team_task_remarks where id=p_root_id and team_id=p_team_id and parent_id is null;
  if not found then raise exception 'Remark not found' using errcode='PT404'; end if;
  return (
    select jsonb_agg(jsonb_build_object('id',r.id,'parent_id',r.parent_id,'author',app_private.person(r.author_id),
      'body',r.body,'urgent',r.urgent,'at',r.created_at,'checked_at',r.checked_at,
      'can_check',r.parent_id is null and (root.task_id is null or access='owner' or r.author_id=me.user_id
        or exists(select 1 from public.team_tasks k where k.id=root.task_id and me.user_id in (k.created_by,k.assignee_id))))
      order by r.parent_id nulls first,r.created_at,r.id)
    from public.team_task_remarks r where r.team_id=p_team_id and (r.id=root.id or r.parent_id=root.id)
  );
end;
$$;

create function public.team_remark_post(p_team_id uuid,p_body text,p_urgent boolean default false,p_root_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
  task uuid;
  remark uuid;
begin
  perform app_private.require_team_member(p_team_id,me);
  if char_length(btrim(coalesce(p_body,''))) not between 1 and 2000 then
    raise exception 'Enter a remark of up to 2,000 characters.' using errcode='22023';
  end if;
  if p_root_id is not null then
    select task_id into task from public.team_task_remarks where id=p_root_id and team_id=p_team_id and parent_id is null;
    if not found then raise exception 'Remark not found' using errcode='PT404'; end if;
  end if;
  insert into public.team_task_remarks(team_id,task_id,parent_id,body,author_id,urgent)
  values(p_team_id,task,p_root_id,btrim(p_body),me.user_id,p_root_id is null and coalesce(p_urgent,false)) returning id into remark;
  return jsonb_build_object('id',remark);
end;
$$;

create function public.team_remark_resolve(p_team_id uuid,p_root_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
  root public.team_task_remarks;
begin
  perform app_private.require_team_member(p_team_id,me);
  select * into root from public.team_task_remarks where id=p_root_id and team_id=p_team_id and parent_id is null;
  if not found then raise exception 'Remark not found' using errcode='PT404'; end if;
  if root.task_id is not null then
    perform public.team_remark_check(root.task_id,root.id);
  else
    update public.team_task_remarks set checked_at=coalesce(checked_at,now()),checked_by=coalesce(checked_by,me.user_id)
    where id=root.id;
  end if;
end;
$$;

-- Acknowledge only messages actually loaded, so replies arriving mid-read stay unread.
create function public.team_remark_read(p_team_id uuid,p_ids jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
begin
  perform app_private.require_team_member(p_team_id,me);
  insert into public.team_remark_reads(remark_id,user_id)
  select r.id,me.user_id from jsonb_array_elements_text(p_ids) i(id)
  join public.team_task_remarks r on r.id=i.id::uuid and r.team_id=p_team_id
  where r.author_id<>me.user_id on conflict do nothing;
end;
$$;

create table public.team_task_routines (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  title text not null,
  assignee_id text,
  recurrence text not null check (recurrence in ('daily','weekdays','weekly','monthly')),
  starts_on date not null,
  created_by text not null,
  active boolean not null default true
);
alter table public.team_task_routines enable row level security;
revoke all on public.team_task_routines from public, anon, authenticated;
alter table public.team_tasks add column routine_id uuid references public.team_task_routines(id) on delete set null,
  add column routine_date date;
create unique index team_task_routine_occurrence on public.team_tasks(routine_id,routine_date);

create function app_private.team_routine_occurrence(r public.team_task_routines, due date) returns void
language sql security definer set search_path = '' as $$
  insert into public.team_tasks(team_id,title,assignee_id,due_date,status,created_by,updated_by,routine_id,routine_date)
  select r.team_id,r.title,
    case when exists(select 1 from public.team_members m where m.team_id=r.team_id and m.user_id=r.assignee_id) then r.assignee_id end,
    due,'todo',r.created_by,r.created_by,r.id,due
  on conflict (routine_id,routine_date) do nothing;
$$;

create function app_private.team_routine_due(r public.team_task_routines, previous date) returns date
language sql immutable set search_path = '' as $$
  select case r.recurrence
    when 'daily' then previous+1
    when 'weekly' then previous+7
    when 'weekdays' then previous+case extract(isodow from previous) when 5 then 3 when 6 then 2 else 1 end
    when 'monthly' then (date_trunc('month',previous)+interval '1 month')::date
      + least(extract(day from r.starts_on)::int,extract(day from date_trunc('month',previous)+interval '2 months - 1 day')::int)-1
  end;
$$;

create function app_private.team_routine_next() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.team_task_routines; due date;
begin
  if new.routine_id is null or new.status <> 'done' or old.status = 'done' then return new; end if;
  select * into r from public.team_task_routines where id=new.routine_id and active for update;
  if not found then return new; end if;
  due := app_private.team_routine_due(r,new.routine_date);
  -- Re-completing an older card must not start a second branch after an edit.
  if not exists (select 1 from public.team_tasks where routine_id=r.id and routine_date>new.routine_date) then
    perform app_private.team_routine_occurrence(r,due);
  end if;
  return new;
end;
$$;
create trigger team_routine_next after update of status on public.team_tasks
for each row execute function app_private.team_routine_next();

create function public.team_routines(p_team_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
  access text := app_private.require_team_member(p_team_id,me);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'title',r.title,'assignee_id',r.assignee_id,
    'recurrence',r.recurrence,'starts_on',r.starts_on,'active',r.active,
    'can_edit',access='owner' or r.created_by=me.user_id) order by r.active desc,r.title,r.id)
    from public.team_task_routines r where r.team_id=p_team_id),'[]'::jsonb);
end;
$$;

create function public.team_routine_save(p_team_id uuid,p_title text,p_assignee_id text,p_recurrence text,
  p_starts_on date,p_id uuid default null,p_active boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me public.app_users := app_private.require_active();
  access text := app_private.require_team_member(p_team_id,me);
  r public.team_task_routines;
  due date;
  latest public.team_tasks;
begin
  perform app_private.check_task_fields(p_team_id,p_title,p_assignee_id,'todo');
  if p_starts_on is null or p_recurrence is null or p_recurrence not in ('daily','weekdays','weekly','monthly') then
    raise exception 'Choose a start date and recurrence.' using errcode='22023';
  end if;
  if p_id is null then
    insert into public.team_task_routines(team_id,title,assignee_id,recurrence,starts_on,created_by)
    values(p_team_id,btrim(p_title),p_assignee_id,p_recurrence,p_starts_on,me.user_id) returning * into r;
    due := p_starts_on;
    if r.recurrence='weekdays' and extract(isodow from due)>5 then due:=due+(8-extract(isodow from due)::int); end if;
    perform app_private.team_routine_occurrence(r,due);
  else
    update public.team_task_routines set title=btrim(p_title),assignee_id=p_assignee_id,recurrence=p_recurrence,active=p_active
    where id=p_id and team_id=p_team_id and (access='owner' or created_by=me.user_id) returning * into r;
    if not found then raise exception 'Only the routine creator or team owner can edit it.' using errcode='42501'; end if;
    if r.active then
      select * into latest from public.team_tasks where routine_id=r.id order by routine_date desc limit 1;
      if latest.status='done' then
        perform app_private.team_routine_occurrence(r,app_private.team_routine_due(r,latest.routine_date));
      end if;
    end if;
  end if;
  perform app_private.log_team(p_team_id,me.user_id,case when p_id is null then 'routine_added' else 'routine_edited' end,r.title);
  return jsonb_build_object('id',r.id);
end;
$$;

revoke all on function app_private.set_remark_team(), app_private.require_team_member(uuid,public.app_users),
  app_private.team_routine_occurrence(public.team_task_routines,date),app_private.team_routine_due(public.team_task_routines,date),app_private.team_routine_next() from public,anon,authenticated;
revoke all on function public.team_remark_inbox(uuid),public.team_remark_thread(uuid,uuid),
  public.team_remark_post(uuid,text,boolean,uuid),public.team_remark_resolve(uuid,uuid),public.team_remark_read(uuid,jsonb),
  public.team_routines(uuid),public.team_routine_save(uuid,text,text,text,date,uuid,boolean) from public,anon,authenticated;
grant execute on function public.team_remark_inbox(uuid),public.team_remark_thread(uuid,uuid),
  public.team_remark_post(uuid,text,boolean,uuid),public.team_remark_resolve(uuid,uuid),public.team_remark_read(uuid,jsonb),
  public.team_routines(uuid),public.team_routine_save(uuid,text,text,text,date,uuid,boolean) to authenticated;

notify pgrst,'reload schema';
commit;
