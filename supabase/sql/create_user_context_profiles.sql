create table if not exists user_context_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null unique,
  industry text,
  role text,
  meeting_types jsonb default '[]'::jsonb,
  participant_names jsonb default '[]'::jsonb,
  organization_terms jsonb default '[]'::jsonb,
  custom_terms jsonb default '[]'::jsonb,
  generated_keyterms jsonb default '[]'::jsonb,
  correction_terms jsonb default '[]'::jsonb,
  summary_context text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table user_context_profiles enable row level security;

drop policy if exists "Own context profile" on user_context_profiles;
create policy "Own context profile" on user_context_profiles
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
