create extension if not exists pgcrypto;

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text,
  transcript_compressed text,
  summary text,
  segments jsonb,
  label_map jsonb,
  duration_segments integer default 0,
  created_at timestamptz not null default now()
);

alter table public.meetings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meetings' and policyname = 'Users can select own meetings'
  ) then
    create policy "Users can select own meetings"
      on public.meetings
      for select
      using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meetings' and policyname = 'Users can insert own meetings'
  ) then
    create policy "Users can insert own meetings"
      on public.meetings
      for insert
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meetings' and policyname = 'Users can update own meetings'
  ) then
    create policy "Users can update own meetings"
      on public.meetings
      for update
      using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'meetings' and policyname = 'Users can delete own meetings'
  ) then
    create policy "Users can delete own meetings"
      on public.meetings
      for delete
      using (auth.uid() = user_id);
  end if;
end $$;

create index if not exists meetings_user_id_created_at_idx
  on public.meetings (user_id, created_at desc);
