// All Supabase table/RPC access lives here — no other module imports `sb` directly.
import { sb } from './supabaseClient.js';

export async function loadRoom(id) {
  const { data, error } = await sb.from('rooms').select('state').eq('id', id).single();
  if (error || !data) return null;
  return data.state;
}

export async function saveRoom(id, room) {
  const { error } = await sb.from('rooms').upsert({ id, state: room, updated_at: new Date().toISOString() });
  if (error) console.error('saveRoom error', error);
}

export async function deleteRoom(id) {
  await sb.from('rooms').delete().eq('id', id);
}

export async function loadVotes(roomId) {
  const { data, error } = await sb.from('votes').select('player_id, name, vote, round, joined_at').eq('room_id', roomId);
  if (error || !data) return [];
  return data;
}

export async function insertVoteRow(roomId, playerId, name, round) {
  const { error } = await sb.from('votes').insert({ room_id: roomId, player_id: playerId, name, vote: null, round });
  if (error) { console.error('insertVoteRow error', error); return false; }
  return true;
}

export async function renameVoteRow(roomId, playerId, name) {
  const { error } = await sb.from('votes').update({ name }).eq('room_id', roomId).eq('player_id', playerId);
  if (error) { console.error('renameVoteRow error', error); return false; }
  return true;
}

export async function deleteVoteRow(roomId, playerId) {
  await sb.from('votes').delete().eq('room_id', roomId).eq('player_id', playerId);
}

export async function setVote(id, playerId, vote) {
  const { data, error } = await sb.rpc('set_vote', { p_room_id: id, p_player_id: playerId, p_vote: vote });
  if (error) { console.error('setVote error', error); return false; }
  if (data !== true) { console.warn('setVote: room or player not found'); return false; }
  return true;
}

// Atomic shared-state transitions — each is a single compare-and-swap UPDATE in Postgres (see
// db/supabase_setup.sql), so two clients calling the same one at nearly the same instant always
// converge on one authoritative `state` instead of racing a client-side read-modify-write.
export async function revealRound(id) {
  const { data, error } = await sb.rpc('reveal_round', { p_room_id: id });
  if (error) { console.error('revealRound error', error); return null; }
  return data;
}

export async function newRound(id, expectedRound) {
  const { data, error } = await sb.rpc('new_round', { p_room_id: id, p_expected_round: expectedRound });
  if (error) { console.error('newRound error', error); return null; }
  return data;
}

export async function startGame(id) {
  const { data, error } = await sb.rpc('start_game', { p_room_id: id });
  if (error) { console.error('startGame error', error); return null; }
  return data;
}
