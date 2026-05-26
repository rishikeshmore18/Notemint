create extension if not exists pg_cron with schema extensions;

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'cleanup-expired-meeting-audio'
  ) then
    perform cron.unschedule('cleanup-expired-meeting-audio');
  end if;
end $$;

-- Physical Storage deletes must be performed through the backend Storage API,
-- not by deleting from storage.objects in SQL.
--
-- Schedule an external cron to POST to:
--   https://<backend-domain>/api/cleanup/expired-audio
--
-- Required header:
--   Authorization: Bearer <CLEANUP_JOB_SECRET>
--
-- Optional JSON body:
--   {"limit":500,"dry_run":false}
