insert into storage.buckets (id, name, public)
values ('meeting-audio', 'meeting-audio', false)
on conflict (id) do update
set public = false;

drop policy if exists "Users can read own meeting audio" on storage.objects;
create policy "Users can read own meeting audio"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'meeting-audio'
  and name ~ '^[a-zA-Z0-9-]+/[a-zA-Z0-9-]+/recording[.][a-z0-9]+$'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.meetings
    where meetings.user_id = auth.uid()
      and meetings.id::text = (storage.foldername(name))[2]
  )
);

drop policy if exists "Users can upload own meeting audio" on storage.objects;
create policy "Users can upload own meeting audio"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'meeting-audio'
  and name ~ '^[a-zA-Z0-9-]+/[a-zA-Z0-9-]+/recording[.][a-z0-9]+$'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.meetings
    where meetings.user_id = auth.uid()
      and meetings.id::text = (storage.foldername(name))[2]
  )
);

drop policy if exists "Users can update own meeting audio" on storage.objects;
create policy "Users can update own meeting audio"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'meeting-audio'
  and name ~ '^[a-zA-Z0-9-]+/[a-zA-Z0-9-]+/recording[.][a-z0-9]+$'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.meetings
    where meetings.user_id = auth.uid()
      and meetings.id::text = (storage.foldername(name))[2]
  )
)
with check (
  bucket_id = 'meeting-audio'
  and name ~ '^[a-zA-Z0-9-]+/[a-zA-Z0-9-]+/recording[.][a-z0-9]+$'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.meetings
    where meetings.user_id = auth.uid()
      and meetings.id::text = (storage.foldername(name))[2]
  )
);

drop policy if exists "Users can delete own meeting audio" on storage.objects;
create policy "Users can delete own meeting audio"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'meeting-audio'
  and name ~ '^[a-zA-Z0-9-]+/[a-zA-Z0-9-]+/recording[.][a-z0-9]+$'
  and (storage.foldername(name))[1] = auth.uid()::text
  and exists (
    select 1
    from public.meetings
    where meetings.user_id = auth.uid()
      and meetings.id::text = (storage.foldername(name))[2]
  )
);
