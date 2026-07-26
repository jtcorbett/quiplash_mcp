import { EcastConnection } from "./ecastClient.js";
import type { PendingAction, PlayerSummary, RoomInfo, SelfState } from "./types.js";

const ECAST_API_BASE = "https://ecast.jackboxgames.com/api/v2/rooms";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export class QuiplashManager {
  private connections = new Map<string, EcastConnection>();

  async checkRoom(roomCode: string): Promise<RoomInfo> {
    const res = await fetch(`${ECAST_API_BASE}/${roomCode.toUpperCase()}`, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
    });
    const data = (await res.json()) as { ok: boolean; body?: RoomInfo; error?: string };
    if (!res.ok || !data.ok || !data.body) {
      throw new Error(`Room ${roomCode} was not found. Double-check the 4-letter code shown on the host screen.`);
    }
    return data.body;
  }

  async joinRoom(roomCode: string, playerName: string): Promise<EcastConnection> {
    const code = roomCode.toUpperCase();
    if (this.connections.has(playerName)) {
      throw new Error(
        `Player name "${playerName}" is already in use by this server. Call quiplash_leave_room first, or pick a different name.`,
      );
    }
    const info = await this.checkRoom(code);
    if (info.locked) {
      throw new Error(
        `Room ${code} is locked (game already in progress). Players can only join during the lobby, before the host starts the game.`,
      );
    }
    if (info.full) {
      throw new Error(`Room ${code} is full (max ${info.maxPlayers} players).`);
    }

    const connection = new EcastConnection(code, info.host, playerName);
    try {
      await connection.connect();
    } catch (err) {
      connection.close();
      throw err;
    }
    this.connections.set(playerName, connection);
    connection.once("close", () => {
      // Leave the entry in place so callers can still see the last known
      // state / get a clear "disconnected" answer instead of "unknown player".
    });
    return connection;
  }

  leaveRoom(playerName: string): void {
    const connection = this.getConnectionOrThrow(playerName);
    connection.close();
    this.connections.delete(playerName);
  }

  listPlayers(): PlayerSummary[] {
    return [...this.connections.values()].map((c) => ({
      playerName: c.playerName,
      roomCode: c.roomCode,
      connected: c.connected,
      playerId: c.playerId,
      state: c.selfState.state,
    }));
  }

  getConnectionOrThrow(playerName: string): EcastConnection {
    const connection = this.connections.get(playerName);
    if (!connection) {
      throw new Error(
        `No player named "${playerName}" is managed by this server. Call quiplash_join_room first, or check quiplash_list_players for active names.`,
      );
    }
    return connection;
  }

  getPendingAction(playerName: string): PendingAction {
    const connection = this.getConnectionOrThrow(playerName);
    return derivePendingAction(connection.playerName, connection.roomCode, connection.roomState, connection.selfState);
  }

  getAllPendingActions(playerNames?: string[]): PendingAction[] {
    const names = playerNames ?? [...this.connections.keys()];
    return names.map((name) => this.getPendingAction(name));
  }

  /**
   * Long-poll for the next moment any of `playerNames` (or all managed
   * players) has something to respond to. Resolves immediately if something
   * is already pending. Quiplash's answer/vote timers are short (well under
   * a minute), so prefer this over sleeping and re-checking.
   */
  async waitForPendingActions(timeoutSeconds: number, playerNames?: string[]): Promise<PendingAction[]> {
    const check = () => this.getAllPendingActions(playerNames).filter((a) => a.actionType !== "none");

    const immediate = check();
    if (immediate.length > 0 || timeoutSeconds <= 0) {
      return immediate;
    }

    const names = playerNames ?? [...this.connections.keys()];
    const targets = names.map((name) => this.getConnectionOrThrow(name));

    return new Promise<PendingAction[]>((resolve) => {
      let done = false;
      const finish = (result: PendingAction[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const t of targets) t.off("update", onUpdate);
        resolve(result);
      };

      const onUpdate = () => {
        const found = check();
        if (found.length > 0) finish(found);
      };

      const timer = setTimeout(() => finish(check()), timeoutSeconds * 1000);
      for (const t of targets) t.on("update", onUpdate);
    });
  }
}

function derivePendingAction(playerName: string, roomCode: string, room: RoomInfoLike, self: SelfState): PendingAction {
  const base = { playerName, roomCode };

  if (self.state === "Gameplay_AnswerQuestion" && self.question) {
    return {
      ...base,
      actionType: "answer_question",
      prompt: self.question.prompt,
      questionId: self.question.id,
    };
  }

  if (self.state === "Gameplay_Vote") {
    const choices = room.choices ?? {};
    const isHeadToHead = "left" in choices && "right" in choices;

    if (isHeadToHead) {
      if (self.doneVoting === false) {
        return {
          ...base,
          actionType: "vote_head_to_head",
          prompt: room.question?.prompt,
          choices: { left: choices.left, right: choices.right },
        };
      }
      return { ...base, actionType: "none" };
    }

    // Last Lash: multi-favorite voting. Pending as long as votes remain and
    // the player hasn't been marked fully done.
    const votesLeft = typeof self.votesLeft === "number" ? self.votesLeft : self.doneVoting === false ? 3 : 0;
    if (self.doneVoting !== true && votesLeft > 0) {
      return {
        ...base,
        actionType: "vote_last_lash",
        prompt: room.question?.prompt,
        choices,
        votesLeft,
        votesCast: self.votes ?? [],
        ownIndex: self.ignore ?? [],
      };
    }
    return { ...base, actionType: "none" };
  }

  return { ...base, actionType: "none" };
}

// Narrow view of RoomState used by derivePendingAction, kept local to avoid
// a circular import cost for a two-field read.
interface RoomInfoLike {
  choices?: Record<string, string>;
  question?: { prompt: string };
}
