-- Run this once in the Supabase SQL Editor for the project at
-- https://xlxkgcbckbjppatmirhc.supabase.co
--
-- Atomic per-player vote write. Replaces the client-side read-modify-write
-- pattern (loadRoom -> mutate -> upsert whole blob) that allowed concurrent
-- voters to silently overwrite each other's votes. Postgres serializes
-- concurrent UPDATEs to the same row, so this closes that race.

create or replace function set_player_vote(p_room_id text, p_pid text, p_vote text)
returns jsonb
language plpgsql
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
