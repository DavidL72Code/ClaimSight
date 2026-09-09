-- Enable change delivery for the tables the UI watches.
--
-- Supabase does not put new tables into the supabase_realtime publication, so
-- postgres_changes subscriptions attach and report "joined" but never receive
-- anything. That is silent: the watchers still do their initial read, so a
-- page looks like it works and simply stops updating -- exactly what
-- onSnapshot used to do for free.
--
-- REPLICA IDENTITY FULL matters as much as the publication. Realtime applies
-- RLS to each change before delivering it, and for UPDATE and DELETE it needs
-- the old row to make that decision. With the default identity only the
-- primary key is published, so the policy check cannot run and the event is
-- dropped -- which would have broken every case-status update while message
-- inserts kept working.
--
-- Guarded so this file also applies to a plain Postgres, where the Supabase
-- publication does not exist, and so re-running it is safe.

alter table public.cases         replica identity full;
alter table public.case_activity replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Local Postgres: nothing subscribes, so there is nothing to publish to.
    raise notice 'supabase_realtime publication not present; skipping';
    return;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'cases'
  ) then
    alter publication supabase_realtime add table public.cases;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'case_activity'
  ) then
    alter publication supabase_realtime add table public.case_activity;
  end if;
end
$$;
