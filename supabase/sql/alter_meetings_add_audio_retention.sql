alter table public.meetings
add column if not exists audio_retention_days integer not null default 7,
add column if not exists audio_expires_at timestamptz,
add column if not exists audio_deleted_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'meetings_audio_retention_days_check'
  ) then
    alter table public.meetings
    add constraint meetings_audio_retention_days_check
    check (audio_retention_days between 1 and 365);
  end if;
end $$;

create index if not exists meetings_audio_expiry_idx
on public.meetings (audio_expires_at)
where audio_storage_path is not null
  and audio_deleted_at is null;

drop function if exists public.cleanup_expired_meeting_audio(integer);

create or replace function public.cleanup_expired_meeting_audio(p_limit integer default 500)
returns table (
  meeting_id uuid,
  user_id uuid,
  audio_storage_path text,
  audio_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select
      meeting.id as meeting_id,
      meeting.user_id,
      meeting.audio_storage_path,
      meeting.audio_expires_at
    from public.meetings meeting
    where meeting.audio_storage_path is not null
      and meeting.audio_deleted_at is null
      and meeting.audio_expires_at is not null
      and meeting.audio_expires_at <= now()
    order by meeting.audio_expires_at asc
    limit greatest(1, least(coalesce(p_limit, 500), 1000));
end;
$$;

revoke all on function public.cleanup_expired_meeting_audio(integer) from public;
revoke all on function public.cleanup_expired_meeting_audio(integer) from anon;
revoke all on function public.cleanup_expired_meeting_audio(integer) from authenticated;
grant execute on function public.cleanup_expired_meeting_audio(integer) to service_role;
