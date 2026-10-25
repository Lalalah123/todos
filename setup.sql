-- 在 Supabase Dashboard → SQL Editor 中整段执行一次
-- 打开：https://supabase.com/dashboard/project/drhmwhwwexlebrdczyee/sql/new

create table if not exists todo_state (
  id text primary key,
  todos jsonb not null default '[]'::jsonb,
  archives jsonb not null default '[]'::jsonb,
  tab text not null default 'todos',
  mode text not null default 'task',
  updated_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table todo_state to anon, authenticated;

alter table todo_state enable row level security;

drop policy if exists "todo_state_anon_all" on todo_state;
create policy "todo_state_anon_all"
  on todo_state
  for all
  to anon, authenticated
  using (true)
  with check (true);

insert into todo_state (id, todos, archives, tab, mode)
values ('main', '[]'::jsonb, '[]'::jsonb, 'todos', 'task')
on conflict (id) do nothing;

-- 多端实时同步
do $$
begin
  alter publication supabase_realtime add table todo_state;
exception
  when duplicate_object then null;
end $$;
