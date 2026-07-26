#!/usr/bin/env node
/**
 * MCP server for playing live Jackbox Quiplash games.
 *
 * Connects to a real jackbox.tv room over its ecast WebSocket protocol as one
 * or more "player" controllers, so an LLM can read prompts/votes and respond
 * to them in real time. The protocol here is reverse-engineered from live
 * traffic (there is no public spec for classic Quiplash's wire format).
 *
 * Round timers are short, so tools are designed around
 * quiplash_get_pending_actions' long-poll mode instead of manual sleep/retry
 * loops.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { QuiplashManager } from "./manager.js";

const manager = new QuiplashManager();

const server = new McpServer({
  name: "quiplash-mcp-server",
  version: "1.0.0",
});

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true as const, content: [{ type: "text" as const, text: `Error: ${message}` }] };
}

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data as Record<string, unknown> };
}

const RoomCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{4}$/, "Jackbox room codes are 4 letters, e.g. 'SEQF'")
  .transform((s) => s.toUpperCase())
  .describe("The 4-letter room code shown on the host's TV/screen, e.g. 'SEQF'");

const PlayerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .describe("Display name this controller joins as (shown to all players/the host)");

server.registerTool(
  "quiplash_check_room",
  {
    title: "Check Quiplash Room",
    description: `Look up a jackbox.tv room by its 4-letter code without joining it.

Use this before quiplash_join_room to confirm the room exists, is running Quiplash, and is still in its lobby (not locked/full). Read-only, safe to call repeatedly.

Args:
  - room_code (string): 4-letter code from the host's screen

Returns JSON: { room_code, app_tag, host, locked, full, max_players, min_players, password_required, audience_enabled }

Errors:
  - Throws if the room code doesn't exist or has expired.`,
    inputSchema: { room_code: RoomCodeSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ room_code }) => {
    try {
      const info = await manager.checkRoom(room_code);
      return jsonResult({
        room_code: info.code,
        app_tag: info.appTag,
        host: info.host,
        locked: info.locked,
        full: info.full,
        max_players: info.maxPlayers,
        min_players: info.minPlayers,
        password_required: info.passwordRequired,
        audience_enabled: info.audienceEnabled,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "quiplash_join_room",
  {
    title: "Join Quiplash Room",
    description: `Join a live Quiplash room as a new player controller, opening a persistent connection managed by this server.

Must be called while the room is still in its lobby (before the host presses start) — rooms lock once gameplay begins and reject new joins. Call quiplash_check_room first if unsure.

Args:
  - room_code (string): 4-letter code from the host's screen
  - player_name (string): display name for this controller (1-20 chars); must be unique among players this server currently manages

Returns JSON: { player_name, room_code, player_id, connected: true }

Errors:
  - "room is locked" if the game already started — ask the host to open a new lobby
  - "room is full" if max players reached
  - if player_name is already in use by this server, call quiplash_leave_room first or pick another name`,
    inputSchema: { room_code: RoomCodeSchema, player_name: PlayerNameSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ room_code, player_name }) => {
    try {
      const connection = await manager.joinRoom(room_code, player_name);
      return jsonResult({
        player_name: connection.playerName,
        room_code: connection.roomCode,
        player_id: connection.playerId,
        connected: connection.connected,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "quiplash_leave_room",
  {
    title: "Leave Quiplash Room",
    description: `Disconnect a player controller previously joined with quiplash_join_room.

Args:
  - player_name (string): the name passed to quiplash_join_room

Returns JSON: { player_name, disconnected: true }`,
    inputSchema: { player_name: PlayerNameSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  async ({ player_name }) => {
    try {
      manager.leaveRoom(player_name);
      return jsonResult({ player_name, disconnected: true });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "quiplash_list_players",
  {
    title: "List Managed Quiplash Players",
    description: `List every player controller this server currently manages, across all rooms.

Returns JSON: { players: [ { player_name, room_code, connected, player_id, state } ] }
"state" is the raw Quiplash screen state (e.g. "Lobby", "Gameplay_AnswerQuestion", "Gameplay_Vote") and may be omitted if no state has been received yet.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const players = manager.listPlayers().map((p) => ({
      player_name: p.playerName,
      room_code: p.roomCode,
      connected: p.connected,
      player_id: p.playerId,
      state: p.state,
    }));
    return jsonResult({ players });
  },
);

server.registerTool(
  "quiplash_get_pending_actions",
  {
    title: "Get Pending Quiplash Actions",
    description: `Check which managed players currently need to answer a prompt or cast a vote, optionally waiting for one to become available.

Quiplash's answer/vote timers are short (often well under a minute), so prefer this tool's timeout_seconds over manually sleeping and re-checking: it long-polls server-side and returns the instant something becomes actionable, or when the timeout elapses, whichever comes first.

Args:
  - player_names (string[], optional): restrict to these players; defaults to every player this server manages
  - timeout_seconds (number, optional, 0-30, default 0): 0 returns immediately; >0 waits up to that many seconds for an action to appear

Returns JSON: { pending: [ {
  player_name, room_code, action_type: "answer_question" | "vote_head_to_head" | "vote_last_lash",
  prompt,                          // the question text (all action types)
  question_id,                     // answer_question only — pass to quiplash_submit_answer
  choices,                         // vote_* only — {"left","right"} or {"<index>": "text"} map
  votes_left, votes_cast, own_index // vote_last_lash only
} ] }
An empty "pending" array means nobody needs a response right now (still in lobby, watching a reveal screen, already answered/voted, etc).`,
    inputSchema: {
      player_names: z.array(PlayerNameSchema).optional().describe("Restrict to these players (default: all managed players)"),
      timeout_seconds: z.number().min(0).max(30).default(0).describe("Long-poll up to this many seconds for an action to appear"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ player_names, timeout_seconds }) => {
    try {
      const pending = await manager.waitForPendingActions(timeout_seconds, player_names);
      return jsonResult({
        pending: pending.map((a) => ({
          player_name: a.playerName,
          room_code: a.roomCode,
          action_type: a.actionType,
          ...(a.prompt !== undefined ? { prompt: a.prompt } : {}),
          ...(a.questionId !== undefined ? { question_id: a.questionId } : {}),
          ...(a.choices !== undefined ? { choices: a.choices } : {}),
          ...(a.votesLeft !== undefined ? { votes_left: a.votesLeft } : {}),
          ...(a.votesCast !== undefined ? { votes_cast: a.votesCast } : {}),
          ...(a.ownIndex !== undefined ? { own_index: a.ownIndex } : {}),
        })),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "quiplash_submit_answer",
  {
    title: "Submit Quiplash Answer",
    description: `Submit a written quip for a player's currently active prompt.

Only valid when quiplash_get_pending_actions reports action_type "answer_question" for this player — call that first to get the prompt text. Answers must be reasonably unique: Quiplash silently rejects an answer that's identical to one already used elsewhere in the same game (check quiplash_get_pending_actions again afterward — if the prompt is still pending, the answer was rejected as a duplicate and you should resubmit with different wording).

Args:
  - player_name (string): player submitting the answer
  - answer (string, 1-100 chars): the quip text

Returns JSON: { player_name, question_id, answer, submitted: true }

Errors:
  - if this player has no pending question right now`,
    inputSchema: {
      player_name: PlayerNameSchema,
      answer: z.string().trim().min(1).max(100).describe("The quip/answer text to submit"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ player_name, answer }) => {
    try {
      const pending = manager.getPendingAction(player_name);
      if (pending.actionType !== "answer_question" || pending.questionId === undefined) {
        throw new Error(
          `"${player_name}" has no pending question right now (current action: ${pending.actionType}). Call quiplash_get_pending_actions to check.`,
        );
      }
      const connection = manager.getConnectionOrThrow(player_name);
      const wasDuplicateRisk = connection.hasUsedAnswer(answer);
      await connection.submitAnswer(answer, pending.questionId);
      return jsonResult({
        player_name,
        question_id: pending.questionId,
        answer,
        submitted: true,
        ...(wasDuplicateRisk
          ? { warning: "This exact answer was already used earlier in the game and may be rejected as a duplicate." }
          : {}),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "quiplash_vote_head_to_head",
  {
    title: "Vote Quiplash Head-to-Head",
    description: `Cast a vote in a standard Quiplash head-to-head round, picking the funnier of two answers.

Only valid when quiplash_get_pending_actions reports action_type "vote_head_to_head" for this player (players who wrote either of the two answers being judged are automatically excluded and won't have a pending vote).

Args:
  - player_name (string): player casting the vote
  - choice ("left" | "right"): which side to vote for, matching the "choices" map from quiplash_get_pending_actions

Returns JSON: { player_name, choice, voted: true }

Errors:
  - if this player has no pending head-to-head vote right now`,
    inputSchema: {
      player_name: PlayerNameSchema,
      choice: z.enum(["left", "right"]).describe("Which answer to vote for"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ player_name, choice }) => {
    try {
      const pending = manager.getPendingAction(player_name);
      if (pending.actionType !== "vote_head_to_head") {
        throw new Error(
          `"${player_name}" has no pending head-to-head vote right now (current action: ${pending.actionType}). Call quiplash_get_pending_actions to check.`,
        );
      }
      const connection = manager.getConnectionOrThrow(player_name);
      await connection.voteHeadToHead(choice);
      return jsonResult({ player_name, choice, voted: true });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "quiplash_vote_last_lash",
  {
    title: "Vote Quiplash Last Lash",
    description: `Cast favorite votes in Quiplash's final "Last Lash" round, where every player answered the same prompt and you pick up to 3 favorites from everyone else's answers.

Only valid when quiplash_get_pending_actions reports action_type "vote_last_lash" for this player, which also gives you "choices" (a map of index -> answer text), "votes_left" (how many picks remain, starts at 3), and "own_index" (your own answer's index — you can't vote for it, and it won't appear in "choices").

Order matters: send your favorite first, second-favorite second, third-favorite third. You may submit fewer than 3 picks (including piling more than one "vote" onto the same answer index is allowed by the game, though ranked_choices here just sends each index once per call in order).

Args:
  - player_name (string): player casting the votes
  - ranked_choices (number[], 1-3 items): answer indices in order of preference (favorite first), each key from the "choices" map

Returns JSON: { player_name, ranked_choices, votes_left, voted: true }

Errors:
  - if this player has no pending Last Lash vote right now
  - if ranked_choices has more entries than votes_left, or includes an index not in choices / equal to own_index`,
    inputSchema: {
      player_name: PlayerNameSchema,
      ranked_choices: z
        .array(z.number().int())
        .min(1)
        .max(3)
        .describe("Answer indices in order of preference: favorite first, then 2nd/3rd favorite"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ player_name, ranked_choices }) => {
    try {
      const pending = manager.getPendingAction(player_name);
      if (pending.actionType !== "vote_last_lash" || !pending.choices) {
        throw new Error(
          `"${player_name}" has no pending Last Lash vote right now (current action: ${pending.actionType}). Call quiplash_get_pending_actions to check.`,
        );
      }
      const votesLeft = pending.votesLeft ?? 0;
      if (ranked_choices.length > votesLeft) {
        throw new Error(`"${player_name}" only has ${votesLeft} vote(s) left, but ${ranked_choices.length} were given.`);
      }
      const validIndices = new Set(Object.keys(pending.choices).map(Number));
      const ownIndices = new Set(pending.ownIndex ?? []);
      for (const idx of ranked_choices) {
        if (ownIndices.has(idx)) {
          throw new Error(`Index ${idx} is "${player_name}"'s own answer and cannot be voted for.`);
        }
        if (!validIndices.has(idx)) {
          throw new Error(`Index ${idx} is not one of the available choices: ${[...validIndices].join(", ")}.`);
        }
      }

      const connection = manager.getConnectionOrThrow(player_name);
      for (const idx of ranked_choices) {
        await connection.voteLastLashPick(idx);
      }

      const updated = manager.getPendingAction(player_name);
      return jsonResult({
        player_name,
        ranked_choices,
        votes_left: updated.votesLeft ?? 0,
        voted: true,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("quiplash-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error starting quiplash-mcp-server:", error);
  process.exit(1);
});
