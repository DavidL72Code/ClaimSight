-- Local stand-in for the parts of Supabase the policies rely on. These
-- definitions match Supabase's own: auth.uid() and auth.jwt() read the JWT
-- claims that PostgREST puts into the request.jwt.claims GUC.
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb, '{}'::jsonb);
$$;

-- PostgREST runs queries as `authenticated` for a signed-in user.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
end
$$;

grant usage on schema public, auth to authenticated, anon;
