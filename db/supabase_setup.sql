-- ============================================================================
-- Dead Man's Poker — full Supabase rebuild
-- Run this ENTIRE file once in the Supabase SQL Editor for the project at
-- https://xlxkgcbckbjppatmirhc.supabase.co
--
-- WARNING: this DROPS the existing `rooms` table and everything in it.
-- That's fine for this app — rooms are short-lived planning-poker sessions,
-- there's nothing worth preserving. Do NOT run this if you've stored
-- anything else important in this project's public schema.
-- ============================================================================

-- 1. Clean slate -------------------------------------------------------------
drop function if exists set_player_vote(text, text, text);
drop table if exists rooms cascade;

-- 2. Table ---------------------------------------------------------------
create table rooms (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- 3. Row Level Security ----------------------------------------------------
-- The app uses only the anon key (no auth/login), so anyone with a room id
-- can read/write that room's state. This matches the current trust model
-- (anyone with the invite link can join/vote).
alter table rooms enable row level security;

create policy "anon select rooms" on rooms for select to anon using (true);
create policy "anon insert rooms" on rooms for insert to anon with check (true);
create policy "anon update rooms" on rooms for update to anon using (true);
create policy "anon delete rooms" on rooms for delete to anon using (true);

-- 4. Atomic per-player vote write -------------------------------------------
-- Avoids the read-modify-write race: two players voting at the same time
-- would otherwise both read the same stale blob and the later upsert
-- silently overwrites the earlier player's vote. This is a single atomic
-- UPDATE ... SET state = jsonb_set(...), serialized by Postgres per row.
create or replace function set_player_vote(p_room_id text, p_pid text, p_vote text)
returns jsonb
language plpgsql
security invoker
as $func$
declare
  result jsonb;
begin
  update rooms
  set state = jsonb_set(state, array['players', p_pid, 'vote'], to_jsonb(p_vote)),
      updated_at = now()
  where id = p_room_id
    and state->'players' ? p_pid
  returning state into result;
  return result;
end;
$func$;

grant execute on function set_player_vote(text, text, text) to anon;

-- 5. Realtime ----------------------------------------------------------------
-- Required so other players see votes/reveal/round changes without a manual
-- reload. The Supabase dashboard toggle (Database -> Replication) does
-- exactly this under the hood; running it here makes it explicit/repeatable.
alter publication supabase_realtime add table rooms;

-- ============================================================================
-- Verification queries — run these after the block above to sanity-check.
-- ============================================================================

-- Should show `rooms` is part of the realtime publication:
-- select * from pg_publication_tables where pubname = 'supabase_realtime';

-- Should show the 4 anon policies on rooms:
-- select policyname, cmd from pg_policies where tablename = 'rooms';

-- Smoke test the RPC end-to-end (insert a fake room, vote, check the result):
-- insert into rooms (id, state) values ('TEST01', '{"players":{"p1":{"name":"Test","vote":null,"joinedAt":0}}}');
-- select set_player_vote('TEST01', 'p1', '5');  -- should return the updated state jsonb, not null
-- delete from rooms where id = 'TEST01';
