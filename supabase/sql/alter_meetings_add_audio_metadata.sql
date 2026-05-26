alter table public.meetings
add column if not exists audio_storage_path text,
add column if not exists audio_mime_type text,
add column if not exists audio_size_bytes bigint,
add column if not exists audio_duration_seconds integer,
add column if not exists audio_uploaded_at timestamptz,
add column if not exists audio_upload_status text default 'pending';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meetings_audio_upload_status_check'
  ) then
    alter table public.meetings
    add constraint meetings_audio_upload_status_check
    check (audio_upload_status in ('pending', 'uploaded', 'failed'));
  end if;
end $$;

create index if not exists meetings_user_audio_uploaded_idx
on public.meetings (user_id, audio_uploaded_at desc)
where audio_storage_path is not null;
