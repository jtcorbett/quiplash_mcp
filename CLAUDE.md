# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install      # install dependencies
npm run build    # compile TypeScript (src/ -> dist/) — must pass before considering any change done
npm run dev       # tsx watch src/index.ts — run directly from source with auto-reload
npm start         # node dist/index.js — run the built server
npm run clean     # rm -rf dist
```

There is no test suite, linter, or type-check script beyond `tsc` itself (`npm run build` *is* the type-check). There are no automated tests — verification has so far been manual, by driving the built server through a real `@modelcontextprotocol/sdk` `Client`/`StdioClientTransport` and by connecting live bot players to real jackbox.tv rooms.

To smoke-test the server end-to-end, spawn `dist/index.js` with a `StdioClientTransport` from `@modelcontextprotocol/sdk/client/stdio.js`, call `listTools()`, then call individual tools (e.g. `quiplash_check_room`) — see git history for the throwaway script this was verified with.

## What this is

An MCP server (stdio transport) that connects to a **live Jackbox Quiplash game** as one or more player controllers, so an LLM can read prompts/votes and answer/vote in real time through MCP tool calls — acting as a phone controller would.

## Architecture

Three layers, one per file in `src/`:

- **`ecastClient.ts` — `EcastConnection`**: one WebSocket connection = one player in one room. Owns the ecast wire protocol: connects to `wss://<host>/api/v2/rooms/<code>/play` (subprotocol `ecast-v0`), tracks a `seq` counter for outgoing `client/send` messages and resolves/rejects pending acks by `re` (the server's reply-to-seq), and maintains two pieces of live state (`roomState`, `selfState`) updated as `object` opcode messages arrive. Emits `"update"` on any state change, `"welcome"` once joined, `"ecastError"` on protocol-level errors (e.g. locked room), `"roomExit"`/`"close"` on disconnect. Callers should react to `"update"` rather than polling.

- **`manager.ts` — `QuiplashManager`**: holds all `EcastConnection`s keyed by player name (one process manages every player/room this server is asked to join). Does the HTTP room lookup (`checkRoom`, hitting `https://ecast.jackboxgames.com/api/v2/rooms/<code>`), enforces join preconditions (not locked/full, name not already in use), and derives a `PendingAction` from the raw `(roomState, selfState)` pair for a player via `derivePendingAction` — this is where "does this player need to answer or vote right now, and what kind" gets decided. `waitForPendingActions` is a long-poll: returns immediately if something is already pending, otherwise subscribes to `"update"` on the relevant connections until something appears or `timeoutSeconds` elapses. This exists specifically because Quiplash's answer/vote windows are short; tools should prefer this over sleep-and-recheck loops.

- **`index.ts`**: registers the 8 MCP tools (`quiplash_check_room`, `quiplash_join_room`, `quiplash_leave_room`, `quiplash_list_players`, `quiplash_get_pending_actions`, `quiplash_submit_answer`, `quiplash_vote_head_to_head`, `quiplash_vote_last_lash`) against `McpServer` using Zod schemas, and starts it over `StdioServerTransport`. Each tool is a thin wrapper: validate the player's current `PendingAction` matches the action being attempted, delegate to `QuiplashManager`/`EcastConnection`, return `jsonResult`/`errorResult`.

- **`types.ts`**: the reverse-engineered wire shapes (`RoomInfo`, `RoomState`, `SelfState`, `QuiplashQuestion`) plus the `PendingAction` type the manager derives. These are intentionally permissive (`[key: string]: unknown` catch-alls) since the schema is inferred from observed traffic, not a spec.

### The ecast protocol (why the code is shaped this way)

There is no public spec for Jackbox's `ecast` protocol. Everything here was reverse-engineered by watching live traffic against the classic Quiplash app (`appTag: "quiplash"` — the `bc:`-serialized game family, the same wire format Fibbage 3 uses). Key facts baked into the implementation:

- Room lookup is a plain HTTP GET; the WebSocket join is `wss://<host from that lookup>/api/v2/rooms/<code>/play?role=player&name=...&user-id=<uuid>&format=json&password=`, subprotocol `ecast-v0`.
- Shared state comes in as `object` opcode messages with `key: "bc:room"`; your own state comes in as `key: "bc:customer:<your-uuid>"`. Both are whole-object replacements (not deltas) — `EcastConnection` shallow-merges `bc:room` updates and replaces `selfState` wholesale on `bc:customer` updates.
- Answering a prompt: `client/send` with `body: {"answer": "<text>", "questionId": <id>}`. A literal duplicate of an answer used earlier in the same game is **silently rejected** — no distinct error opcode, the prompt just stays pending (surfaced to callers as a same-text warning from `submitAnswer`/`hasUsedAnswer`, not a hard error, since the server is the actual authority).
- Head-to-head voting: `client/send` with `body: {"vote": "left" | "right"}`. Players who wrote either answer being judged are excluded automatically (`selfState.doneVoting === true` from the start, never `false`).
- "Last Lash" (final round) voting: `body: {"vote": <numeric index>}`, sent **once per pick, sequentially, in preference order** — the send order is the ranking (favorite first). `votesLeft` counts down per send; `selfState.ignore` lists the voter's own answer index (excluded from `roomState.choices`).
- Rooms **lock** the instant the host starts the game; joins after that point fail and must wait for a fresh lobby.

If you extend this to another Jackbox title, expect the schema (state machine names, action bodies) to be entirely different even where the outer envelope (`seq`/`opcode`/`client/send`) looks the same — treat any new game as requiring its own live reverse-engineering pass, not an assumption that this one generalizes.
