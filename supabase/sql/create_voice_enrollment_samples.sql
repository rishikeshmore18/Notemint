create table if not exists voice_enrollment_samples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  enrollment_run_id text not null,
  phrase_index integer not null,
  expected_phrase text not null,
  transcript text,
  phrase_score numeric,
  audio_quality jsonb,
  embedding jsonb,
  accepted boolean not null default false,
  rejection_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, enrollment_run_id, phrase_index)
);

create index if not exists voice_enrollment_samples_user_run_idx
on voice_enrollment_samples(user_id, enrollment_run_id);

alter table voice_enrollment_samples enable row level security;

drop policy if exists "Own voice enrollment samples" on voice_enrollment_samples;
create policy "Own voice enrollment samples" on voice_enrollment_samples
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
