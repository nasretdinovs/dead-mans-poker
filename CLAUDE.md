# Dead Man's Poker — Project Context

## What it is
Planning poker app in Red Dead Redemption / Wild West style.
Single HTML file deployed on GitHub Pages.

## Stack
- **Frontend:** Vanilla JS, CSS, HTML — single file `index.html`
- **Backend:** Supabase (Postgres + Realtime)
- **Hosting:** GitHub Pages

## Supabase
- **URL:** `https://xlxkgcbckbjppatmirhc.supabase.co`
- **Anon key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhseGtnY2Jja2JqcHBhdG1pcmhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NTQ5MjYsImV4cCI6MjA5NzEzMDkyNn0.ZOTi9xvHdTrdsmsIhR8a-V_YVw1NwoxTQkPbjpwapWQ`
- **Table:** `rooms` with fields `id text PK`, `state jsonb`, `updated_at timestamptz`
- **RLS:** enabled, anon policies for select/insert/update/delete
- **Full schema/RLS/RPC/realtime setup:** `db/supabase_setup.sql` — single idempotent-ish script (drops and recreates `rooms`) that is the source of truth for the whole Supabase side. Re-run it any time the dashboard config is suspected to be wrong/drifted.

## DB state shape (jsonb field `state`)
```json
{
  "deckType": "fibonacci",
  "cards": ["1","2","3","5","8","13","21","34","55","89"],
  "players": {
    "p<uuid>": { "name": "Alice", "vote": null, "joinedAt": 1234567890 }
  },
  "revealed": false,
  "round": 1,
  "started": false
}
```

## Player identification
- `pid` stored in `localStorage` (key `dmp_pid`)
- Migrated from sessionStorage because sessionStorage resets on URL change
- Format: `p` + random base36 + timestamp base36

## Routing
- Uses `location.hash` (`#ROOMID`) — NOT query string
- Also supports legacy `?room=ROOMID` links for backwards compatibility
- Hash change does NOT trigger page reload (unlike `?room=`)

## Screens
1. `screen-lobby` — create room, choose deck
2. `screen-join` — join via invite link
3. `screen-waiting` — waiting room, invite link, Start button
4. `screen-game` — poker table

Screen switching via `showOnly(id)` — just `display:none/block`, no DOM recreation.

## Realtime
- Supabase `postgres_changes` on `rooms` table, filtered by `id`
- On any change: read `payload.new.state` directly (no extra `loadRoom()` round-trip) → update `currentRoom` → `renderWaiting()` or `renderGame()`
- A module-level `lastAppliedUpdatedAt` guards against out-of-order event delivery (compares `payload.new.updated_at` as ISO-8601 strings; ignores anything not newer than what's already applied)
- Channel name: `room:ROOMID`

## Decks
```js
fibonacci:  ['1','2','3','5','8','13','21','34','55','89']
modified:   ['0','½','1','2','3','5','8','13','20','40','100','?']
powers2:    ['1','2','4','8','16','32','64']
tshirt:     ['XS','S','M','L','XL','XXL']
hours:      ['1','2','4','8','16','24','32','40']
```

## Game logic
- Each player sees **themselves at the bottom center** of the table (seating rotates by `myIndex`)
- Cards placed face-down, revealed all at once via button
- After reveal: average (numeric decks) or mode (T-shirt)
- `New Round` resets all votes, increments `round`
- Last player to leave deletes the room from DB

## Key functions
- `createRoom()` — generates 6-char ID, saves to Supabase, sets hash
- `joinRoom()` — reads `urlRoom` from hash/query; if `pid` already has an entry in `room.players` this is a **rejoin** (e.g. after a page reload) and skips the name-collision check, only updating `name` and preserving the existing `vote`/`joinedAt`; otherwise it's a new player and the name-collision check excludes the caller's own `pid`
- `subscribeRoom(id)` — sets up Realtime channel
- `renderWaiting()` — updates waiting screen innerHTML
- `renderGame()` — updates game screen: seats, center area, hand cards
- `doVote(card)` — optimistic local update + `setVote()` RPC call, rolls back + toast on failure
- `setVote(id, playerId, vote)` — calls the `set_player_vote` Postgres RPC (atomic `jsonb_set` on `rooms.state`), avoids the read-modify-write race that plain `updateRoom` has when multiple players vote concurrently
- `doReveal()` — optimistic update + server write
- `doNewRound()` — optimistic update + server write
- `updateRoom(id, fn)` — load → mutate → upsert, retries up to 3x; still used for single-actor actions (reveal/new round/start/join/leave) where the lost-update race doesn't apply
- `leaveRoom()` — removes pid from players, deletes room if empty
- `showVoteError(msg)` — bottom-of-screen toast for failed vote writes

## State variables
```js
let pid            // player ID from localStorage
let currentRoom    // current room state object
let currentRoomId  // current room ID string
let realtimeSub    // Supabase realtime channel
let votingLocked   // mutex flag to prevent double-votes
let copiedTimer    // timeout for "Copied!" button feedback
const urlRoom      // room ID parsed from URL on page load
```

## Bugs fixed
- `pid` reset on URL change → moved to `localStorage`
- Full page reload on `?room=` on GitHub Pages → moved to `#hash`
- Page flash on every action → removed full re-render, only update specific innerHTML sections
- Hover triggered re-render → removed `hoverCard` from state, pure CSS `:hover` now
- Seating didn't respect player perspective → added `rotationOffset` based on `myIndex`
- **Clicking a card appeared to do nothing** — `doVote()` had no optimistic UI update; it awaited a full network round-trip (`updateRoom`'s read-modify-write, up to 3 retries) before re-rendering. Fixed by mutating local state and calling `renderGame()` immediately on click, then writing to the server in the background with rollback + toast (`showVoteError`) on failure.
- **Second player was voting for everyone (lost-update race)** — the old retry logic in `updateRoom` only retried on *upsert errors*, not on stale reads, so concurrent votes from two players could have the later write silently overwrite the earlier player's vote (both started from the same stale `rooms.state` blob). Fixed by routing `doVote` through a new `set_player_vote` Postgres RPC that does an atomic `UPDATE ... SET state = jsonb_set(...)` directly in Postgres — concurrent updates to the same row are serialized by Postgres, so no vote is lost. Requires the SQL function to be created once in the Supabase SQL editor (see `db/supabase_setup.sql`).
- **Reload/rejoin self-blocked ("That name is already at the table")** — `initJoin()` always shows the Join screen for any visit to a room URL, including reloads of an already-joined player/host. `joinRoom()`'s name-collision check used to compare against *all* players including the caller's own existing entry (same `pid`, same `localStorage`), so any reload permanently locked that player out of their own room — looked exactly like "can't select any cards" since they were stuck on the Join screen, not the game screen. Fixed by detecting `isRejoin = !!room.players[pid]` and skipping the collision check entirely for rejoins (only the name field is refreshed; `vote`/`joinedAt` are preserved). New players still get the collision check, now explicitly excluding their own `pid` from the comparison.

## Open issues
- The whole-room-as-one-jsonb-blob model is still used for room metadata (deck, revealed, round, started) and is a planned target for a `votes` table split in a later refactor — see project history for the planned `votes` table migration that would remove `jsonb_set` entirely.
- `renderGame()` still fully tears down and rebuilds the seats/hand-card DOM on every render (cosmetic jank, not breakage) — deferred to the same future refactor.
- Verify in the Supabase dashboard (Database → Replication) that Realtime is actually enabled for the `rooms` table — if not, `postgres_changes` never fires and players never see each other's votes update without a manual reload, which independently looks like "everything is out of sync."
- **~15s update delay + flip-flopping/resets after Realtime was confirmed working** — `subscribeRoom()`'s event handler used to call `await loadRoom(id)` (a fresh `SELECT`) on every single realtime event instead of using the row already delivered in `payload.new`. Two problems: (1) every vote added a full extra DB round-trip before anything rendered: (2) concurrent `loadRoom()` calls triggered by rapid back-to-back events had no ordering guarantee, so a slower-but-earlier fetch could resolve after a faster-but-later one and silently overwrite fresher state with stale state — looked exactly like cards resetting/flip-flopping with no further user action. Fixed by reading `payload.new.state` directly (synchronous, no extra query) plus a `lastAppliedUpdatedAt` monotonic guard that drops any event whose `updated_at` isn't newer than what's already applied.

## Design tokens
- **Fonts:** Cinzel Decorative (title), Cinzel (UI labels), Cormorant Garamond (body), Playfair Display (card numbers)
- **Colors:** background `#0d0906`, gold `#c8922a`, felt `#1e3d2a`, parchment `#e8d5a3`, danger `#6b1515`
- **Animations:** flicker on title, rise on screen appear, glow on reveal button, CSS 3D card flip

## Conversation history summary

### Session goal
Build a real multiplayer planning poker web app with Wild West aesthetic,
deployable as a single HTML file on GitHub Pages.

### Evolution
1. Started with prompt engineering for Claude Design
2. First version used localStorage sync between tabs (no real multiplayer)
3. Invite links didn't work — claudeusercontent.com requires auth token
4. Moved to GitHub Pages + Supabase for real multiplayer
5. Multiple rendering/state bugs fixed iteratively:
   - Full re-render on every state change caused flashing
   - pid stored in sessionStorage reset on navigation
   - Hash routing replaced query string routing
   - Seating perspective fixed per-player
