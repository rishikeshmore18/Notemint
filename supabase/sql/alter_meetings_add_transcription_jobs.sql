alter table public.meetings
add column if not exists transcription_status text default 'idle',
add column if not exists transcription_provider text,
add column if not exists transcription_model text,
add column if not exists assemblyai_transcript_id text,
add column if not exists transcription_started_at timestamptz,
add column if not exists transcription_completed_at timestamptz,
add column if not exists transcription_duration_ms integer,
add column if not exists transcription_error text,
add column if not exists transcription_keyterm_count integer default 0,
add column if not exists transcription_used_keyterms boolean default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meetings_transcription_status_check'
  ) then
    alter table public.meetings
    add constraint meetings_transcription_status_check
    check (transcription_status in ('idle', 'processing', 'completed', 'failed'));
  end if;
end $$;

create index if not exists meetings_user_transcription_status_idx
on public.meetings (user_id, transcription_status, created_at desc);

create index if not exists meetings_assemblyai_transcript_id_idx
on public.meetings (assemblyai_transcript_id)
where assemblyai_transcript_id is not null;
