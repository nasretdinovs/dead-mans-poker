-- ============================================================================
-- Dead Man's Poker — full Supabase rebuild
-- Run this ENTIRE file once in the Supabase SQL Editor for the project at
-- https://xlxkgcbckbjppatmirhc.supabase.co
--
-- WARNING: this DROPS the existing `rooms` and `votes` tables and everything
-- in them. That's fine for this app — rooms are short-lived planning-poker
-- sessions, there's nothing worth preserving. Do NOT run this if you've
-- stored anything else important in this project's public schema.
--
-- Architecture: `rooms` holds room-level metadata only (deck, revealed,
-- round, started). Per-player votes live in their own `votes` table (one
-- row per player per room) so a vote write is a single-row atomic UPDATE,
-- never a read-modify-write of a shared blob — this removes the lost-vote
-- race and shrinks the realtime payload for `rooms` to just the metadata.
-- ============================================================================

-- 1. Clean slate -------------------------------------------------------------
drop function if exists set_player_vote(text, text, text);
drop function if exists set_vote(text, text, text);
drop function if exists clear_votes(text);
drop table if exists votes cascade;
drop table if exists rooms cascade;

-- 2. Tables ------------------------------------------------------------------
create table rooms (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table votes (
  room_id text not null references rooms(id) on delete cascade,
  player_id text not null,
  name text not null,
  vote text,
  joined_at timestamptz not null default now(),
  primary key (room_id, player_id)
);

-- 3. Row Level Security ----------------------------------------------------
-- The app uses only the anon key (no auth/login), so anyone with a room id
-- can read/write that room's data. This matches the current trust model
-- (anyone with the invite link can join/vote).
alter table rooms enable row level security;
create policy "anon select rooms" on rooms for select to anon using (true);
create policy "anon insert rooms" on rooms for insert to anon with check (true);
create policy "anon update rooms" on rooms for update to anon using (true);
create policy "anon delete rooms" on rooms for delete to anon using (true);

alter table votes enable row level security;
create policy "anon select votes" on votes for select to anon using (true);
create policy "anon insert votes" on votes for insert to anon with check (true);
create policy "anon update votes" on votes for update to anon using (true);
create policy "anon delete votes" on votes for delete to anon using (true);

-- 4. Atomic per-player vote write -------------------------------------------
-- A single-row UPDATE against `votes` — no jsonb_set, no read-modify-write,
-- no contention with other players' rows (they're separate rows entirely).
-- Returns true iff a row was actually updated, so the client can detect
-- "room/player not found" and roll back its optimistic UI update.
create or replace function set_vote(p_room_id text, p_player_id text, p_vote text)
returns boolean
language plpgsql
security invoker
as $func$
declare
  affected integer;
begin
  update votes set vote = p_vote
  where room_id = p_room_id and player_id = p_player_id;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$func$;

grant execute on function set_vote(text, text, text) to anon;

-- Note: there is deliberately no "clear all votes" RPC. "New Round" is
-- implemented as every connected client independently resetting only its
-- OWN vote row when it notices the room's `round` changed (see
-- `maybeResetOwnVoteForNewRound` in index.html). A blanket "set every row's
-- vote to null" write would race with anyone voting for the new round while
-- that write is still in flight, silently wiping their fresh vote — single
-- writer per row is the invariant that keeps `votes` race-free.

-- 5. Realtime ----------------------------------------------------------------
-- Required so other players see vote/room changes without a manual reload.
alter publication supabase_realtime add table rooms;
alter publication supabase_realtime add table votes;

-- ============================================================================
-- Verification queries — run these after the block above to sanity-check.
-- ============================================================================

-- Should show both `rooms` and `votes` in the realtime publication:
-- select * from pg_publication_tables where pubname = 'supabase_realtime';

-- Should show the 4 anon policies on each table:
-- select tablename, policyname, cmd from pg_policies where tablename in ('rooms','votes');

-- Smoke test set_vote end-to-end:
-- insert into rooms (id, state) values ('TEST01', '{"deckType":"fibonacci","cards":["1","2","3"],"revealed":false,"round":1,"started":false}');
-- insert into votes (room_id, player_id, name, vote) values ('TEST01', 'p1', 'Test', null);
-- select set_vote('TEST01', 'p1', '5');           -- should return true
-- select set_vote('TEST01', 'p_missing', '5');    -- should return false
-- select set_vote('TEST01', 'p1', null);           -- own-row reset, should return true
-- select * from votes where room_id = 'TEST01';   -- vote should be null again
-- delete from rooms where id = 'TEST01';           -- cascades and deletes the votes row too
