import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { RoomState, SelfState } from "./types.js";

const ECAST_SUBPROTOCOL = "ecast-v0";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export class EcastRoomLockedError extends Error {
  constructor(roomCode: string) {
    super(`Room ${roomCode} is locked (the game has already started). Join before the host starts the game.`);
    this.name = "EcastRoomLockedError";
  }
}

export class EcastConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EcastConnectionError";
  }
}

/**
 * One ecast WebSocket connection acting as a single "player" controller in a
 * live Quiplash room. Emits "update" whenever room or self state changes, so
 * callers can react to new prompts/votes without polling the network.
 */
export class EcastConnection extends EventEmitter {
  readonly playerName: string;
  readonly roomCode: string;
  readonly host: string;
  readonly userId: string;

  private ws: WebSocket | null = null;
  private seq = 0;
  private playerIdValue: number | null = null;
  private roomStateValue: RoomState = {};
  private selfStateValue: SelfState = {};
  private connectedValue = false;
  private usedAnswers = new Set<string>();
  private pendingAcks = new Map<number, { resolve: () => void; reject: (err: Error) => void }>();

  constructor(roomCode: string, host: string, playerName: string) {
    super();
    this.roomCode = roomCode;
    this.host = host;
    this.playerName = playerName;
    this.userId = randomUUID();
  }

  get playerId(): number | null {
    return this.playerIdValue;
  }

  get connected(): boolean {
    return this.connectedValue;
  }

  get roomState(): RoomState {
    return this.roomStateValue;
  }

  get selfState(): SelfState {
    return this.selfStateValue;
  }

  hasUsedAnswer(text: string): boolean {
    return this.usedAnswers.has(text.trim().toLowerCase());
  }

  connect(timeoutMs = 8000): Promise<void> {
    const bootstrap = new URLSearchParams({
      role: "player",
      name: this.playerName,
      "user-id": this.userId,
      format: "json",
      password: "",
    });
    const url = `wss://${this.host}/api/v2/rooms/${this.roomCode}/play?${bootstrap.toString()}`;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          this.ws?.terminate();
          reject(new EcastConnectionError(`Timed out connecting to room ${this.roomCode} as "${this.playerName}".`));
        });
      }, timeoutMs);

      const ws = new WebSocket(url, ECAST_SUBPROTOCOL, {
        headers: { "User-Agent": BROWSER_USER_AGENT, Origin: "https://jackbox.tv" },
      });
      this.ws = ws;

      ws.on("message", (data) => this.handleMessage(data.toString()));

      this.once("welcome", () => settle(() => resolve()));

      this.once("ecastError", (err: Error) => {
        settle(() => reject(err));
      });

      ws.on("unexpected-response", (_req, res) => {
        settle(() =>
          reject(new EcastConnectionError(`Unexpected HTTP ${res.statusCode} connecting to room ${this.roomCode}.`)),
        );
      });

      ws.on("close", () => {
        this.connectedValue = false;
        this.emit("close");
        settle(() =>
          reject(new EcastConnectionError(`Connection to room ${this.roomCode} closed before "${this.playerName}" finished joining.`)),
        );
      });

      ws.on("error", (err) => {
        settle(() => reject(new EcastConnectionError(`WebSocket error for "${this.playerName}": ${err.message}`)));
      });
    });
  }

  close(): void {
    this.ws?.close();
    this.connectedValue = false;
  }

  /** Submit a Quiplash answer for the currently active question. */
  async submitAnswer(answer: string, questionId: number): Promise<void> {
    this.usedAnswers.add(answer.trim().toLowerCase());
    await this.sendClientAction({ answer, questionId });
  }

  /** Cast a head-to-head vote ("left" or "right"). */
  async voteHeadToHead(side: "left" | "right"): Promise<void> {
    await this.sendClientAction({ vote: side });
  }

  /**
   * Cast one Last Lash favorite vote. The server tracks preference by send
   * order: the first call is your #1 favorite, the second your #2, etc.
   * `index` must be a number matching one of the keys in `roomState.choices`.
   */
  async voteLastLashPick(index: number): Promise<void> {
    await this.sendClientAction({ vote: index });
  }

  private sendClientAction(body: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.playerIdValue === null) {
      return Promise.reject(new EcastConnectionError(`"${this.playerName}" is not connected.`));
    }
    this.seq += 1;
    const seq = this.seq;
    const message = {
      seq,
      opcode: "client/send",
      params: { from: this.playerIdValue, to: 1, body },
    };

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(seq);
        reject(new EcastConnectionError(`Timed out waiting for server ack (seq ${seq}).`));
      }, 5000);
      this.pendingAcks.set(seq, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws!.send(JSON.stringify(message));
    });
  }

  private handleMessage(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof raw !== "object" || raw === null || !("opcode" in raw)) return;
    const parsed = raw as { opcode: string; re?: number; result?: unknown };

    if (parsed.opcode === "client/welcome") {
      const result = parsed.result as { id?: number } | undefined;
      this.playerIdValue = result?.id ?? null;
      this.emit("welcome");
      this.emit("update");
      return;
    }

    if (parsed.opcode === "error") {
      const result = parsed.result as { msg?: string } | undefined;
      const message = result?.msg ?? "Unknown ecast error";
      const err = /locked/i.test(message) ? new EcastRoomLockedError(this.roomCode) : new EcastConnectionError(message);
      this.emit("ecastError", err);
      return;
    }

    if (parsed.opcode === "ok" && typeof parsed.re === "number") {
      this.pendingAcks.get(parsed.re)?.resolve();
      this.pendingAcks.delete(parsed.re);
      return;
    }

    if (parsed.opcode === "room/exit") {
      const result = parsed.result as { cause?: number } | undefined;
      this.connectedValue = false;
      this.emit("roomExit", result?.cause);
      return;
    }

    if (parsed.opcode === "object" && parsed.result && typeof parsed.result === "object" && "key" in parsed.result) {
      const { key, val } = parsed.result as { key: string; val: Record<string, unknown> };
      if (key === "bc:room") {
        this.roomStateValue = { ...this.roomStateValue, ...val };
        this.emit("update");
      } else if (key === `bc:customer:${this.userId}`) {
        this.selfStateValue = val as SelfState;
        this.emit("update");
      }
    }
  }
}
