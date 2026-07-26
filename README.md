# quiplash-mcp-server

An MCP server that connects to a **live Jackbox Quiplash game** (jackbox.tv) as one or more player controllers, so an LLM can read prompts/votes and respond to them in real time — just like a phone controller would.

## How it works

Jackbox rooms are driven by a WebSocket protocol called **ecast**. There's no public spec for it, so this server's behavior was reverse-engineered by:

1. Hitting `https://ecast.jackboxgames.com/api/v2/rooms/<code>` to resolve a room code to its host/status.
2. Connecting to `wss://<host>/api/v2/rooms/<code>/play` (subprotocol `ecast-v0`) as a `role=player`.
3. Observing the JSON state-sync messages (`bc:room` for shared state, `bc:customer:<id>` for your own player state) as a real game was played, and capturing the exact `client/send` payloads a real client sends for answering (`{"answer", "questionId"}`) and voting (`{"vote": "left"|"right"}` for head-to-head, `{"vote": <index>}` sent once per pick, in preference order, for the final "Last Lash" round).

This only covers classic **Quiplash** (the `bc:`-serialized game family — the same wire format Fibbage 3 uses). Other Jackbox games and Quiplash 3 use different schemas.

## Setup

```bash
npm install
npm run build
```

Register it with Claude Code (or any MCP client) as a stdio server, e.g. in `.mcp.json`:

```json
{
  "mcpServers": {
    "quiplash": {
      "command": "node",
      "args": ["/absolute/path/to/quiplash_mcp/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `quiplash_check_room` | Look up a room code (read-only) before joining |
| `quiplash_join_room` | Join a room as a new player controller (must be in the lobby, before the host starts) |
| `quiplash_leave_room` | Disconnect a player controller |
| `quiplash_list_players` | List every player this server currently manages |
| `quiplash_get_pending_actions` | Check (or long-poll for) which players need to answer/vote right now |
| `quiplash_submit_answer` | Submit a quip for a player's active prompt |
| `quiplash_vote_head_to_head` | Vote `left`/`right` in a standard round |
| `quiplash_vote_last_lash` | Cast up to 3 ranked favorite votes in the final round |

## Timing

Quiplash's answer/vote windows are short (often well under a minute), and rooms **lock** as soon as the host starts the game — new players can't join mid-game. Use `quiplash_get_pending_actions` with `timeout_seconds` to long-poll for the next prompt/vote instead of sleeping and re-checking; it returns the instant something becomes actionable.

## Known gaps / caveats

- Answers that exactly duplicate an earlier answer in the same game are silently rejected by the server (no explicit error opcode — the prompt just stays pending). `quiplash_submit_answer` warns if you're about to resubmit an already-used answer, but real-world duplicate detection by the game may be stricter than exact-match.
- Only tested against the classic Quiplash app (`appTag: "quiplash"`). Quiplash 3 and other Jackbox titles use a different message schema and are not supported.
- This is unofficial and based on observed traffic, not documented behavior — Jackbox could change the protocol at any time.
