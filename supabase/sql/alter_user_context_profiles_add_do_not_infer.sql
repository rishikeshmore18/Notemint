alter table if exists user_context_profiles
add column if not exists do_not_infer jsonb default '[]'::jsonb;
