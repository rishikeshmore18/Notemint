create table if not exists transcription_evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  meeting_id uuid references meetings(id) on delete set null,
  provider text not null,
  model text,
  segments jsonb,
  summary text,
  duration_ms integer,
  speaker_count integer,
  segment_count integer,
  correction_count integer default 0,
  transcript_rating integer,
  summary_rating integer,
  notes text,
  manual_speaker_fixes integer default 0,
  best_transcript boolean default false,
  best_summary boolean default false,
  compare_run_id text,
  created_at timestamptz default now()
);

alter table transcription_evaluations
  add column if not exists manual_speaker_fixes integer default 0,
  add column if not exists best_transcript boolean default false,
  add column if not exists best_summary boolean default false,
  add column if not exists compare_run_id text;

alter table transcription_evaluations enable row level security;

drop policy if exists "Own transcription evaluations" on transcription_evaluations;
create policy "Own transcription evaluations" on transcription_evaluations
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create index if not exists transcription_evaluations_user_created_idx
on transcription_evaluations(user_id, created_at desc);

create index if not exists transcription_evaluations_user_provider_idx
on transcription_evaluations(user_id, provider, created_at desc);

create index if not exists transcription_evaluations_compare_run_idx
on transcription_evaluations(user_id, compare_run_id);
