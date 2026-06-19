// Realtime channel setup only — no app state lives here. The caller (app.js) supplies handlers
// and owns whatever mutation/render happens in response to them.
import { sb } from './supabaseClient.js';

// handlers:
//   onRoomChange(roomState, updatedAt) — called on rooms INSERT/UPDATE with payload.new.state directly
//   onRoomDeleted()                    — called on rooms DELETE
//   onVoteUpsert(row)                  — called on votes INSERT/UPDATE with the raw row (player_id, name, vote, joined_at)
//   onVoteDelete(playerId)             — called on votes DELETE with the deleted row's player_id
//   onStatusChange(status, err)        — called whenever the channel's connection status changes
//                                         (status is one of supabase-js's REALTIME_SUBSCRIBE_STATES:
//                                         'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR')
export function subscribeRoom(id, handlers) {
  return sb
    .channel('room:' + id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: 'id=eq.' + id }, (payload) => {
      if (payload.eventType === 'DELETE') {
        handlers.onRoomDeleted();
        return;
      }
      const row = payload.new;
      if (!row || !row.state) return;
      handlers.onRoomChange(row.state, row.updated_at);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'votes', filter: 'room_id=eq.' + id }, (payload) => {
      if (payload.eventType === 'DELETE') {
        const oldRow = payload.old;
        if (oldRow && oldRow.player_id) handlers.onVoteDelete(oldRow.player_id);
        return;
      }
      const row = payload.new;
      if (!row) return;
      handlers.onVoteUpsert(row);
    })
    .subscribe((status, err) => handlers.onStatusChange(status, err));
}

export function unsubscribeRoom(channel) {
  if (channel) sb.removeChannel(channel);
}
