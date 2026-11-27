begin;

create table public.team_checklist_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.team_future_projects(id) on delete cascade,
  task_id uuid references public.team_tasks(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 500),
  done boolean not null default false,
  position bigint generated always as identity,
  check ((project_id is null) <> (task_id is null))
);
create index team_checklist_project_idx on public.team_checklist_items(project_id,position);
create index team_checklist_task_idx on public.team_checklist_items(task_id,position);
alter table public.team_checklist_items enable row level security;
revoke all on public.team_checklist_items from public,anon,authenticated;

create function app_private.team_project_manager(p public.team_future_projects,me public.app_users) returns void
language plpgsql stable security definer set search_path='' as $$
declare access text := app_private.require_team_member(p.team_id,me);
begin
  if access <> 'owner' and p.created_by <> me.user_id then
    raise exception 'Only the project creator or team owner can manage this project.' using errcode='42501';
  end if;
end;
$$;

create function app_private.team_checklist(p_project uuid,p_task uuid) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'title',i.title,'done',i.done) order by i.position),'[]'::jsonb)
  from public.team_checklist_items i where i.project_id=p_project or i.task_id=p_task;
$$;

create function public.team_checklist_change(p_project_id uuid,p_task_id uuid,p_item_id uuid,
  p_title text default null,p_done boolean default null,p_remove boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  me public.app_users := app_private.require_active();
  p public.team_future_projects;
  k public.team_tasks;
  project uuid := p_project_id;
  task uuid := p_task_id;
  item uuid;
  access text;
begin
  if (project is null) = (task is null) then raise exception 'Choose a task or project.' using errcode='22023'; end if;
  if project is not null then
    select * into p from public.team_future_projects where id=project for update;
    if not found then raise exception 'Project not found' using errcode='PT404'; end if;
    perform app_private.team_project_manager(p,me);
    if p.moved_task_id is not null then
      task := p.moved_task_id;
      project := null;
      perform 1 from public.team_tasks where id=task for update;
    end if;
  else
    select * into k from public.team_tasks where id=task for update;
    if not found then raise exception 'Task not found' using errcode='PT404'; end if;
    access := app_private.require_team_member(k.team_id,me);
    if access<>'owner' and k.created_by<>me.user_id and k.assignee_id is distinct from me.user_id
       and not exists (select 1 from public.team_future_projects where moved_task_id=task and created_by=me.user_id) then
      raise exception 'You cannot manage these subtasks.' using errcode='42501';
    end if;
  end if;
  if (p_title is not null or p_item_id is null) and not p_remove
     and char_length(btrim(coalesce(p_title,''))) not between 1 and 500 then
    raise exception 'Enter a subtask title of up to 500 characters.' using errcode='22023';
  end if;
  if p_remove then
    delete from public.team_checklist_items
    where id=p_item_id and (project_id=project or task_id=task) returning id into item;
  elsif p_item_id is null then
    insert into public.team_checklist_items(project_id,task_id,title,done)
    values(project,task,btrim(p_title),coalesce(p_done,false)) returning id into item;
  else
    update public.team_checklist_items set title=coalesce(btrim(p_title),title),done=coalesce(p_done,done)
    where id=p_item_id and (project_id=project or task_id=task) returning id into item;
  end if;
  if item is null then raise exception 'Subtask not found' using errcode='PT404'; end if;
  return jsonb_build_object('id',item);
end;
$$;

create function public.team_remark_notifications()
returns jsonb language sql stable security definer set search_path='' as $$
  with me as (select (app_private.require_active()).user_id as id)
  select coalesce(jsonb_agg(jsonb_build_object('id',m.root_id,'team_id',m.team_id,'team_name',m.team_name,
    'title',coalesce(m.task_title,m.body),'unread',m.unread) order by m.latest desc,m.root_id),'[]'::jsonb)
  from (
    select root.id as root_id,t.id as team_id,t.name as team_name,k.title as task_title,root.body,
      count(*) as unread,max(r.created_at) as latest
    from me
    join public.team_members tm on tm.user_id=me.id
    join public.teams t on t.id=tm.team_id
    join public.team_task_remarks r on r.team_id=t.id and r.author_id<>me.id
    join public.team_task_remarks root on root.id=coalesce(r.parent_id,r.id) and root.team_id=t.id
    left join public.team_tasks k on k.id=root.task_id
    where not exists(select 1 from public.team_remark_reads rr where rr.remark_id=r.id and rr.user_id=me.id)
    group by root.id,t.id,k.title
  ) m;
$$;

drop function public.team_task_create(uuid,text,text,date,text,uuid);
create function public.team_task_create(p_team_id uuid, p_title text, p_assignee_id text default null, p_due_date date default null,
                                        p_status text default 'todo', p_category_id uuid default null,p_subtasks jsonb default '[]'::jsonb)
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
  if p_subtasks is null or jsonb_typeof(p_subtasks)<>'array' or jsonb_array_length(p_subtasks)>30
     or exists (select 1 from jsonb_array_elements(p_subtasks) x where jsonb_typeof(x)<>'string'
       or char_length(btrim(x#>>'{}')) not between 1 and 500) then
    raise exception 'Use up to 30 subtasks of 500 characters each.' using errcode='22023';
  end if;
  insert into public.team_checklist_items(task_id,title)
  select tid,btrim(x.value) from jsonb_array_elements_text(p_subtasks) with ordinality x(value,pos) order by x.pos;
  perform app_private.log_team(p_team_id, me.user_id, 'task_created', btrim(p_title));
  return jsonb_build_object('id', tid);
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
  p public.team_future_projects;
  acc text := app_private.require_team_member(p_team_id, me);
begin
  if p_title is null or length(btrim(p_title)) not between 1 and 200 then
    raise exception 'A project needs a title (up to 200 characters).' using errcode = '22023';
  end if;
  if pid is null then
    insert into public.team_future_projects (team_id, title, notes, created_by)
    values (p_team_id, btrim(p_title), nullif(btrim(p_notes), ''), me.user_id) returning id into pid;
    perform app_private.log_team(p_team_id, me.user_id, 'project_added', btrim(p_title));
  else
    select * into p from public.team_future_projects where id=pid and team_id=p_team_id for update;
    if not found then raise exception 'Project not found' using errcode='PT404'; end if;
    perform app_private.team_project_manager(p,me);
    update public.team_future_projects set title = btrim(p_title), notes = nullif(btrim(p_notes), '')
     where id = pid and team_id = p_team_id;
    if not found then raise exception 'Project not found' using errcode = 'PT404'; end if;
  end if;
  return jsonb_build_object('id', pid);
end;
$$;

create or replace function public.team_project_delete(p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.app_users := app_private.require_active();
  p public.team_future_projects;
begin
  select * into p from public.team_future_projects where id = p_project_id for update;
  if not found then raise exception 'Project not found' using errcode = 'PT404'; end if;
  perform app_private.team_project_manager(p,me);
  delete from public.team_future_projects where id = p.id;
  return jsonb_build_object('deleted', p.id);
end;
$$;

create or replace function public.team_project_activate(p_project_id uuid, p_assignee_id text default null, p_due_date date default null)
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
  if not found then raise exception 'Project not found' using errcode = 'PT404'; end if;
  if app_private.team_access(p.team_id, me) <> 'owner' then
    raise exception 'Only the team owner can manage future projects.' using errcode = '42501';
  end if;
  if p.moved_at is not null then
    raise exception 'This project is already in active work.' using errcode = 'P0001';
  end if;
  perform app_private.check_task_fields(p.team_id, p.title, p_assignee_id, 'todo');
  insert into public.team_tasks (team_id, title, assignee_id, due_date, status, created_by, updated_by)
  values (p.team_id, p.title, p_assignee_id, p_due_date, 'todo', me.user_id, me.user_id) returning id into tid;
  update public.team_checklist_items set project_id=null,task_id=tid where project_id=p.id;
  update public.team_future_projects set moved_at = now(), moved_task_id = tid where id = p.id;
  perform app_private.log_team(p.team_id, me.user_id, 'project_started', p.title);
  return jsonb_build_object('task_id', tid);
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
               'id', k.id, 'title', k.title, 'subtasks', app_private.team_checklist(null,k.id), 'status', k.status, 'due_date', k.due_date, 'category_id', k.category_id,
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
                                          'created_by', p.created_by, 'subtasks', app_private.team_checklist(p.id,p.moved_task_id), 'moved_at', p.moved_at, 'moved_task_id', p.moved_task_id)
             order by p.moved_at nulls first, p.created_at)
        from public.team_future_projects p where p.team_id = t.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('at', e.at, 'action', e.action, 'detail', e.detail, 'actor', app_private.person(e.actor_id)) order by e.at desc, e.id desc)
        from (select * from public.team_events where team_id = t.id order by at desc, id desc limit 40) e), '[]'::jsonb));
end;
$$;
revoke all on function app_private.team_project_manager(public.team_future_projects,public.app_users),
  app_private.team_checklist(uuid,uuid) from public,anon,authenticated;
revoke all on function public.team_task_create(uuid,text,text,date,text,uuid,jsonb),
  public.team_checklist_change(uuid,uuid,uuid,text,boolean,boolean), public.team_remark_notifications() from public,anon,authenticated;
grant execute on function public.team_task_create(uuid,text,text,date,text,uuid,jsonb),
  public.team_checklist_change(uuid,uuid,uuid,text,boolean,boolean), public.team_remark_notifications() to authenticated;

notify pgrst,'reload schema';
commit;
