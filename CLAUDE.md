# Dead Man's Poker — Project Context

## What it is
Planning poker app in Red Dead Redemption / Wild West style.
Built with Vite, deployed as static files on GitHub Pages.

## Stack
- **Frontend:** Vanilla JS (ES modules) + CSS/HTML, bundled with Vite. `index.html` is the Vite entry (CSS/markup live there, JS lives in `src/`).
- **Backend:** Supabase (Postgres + Realtime)
- **Hosting:** GitHub Pages (deployed from a GitHub Actions workflow, not a committed branch)

## Project layout
```
index.html            # Vite entry — CSS + markup unchanged, single <script type="module" src="/src/main.js">
src/
  main.js             # bootstrap — only file with top-level side effects, calls app.init()
  app.js              # owns all mutable app state (currentRoom, currentVotes, pid, ...) and orchestrates everything else
  db.js               # all Supabase table/RPC access (rooms + votes) — no other module imports `sb` directly
  realtime.js         # subscribeRoom(id, handlers) — channel setup only, no app state
  render.js           # renderWaiting(), renderGame() — DOM-producing
  ui.js               # showOnly, copyLink, showError, showVoteError — stateless DOM/UX helpers
  state.js            # pure logic: votesToPlayers, computeResult, toNumericVote, decideRoundReset, resolveJoin, getRoomFromUrl, makeRoomId, escHtml
  seats.js            # pure seat-position math (computeSeatPositions)
  decks.js            # DECKS constant
  supabaseClient.js   # createClient(...) singleton, reads import.meta.env
tests/
  state.test.js       # Vitest — covers state.js, including regression tests for past bugs (rejoin self-block, computeResult's sub-count quirk)
  seats.test.js       # Vitest — covers seats.js
db/supabase_setup.sql # Supabase schema/RLS/RPC/realtime — unchanged by the Vite migration
.github/workflows/deploy.yml  # npm test -> npm run build -> deploy to GitHub Pages via Actions artifact
```
`npm run dev` (local dev server), `npm run build && npm run preview` (prod build smoke test), `npm test` (Vitest). `.env` (gitignored) holds `VITE_SUPABASE_URL`/`VITE_SUPABASE_KEY` for local dev; CI supplies the same two as repository **variables** (not secrets — the anon key is RLS-gated and already shipped client-side).

## Supabase
- **URL:** `https://xlxkgcbckbjppatmirhc.supabase.co`
- **Anon key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhseGtnY2Jja2JqcHBhdG1pcmhjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NTQ5MjYsImV4cCI6MjA5NzEzMDkyNn0.ZOTi9xvHdTrdsmsIhR8a-V_YVw1NwoxTQkPbjpwapWQ`
- **Table `rooms`:** `id text PK`, `state jsonb` (room-level metadata only — no longer holds players), `updated_at timestamptz`
- **Table `votes`:** `room_id text` (FK → `rooms.id` on delete cascade), `player_id text`, `name text`, `vote text` (nullable), `joined_at timestamptz`; primary key `(room_id, player_id)`. One row per player per room — a vote write is a single-row atomic `UPDATE`, never a read-modify-write of a shared blob.
- **RLS:** enabled on both tables, anon policies for select/insert/update/delete
- **Full schema/RLS/RPC/realtime setup:** `db/supabase_setup.sql` — single script (drops and recreates `rooms` + `votes`) that is the source of truth for the whole Supabase side. Re-run it any time the dashboard config is suspected to be wrong/drifted.

## DB state shape (jsonb field `rooms.state`)
```json
{
  "deckType": "fibonacci",
  "cards": ["1","2","3","5","8","13","21","34","55","89"],
  "revealed": false,
  "round": 1,
  "started": false
}
```
Per-player data (`name`, `vote`, `joinedAt`) lives in the `votes` table, not in this blob. Client-side, `currentVotes` (keyed by `player_id`) is the live in-memory mirror of that table, and `currentRoom.players` is always pointed at the same object (`currentRoom.players = currentVotes`) so `renderWaiting()`/`renderGame()`/`computeResult()` can keep reading `room.players` unchanged.

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
- One channel (`room:ROOMID`) subscribed to `postgres_changes` on **both** `rooms` (filtered by `id`) and `votes` (filtered by `room_id`)
- `rooms` events: read `payload.new.state` directly (no extra `loadRoom()` round-trip), merge onto `currentRoom` via `Object.assign`, keep `currentRoom.players` pointed at `currentVotes`. A module-level `lastAppliedUpdatedAt` guards against out-of-order event delivery (compares `payload.new.updated_at` as ISO-8601 strings; ignores anything not newer than what's already applied).
- `votes` events: apply the single changed row directly into `currentVotes` (INSERT/UPDATE → `currentVotes[row.player_id] = {...}`; DELETE → `delete currentVotes[payload.old.player_id]`) — no extra `loadVotes()` round-trip, no ordering race, since each event is applied independently and idempotently.
- Both handlers call a shared `renderAfterChange()` that picks `showGame()` vs `renderWaiting()` based on `currentRoom.started`.

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
Most of these live in `src/app.js` (orchestration) calling into `src/db.js` (Supabase access) and `src/state.js` (pure decision logic — `decideRoundReset`, `resolveJoin`). Behavior is unchanged from before the Vite migration, just split across files:
- `createRoom()` — generates 6-char ID, saves room metadata to `rooms`, inserts the host's row into `votes` via `insertVoteRow()`
- `joinRoom()` — reads `urlRoom` from hash/query, loads `votes` rows via `loadVotes()`; if a row for `pid` already exists this is a **rejoin** (e.g. after a page reload) — skips the name-collision check, only renaming via `renameVoteRow()`, preserving the existing `vote`/`joinedAt`; otherwise it's a new player, the name-collision check excludes the caller's own `pid`, and a new row is inserted
- `subscribeRoom(id)` — sets up the Realtime channel covering both `rooms` and `votes`
- `renderWaiting()` / `renderGame()` — read `room.players` (= `currentVotes`) exactly as before; unaware that the data now comes from a separate table
- `doVote(card)` — optimistic local update of `currentVotes[pid].vote` + `setVote()` RPC call, rolls back + toast on failure
- `setVote(id, playerId, vote)` — calls the `set_vote` Postgres RPC, a plain single-row `UPDATE votes ... WHERE room_id = ... AND player_id = ...`; returns `true`/`false` (row found or not) so the client can roll back
- `maybeResetOwnVoteForNewRound(newRound)` — called whenever `currentRoom.round` is (re)applied (locally in `doNewRound()`, and from the `rooms`-table realtime handler for every other connected client); if the round actually changed since last seen, resets **only the caller's own** `currentVotes[pid].vote` and writes it via `setVote(..., null)`. There is deliberately no "clear every player's vote" RPC — see Bugs fixed below.
- `doReveal()` — optimistic update + server write (room metadata only, `updateRoom`)
- `doNewRound()` — optimistic local bump of `revealed`/`round` + `maybeResetOwnVoteForNewRound()` (resets the clicker's own vote) + `updateRoom()` to persist `revealed`/`round`; every other player resets their own vote independently when they observe the round change
- `updateRoom(id, fn)` — load → mutate → upsert `rooms.state` (now metadata-only, no `players` key), retries up to 3x; used for single-actor room-level actions (reveal/new round/start)
- `leaveRoom()` — deletes the caller's row from `votes`; if no rows remain for the room, deletes the room too
- `showVoteError(msg)` — bottom-of-screen toast for failed vote writes

## State variables
```js
let pid            // player ID from localStorage
let currentRoom    // current room metadata, with .players always === currentVotes
let currentRoomId  // current room ID string
let currentVotes   // player_id -> { name, vote, joinedAt }, mirrors the `votes` table
let realtimeSub    // Supabase realtime channel
let votingLocked   // mutex flag to prevent double-votes
let lastSeenRound  // last `round` value this client has observed, for `maybeResetOwnVoteForNewRound`
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
- **Second player was voting for everyone (lost-update race)** — the old retry logic in `updateRoom` only retried on *upsert errors*, not on stale reads, so concurrent votes from two players could have the later write silently overwrite the earlier player's vote (both started from the same stale `rooms.state` blob). First fixed with a `set_player_vote` RPC doing atomic `jsonb_set` on the shared blob (superseded, see below); the real fix is the `votes` table split — each player's vote is now its own row, so there's no shared blob to race over at all.
- **~15s update delay + flip-flopping/resets** — `subscribeRoom()`'s event handler used to call `await loadRoom(id)` (a fresh `SELECT`) on every single realtime event instead of using the row already delivered in `payload.new`; concurrent `loadRoom()` calls from rapid back-to-back events had no ordering guarantee, so a slower-but-earlier fetch could resolve after a faster-but-later one and overwrite fresher state with stale state. Fixed by reading `payload.new` directly for both `rooms` and `votes` events (no extra query, no race) — see the `votes`-table migration below, which is also what made the `rooms` blob small enough that this stopped being a meaningful bottleneck on its own.
- **Backend hardened: jsonb blob → dedicated `votes` table** — `rooms.state.players` (a single jsonb map mutated via read-modify-write or `jsonb_set`) was replaced with a `votes` table, one row per player per round-trip-free atomic `UPDATE`. `set_player_vote` (jsonb RPC) was replaced by `set_vote` (plain-column RPC). Realtime now subscribes to both tables on one channel; `votes` events are applied incrementally into the client-side `currentVotes` map rather than re-fetched, avoiding the same kind of ordering race fixed above. `rooms.state` is now metadata-only (`deckType`, `cards`, `revealed`, `round`, `started`), so every `updateRoom()` upsert is smaller and never touches contended per-player data.
- **Everything broke again after "New Round"** — the first cut of the `votes` migration added a `clear_votes` RPC that blanket-updated *every* player's row to `vote = null` in one statement. That broke the "single writer per row" invariant the rest of the design relies on: if another player voted for the new round while that blanket write was still in flight (different session, unrelated network latency), the blanket write could commit *after* their fresh vote and silently wipe it — same failure shape as the original lost-vote race, just relocated. Fixed by removing `clear_votes` entirely; instead, every connected client runs `maybeResetOwnVoteForNewRound()` and resets only its **own** vote row when it notices `currentRoom.round` changed (detected in the `rooms`-table realtime handler for everyone, and inline for whoever clicked "New Round"). No row is ever written by anyone other than its owner. Trade-off: a player whose tab isn't open during the round change won't get their stale vote cleared until they reopen the app and the round-change detection fires for them — acceptable since it's a purely cosmetic "ghost vote" on one seat, not a correctness/lost-data issue.
- **Reload/rejoin self-blocked ("That name is already at the table")** — `initJoin()` always shows the Join screen for any visit to a room URL, including reloads of an already-joined player/host. `joinRoom()`'s name-collision check used to compare against *all* players including the caller's own existing entry (same `pid`, same `localStorage`), so any reload permanently locked that player out of their own room — looked exactly like "can't select any cards" since they were stuck on the Join screen, not the game screen. Fixed by detecting `isRejoin = !!room.players[pid]` and skipping the collision check entirely for rejoins (only the name field is refreshed; `vote`/`joinedAt` are preserved). New players still get the collision check, now explicitly excluding their own `pid` from the comparison.
- **Untested single file → Vite + ES modules + Vitest** — all the gameplay/backend logic above was correct but lived in one 800-line `<script>` block with zero automated tests, so every new fix risked silently reintroducing a previously-fixed race. Decomposed into `src/` modules (see Project layout above) with no behavior changes — same `index.html` markup/CSS, same Supabase schema, same game logic. The trickiest decision logic (`resolveJoin` for the rejoin/name-collision bug above, `decideRoundReset` for the New Round bug above, `computeResult`'s average-vs-mode math) is now covered by Vitest regression tests in `tests/`, including explicit tests pinned to the exact bugs in this list so they can't silently come back. Deploys now go through `.github/workflows/deploy.yml` (build + test + deploy) instead of serving `index.html` directly from the repo root.
- **"New Round" silently did nothing, not even for the clicker** — `doReveal()` and `doNewRound()` share one `votingLocked` flag to stop their `updateRoom()` writes from landing out of order; the guard (`if (votingLocked) return;`) was silent. Clicking "New Round" while Reveal's write was still in flight (slow network — the original "everything is laggy" complaint) hit this guard and no-opped with zero feedback, looking exactly like the action was broken rather than just blocked for a moment. Diagnosed via a Realtime connection-status indicator and per-event console logging added to `src/realtime.js`/`src/app.js`/`src/ui.js` (still present — `[realtime]`/`[realtime:event]` console lines, "● live" badge on the waiting/game screens) which ruled out actual Realtime delivery as the cause. Fixed by surfacing the block via the existing `showVoteError()` toast and a `console.warn` instead of swallowing it; the lock itself is intentionally still in place (it does prevent a real out-of-order write race between the two actions).
- **Failed join silently seated a "phantom" player** — `insertVoteRow`/`renameVoteRow` in `src/db.js` only `console.error`'d on failure; `joinRoom()`/`createRoom()` in `src/app.js` always proceeded to the waiting/game screen regardless, so a player could see themselves seated locally while their row never actually existed in `votes` (observed in the wild as a `CORS Failed` / `NetworkError` on the `POST .../votes` insert, alongside a Cloudflare `__cf_bm` cookie rejection — likely an edge/network-level hiccup, not application code). Fixed by having both functions return `true`/`false` like `setVote` already did, and having `joinRoom()`/`createRoom()` show an error and stay on the current screen instead of advancing when the write fails.

## Open issues
- `renderGame()` still fully tears down and rebuilds the seats/hand-card DOM on every render (cosmetic jank, not breakage) — now that the code is module-split, a future diffing/patching pass is more feasible, but not started.
- Verify in the Supabase dashboard (Database → Replication) that Realtime is enabled for **both** `rooms` and `votes` — `db/supabase_setup.sql` does this via `alter publication supabase_realtime add table ...`, but worth re-checking after any manual dashboard changes.
- Known cosmetic limitation: a player whose tab is closed/disconnected when "New Round" happens keeps their stale vote from the previous round displayed on their seat until they reopen the app (their own client is what clears it — see `maybeResetOwnVoteForNewRound`). Not a correctness issue, just a stale "ghost" card on one seat.
- If delay/instability returns: check the browser DevTools Network → WS tab for reconnect loops, and rule out a Supabase free-tier cold start, before assuming it's a code regression — the known code-level causes (whole-blob race, extra-query realtime race) are fixed as of the `votes` table migration above.
- **One-time manual setup required for the Vite/CI migration to actually deploy:** in the GitHub repo, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_KEY` under Settings → Secrets and variables → Actions → **Variables**, and switch Settings → Pages → Source to **"GitHub Actions"**. Until both are done, `.github/workflows/deploy.yml` will fail (missing env vars) or Pages will keep serving from whatever the old source was.

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
