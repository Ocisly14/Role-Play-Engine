/**
 * Type definitions for GameChat component and related functionality
 */

import type { DiceRollInfo } from "../components/DiceAnimation";

export interface Message {
  role: "character" | "keeper" | "banner";
  content: string;
  timestamp: string;
  turnNumber: number;
  turnId?: string;
  isStreaming?: boolean;
  imageUrl?: string;
  imageCaption?: string;
  diceRolls?: Array<string | DiceRollInfo>;
  gameDay?: number | null;
  gameTime?: string | null;
  bannerType?: "combat_start" | "combat_end";
}

export interface GameEndingInfo {
  isEnded: boolean;
  endingType: "death" | "time_limit" | "victory" | "failure" | "other";
  reason: string;
  timestamp: string;
}

export interface GameState {
  gameEnding: GameEndingInfo | null;
  gameDay?: number;
  timeOfDay?: string;
  playerCharacter?: {
    skills?: Record<string, unknown>;
    [key: string]: any;
  };
  [key: string]: any; // Allow additional fields for DynamicGameState compatibility
}

export interface GameChatProps {
  sessionId: string;
  apiBaseUrl?: string;
  characterName?: string;
  moduleIntroduction?: { introduction: string; moduleNotes: string } | null;
  initialMessages?: Message[];
  onNarrativeComplete?: () => void;
  language?: "en" | "zh";
}

export interface PendingDiceRolls {
  turnNumber: number;
  turnId?: string;
  diceRolls: Array<string | DiceRollInfo>;
  narrative: string;
  timestamp: string;
  gameDay?: number | null;
  gameTime?: string | null;
  isStreaming?: boolean;
}

export interface Skill {
  name: string;
  value: number;
  displayNameZh?: string;
  displayName?: string;
}

export interface SceneRoomInfo {
  sceneRoomId: string;
  scenarioName: string | null;
  memberPlayerIds: string[];
  roundNumber: number;
  isBattle: boolean;
  gameDay?: number;
  timeOfDay?: string;
}

export interface SceneRoomState {
  info: SceneRoomInfo;
  messages: Message[];
  scrollPosition: number;
  isLoaded: boolean; // false until turn history is fetched
}

export interface WebSocketMessage {
  type: string;
  sessionId?: string;
  turnId?: string;
  turnNumber?: number;
  delta?: string;
  timestamp?: string;
  gameDay?: number | null;
  gameTime?: string | null;
  diceRolls?: Array<string | DiceRollInfo>;
  keeperNarrative?: string;
  message?: string;
  error?: string;
  triggered?: boolean;
}
