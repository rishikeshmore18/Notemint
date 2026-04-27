create table if not exists user_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null unique,
  embedding jsonb,
  sample_count integer not null default 0,
  enrollment_status text not null default 'NotEnrolled',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists speaker_profiles (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade not null,
  display_name text not null,
  profile_type text not null default 'contact',
  embedding jsonb,
  sample_count integer not null default 0,
  enrollment_status text not null default 'NotEnrolled',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists meeting_speakers (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references meetings(id) on delete cascade not null,
  raw_speaker_id integer not null,
  display_name text not null,
  speaker_profile_id uuid references speaker_profiles(id) on delete set null,
  match_score numeric,
  confirmed_by_user boolean default false,
  created_at timestamptz default now(),
  unique(meeting_id, raw_speaker_id)
);

alter table user_voice_profiles enable row level security;
alter table speaker_profiles enable row level security;
alter table meeting_speakers enable row level security;

drop policy if exists "Own profile" on user_voice_profiles;
create policy "Own profile" on user_voice_profiles
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Own speaker profiles" on speaker_profiles;
create policy "Own speaker profiles" on speaker_profiles
for all
using (auth.uid() = owner_user_id)
with check (auth.uid() = owner_user_id);

drop policy if exists "Own meeting speakers" on meeting_speakers;
create policy "Own meeting speakers" on meeting_speakers
for all
using (
  exists (
    select 1
    from meetings
    where meetings.id = meeting_speakers.meeting_id
      and meetings.user_id = auth.uid()
  )
);
