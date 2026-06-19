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
  const { data, error } = await sb.from('votes').select('player_id, name, vote, joined_at').eq('room_id', roomId);
  if (error || !data) return [];
  return data;
}

export async function insertVoteRow(roomId, playerId, name) {
  const { error } = await sb.from('votes').insert({ room_id: roomId, player_id: playerId, name, vote: null });
  if (error) console.error('insertVoteRow error', error);
}

export async function renameVoteRow(roomId, playerId, name) {
  const { error } = await sb.from('votes').update({ name }).eq('room_id', roomId).eq('player_id', playerId);
  if (error) console.error('renameVoteRow error', error);
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

// load -> mutate -> upsert `rooms.state`, retries up to 3x. Used for single-actor room-level
// mutations (reveal/new round/start) where there's no concurrent-writer race to worry about.
export async function updateRoom(id, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const room = await loadRoom(id);
    if (!room) return null;
    fn(room);
    const { error } = await sb.from('rooms').upsert({ id, state: room, updated_at: new Date().toISOString() });
    if (!error) return room;
    console.warn('updateRoom attempt', attempt + 1, 'failed:', error.message);
    await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
  }
  return null;
}
