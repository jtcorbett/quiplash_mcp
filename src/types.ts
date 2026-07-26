// Shapes reverse-engineered from live observation of the ecast protocol
// (wss://<host>/api/v2/rooms/<code>/play) as used by the classic Quiplash app
// ("bc:"-serialized game family). Field names come directly from captured
// traffic, not official documentation, so keep these permissive.

export interface RoomInfo {
  appId: string;
  appTag: string;
  audienceEnabled: boolean;
  code: string;
  host: string;
  audienceHost: string;
  locked: boolean;
  full: boolean;
  maxPlayers: number;
  minPlayers: number;
  moderationEnabled: boolean;
  passwordRequired: boolean;
  twitchLocked: boolean;
  locale: string;
  keepalive: boolean;
  controllerBranch: string;
}

export interface QuiplashQuestion {
  id: number;
  path: string;
  prompt: string;
  random_for_content_manager?: number;
  x?: boolean;
}

// The shared "bc:room" object. Only fields we've actually observed are typed;
// everything else is left open since the schema varies by game screen.
export interface RoomState {
  state?: string; // "Lobby" | "Gameplay_Logo" | "Gameplay_Round" | "Gameplay_AnswerQuestion" | "Gameplay_Vote" | ...
  lobbyState?: string; // "WaitingForMore" | "CanStart" | "Countdown"
  round?: number;
  question?: QuiplashQuestion;
  choices?: Record<string, string>; // {"left": "...", "right": "..."} or {"0": "...", "2": "...", ...}
  order?: string[];
  analytics?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

// The per-player "bc:customer:<user-id>" object.
export interface SelfState {
  state?: string;
  playerName?: string;
  playerColor?: string;
  question?: QuiplashQuestion | null;
  showError?: boolean;
  // Head-to-head voting: false until voted, then becomes the literal
  // "left"/"right" string that was voted for. Last Lash voting: absent while
  // votesLeft > 0, becomes `true` once all votes are cast (or you wrote one
  // of the answers being judged, in which case it's `true` immediately).
  doneVoting?: boolean | string;
  votes?: string[];
  votesLeft?: number;
  ignore?: number[]; // Last Lash: your own answer's index, excluded from choices
  [key: string]: unknown;
}

export type PendingActionType = "answer_question" | "vote_head_to_head" | "vote_last_lash" | "none";

export interface PendingAction {
  playerName: string;
  roomCode: string;
  actionType: PendingActionType;
  prompt?: string;
  questionId?: number;
  choices?: { left: string; right: string } | Record<string, string>;
  votesLeft?: number;
  votesCast?: string[];
  ownIndex?: number[];
}

export interface PlayerSummary {
  playerName: string;
  roomCode: string;
  connected: boolean;
  playerId: number | null;
  state?: string;
}
