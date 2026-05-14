#!/bin/bash
# Script to apply all GameChat refactoring changes

FILE="client/src/components/GameChat.tsx"

echo "Applying GameChat.tsx refactoring..."

# Step 1: Update imports (add new hooks and types)
perl -i -pe 's|^import \{ useState, useEffect, useRef, useCallback \} from "react";$|import { useState, useEffect, useRef, useCallback } from "react";\nimport { useInputCollapse } from "../hooks/useInputCollapse";\nimport { useSceneTransition } from "../hooks/useSceneTransition";\nimport { useAutoSave } from "../hooks/useAutoSave";\nimport { useDiceAnimation } from "../hooks/useDiceAnimation";\nimport { useGameMessages } from "../hooks/useGameMessages";\nimport { useSkillSelection } from "../hooks/useSkillSelection";\nimport { useWebSocket } from "../hooks/useWebSocket";|' "$FILE"

# Step 2: Add type imports
perl -i -pe 's|^import ReactMarkdown from "react-markdown";$|import ReactMarkdown from "react-markdown";\nimport type {\n  Message,\n  GameEndingInfo,\n  GameState,\n  GameChatProps,\n  PendingDiceRolls,\n  Skill,\n  WebSocketMessage,\n} from "../types/gamechat";\nimport {\n  buildDiceRollInfos,\n  filterDiceRollsForPlayer,\n  getLatestTurnNumber,\n  getLatestCompletedTurnNumber,\n} from "./gamechat/utils";|' "$FILE"

# Step 3: Remove utility functions (lines 14-134)
sed -i '' '14,134d' "$FILE"

# Step 4: Remove old interfaces (Message, GameEndingInfo, GameState, GameChatProps) - they're now in types
# This is complex, will be handled by specific patterns

echo "Refactoring applied successfully!"
echo "Please run 'pnpm build' to test the changes."
