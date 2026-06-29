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
drop function if exists reveal_round(text);
drop function if exists new_round(text, int);
drop function if exists start_game(text);
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
  round int not null default 1,
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
--
-- Also stamps the row with the room's CURRENT round (read inside the same
-- statement, so it's atomic with the vote write). This is what lets "New
-- Round" make every player's stale vote disappear for every viewer at the
-- exact same instant, with no extra write or per-client cleanup at all: a
-- vote only counts as "cast" when its `round` matches `rooms.state.round`,
-- and that comparison is computed identically by every client off data
-- that's already replicated via realtime. See "5b. New Round" note below.
create or replace function set_vote(p_room_id text, p_player_id text, p_vote text)
returns boolean
language plpgsql
security invoker
as $func$
declare
  affected integer;
begin
  update votes set vote = p_vote,
                    round = (select (state->>'round')::int from rooms where id = p_room_id)
  where room_id = p_room_id and player_id = p_player_id;
  get diagnostics affected = row_count;
  return affected > 0;
end;
$func$;

grant execute on function set_vote(text, text, text) to anon;

-- 4b. Atomic shared-state transitions (reveal / new round / start) -----------
-- `rooms.state` (revealed/round/started) is shared across every player at the
-- table, unlike a per-player vote row. Each function does a single atomic
-- UPDATE with a compare-and-swap WHERE clause (expects the field's current
-- value before flipping it), instead of the client doing load -> mutate JS
-- object -> upsert whole state (a read-modify-write race). If two clients
-- call the same function at nearly the same instant, exactly one UPDATE
-- matches the WHERE clause and takes effect; the other becomes a no-op that
-- falls through to re-reading the row. Either way both callers receive the
-- same authoritative `state` back — there is no path where two clients can
-- walk away with two different "current" states.
create or replace function reveal_round(p_room_id text)
returns jsonb
language plpgsql
security invoker
as $func$
declare
  v_state jsonb;
begin
  update rooms set state = jsonb_set(state, '{revealed}', 'true'),
                   updated_at = now()
  where id = p_room_id and (state->>'revealed') = 'false'
  returning state into v_state;

  if v_state is null then
    select state into v_state from rooms where id = p_room_id;
  end if;
  return v_state;
end;
$func$;

create or replace function new_round(p_room_id text, p_expected_round int)
returns jsonb
language plpgsql
security invoker
as $func$
declare
  v_state jsonb;
begin
  update rooms set state = jsonb_set(jsonb_set(state, '{revealed}', 'false'),
                                      '{round}', to_jsonb(p_expected_round + 1)),
                   updated_at = now()
  where id = p_room_id and (state->>'round')::int = p_expected_round
  returning state into v_state;

  if v_state is null then
    select state into v_state from rooms where id = p_room_id;
  end if;
  return v_state;
end;
$func$;

create or replace function start_game(p_room_id text)
returns jsonb
language plpgsql
security invoker
as $func$
declare
  v_state jsonb;
begin
  update rooms set state = jsonb_set(state, '{started}', 'true'),
                   updated_at = now()
  where id = p_room_id and (state->>'started') = 'false'
  returning state into v_state;

  if v_state is null then
    select state into v_state from rooms where id = p_room_id;
  end if;
  return v_state;
end;
$func$;

grant execute on function reveal_round(text) to anon;
grant execute on function new_round(text, int) to anon;
grant execute on function start_game(text) to anon;

-- 5b. New Round ----------------------------------------------------------
-- There is deliberately no "clear all votes" RPC and no per-client cleanup
-- write either (an earlier design had every client reset its own vote row
-- when it noticed the round change — that worked but left a window where
-- different players' screens disagreed about who'd voted, since each
-- client's self-reset write/realtime-echo landed at a different time on a
-- flaky network). Instead, staleness is a pure read-side computation:
-- `votes.round` is stamped at vote-write time (see `set_vote` above), and a
-- vote only displays as "cast" when `votes.round = rooms.state.round`. Once
-- `new_round()` bumps `rooms.state.round`, every previous round's votes
-- become stale for every viewer in the same instant their `rooms` realtime
-- event arrives — no extra write, no per-player race, no ordering to get
-- wrong.

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
-- select * from votes where room_id = 'TEST01';   -- vote '5', round 1 (stamped from rooms.state.round)
-- select new_round('TEST01', 1);                  -- rooms.state.round -> 2
-- select * from votes where room_id = 'TEST01';   -- vote still '5', round still 1 -> now stale (client treats as not-voted)
-- select set_vote('TEST01', 'p1', null);           -- own-row reset, should return true
-- select * from votes where room_id = 'TEST01';   -- vote null, round bumped to 2

-- Smoke test the atomic shared-state transitions (CAS behavior):
-- insert into rooms (id, state) values ('TEST02', '{"deckType":"fibonacci","cards":["1","2","3"],"revealed":false,"round":1,"started":false}');
-- select reveal_round('TEST02');                   -- revealed -> true
-- select reveal_round('TEST02');                   -- already true: no-op, still returns revealed:true (not an error)
-- select new_round('TEST02', 1);                   -- round 1 -> 2, revealed -> false
-- select new_round('TEST02', 1);                   -- stale expected round: no-op, returns round:2 unchanged
-- select start_game('TEST02');                     -- started -> true
-- delete from rooms where id = 'TEST02';           -- cascades and deletes any votes rows too

-- delete from rooms where id = 'TEST01';           -- cascades and deletes the votes row too
