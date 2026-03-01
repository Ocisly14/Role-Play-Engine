/**
 * Multiplayer Graph State
 * Replaces DynamicGraphState for the multiplayer pipeline.
 *
 * Key differences from single-player DynamicGraphState:
 * - No messages[] / BaseMessage (inputs arrive as roundInputs[])
 * - No isSimulatedQuery / simulatedQueryCount
 * - No selectedSkill / skillSelectionMode at graph level (per-player)
 * - Adds sceneRoomId (which sub-room this round belongs to)
 * - dynamicGameState is MultiplayerDynamicGameState
 */

import type { DiceRollInfo } from "../../shared/state/index.js";
import type {
  MultiplayerDynamicGameState,
  MultiplayerTurnInput,
} from "../multiplayerState/MultiplayerDynamicGameState.js";

export interface MultiplayerGraphState {
  /** The full room-level multiplayer game state */
  dynamicGameState: MultiplayerDynamicGameState;

  /** Which sceneRoom is being processed in this round */
  sceneRoomId: string;

  /** All player inputs submitted for this round in this sceneRoom */
  roundInputs: MultiplayerTurnInput[];

  /** Round-level turn ID for persistence / auditing */
  roundTurnId: string;

  /** User-selected output language */
  language?: "en" | "zh";

  /** Streaming callbacks (optional) */
  stream?: {
    onDiceRolls?: (diceRolls: DiceRollInfo[]) => void;
    onSceneImage?: (payload: {
      imagePath: string;
      mimeType: string;
      sceneName: string;
      location: string;
      gameDay?: number | null;
      gameTime?: string | null;
      timestamp?: string;
    }) => void;
    onSceneChangeStart?: () => void;
    onSceneChangeEnd?: () => void;
    onNarrativeStart?: () => void;
    onNarrativeDelta?: (delta: string) => void;
    onNarrativeEnd?: () => void;
    onWorldlineUpdateStart?: () => void;
    onWorldlineUpdateEnd?: () => void;
    onCombatStart?: () => void;
    onCombatEnd?: () => void;
  };
}
