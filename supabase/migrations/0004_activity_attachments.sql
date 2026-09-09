-- Attachments on activity events.
--
-- Both message composers write an attachments array alongside the message --
-- [{name, download_url}] returned by POST /api/attachments -- and the
-- renderers read it back to draw the file chips. The column was missed when
-- the Firestore documents were mapped to tables, so every message send failed
-- with PGRST204 "could not find the 'attachments' column".
--
-- jsonb rather than a child table: the app only ever reads the whole array
-- back with its event and never queries inside it.
--
-- Additive and idempotent.

alter table public.case_activity
  add column if not exists attachments jsonb not null default '[]'::jsonb;
