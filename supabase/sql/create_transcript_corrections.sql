create table if not exists transcript_corrections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  meeting_id uuid references meetings(id) on delete cascade,
  provider text,
  original_text text not null,
  corrected_text text not null,
  context_terms_used jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

alter table transcript_corrections enable row level security;

drop policy if exists "Own transcript corrections" on transcript_corrections;
create policy "Own transcript corrections" on transcript_corrections
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create index if not exists transcript_corrections_user_meeting_idx
on transcript_corrections(user_id, meeting_id, created_at desc);
