-- Adjuster working notes.
--
-- 0001 gave case_internal a generic `data jsonb`, but the employee dashboard
-- writes the note and its author as top-level fields of the document:
-- {note, updated_by, updated_at}. Real columns match what the page already
-- reads and writes, and "who last touched this" is worth being queryable
-- rather than buried in a blob.
--
-- data stays for anything else that lands there later; nothing writes it
-- today.
--
-- Additive and idempotent.

alter table public.case_internal
  add column if not exists note       text,
  add column if not exists updated_by text;
