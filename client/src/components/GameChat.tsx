/**
 * GameChat Component - Main game interaction interface
 * 
 * Handles sending messages to the game and displaying conversation history.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTurnPolling } from '../hooks/useTurnPolling';
import { getSkillNameZh } from '../lib/skillNames';
import { DiceAnimation, type DiceRollInfo } from './DiceAnimation';
import { authFetch } from '../utils/authFetch';
import ReactMarkdown from 'react-markdown';

/** Build DiceRollInfo[] from action results (for turn history display) */
function normalizeName(name?: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function buildDiceRollInfos(
  actionResults: Array<{ character: string; diceRolls?: string[] }>,
  playerName?: string
): DiceRollInfo[] {
  const infos: DiceRollInfo[] = [];
  const playerNameNormalized = normalizeName(playerName);
  for (const result of actionResults || []) {
    if (playerNameNormalized) {
      const resultNameNormalized = normalizeName(result.character);
      if (!resultNameNormalized || resultNameNormalized !== playerNameNormalized) {
        continue;
      }
    }
    for (const roll of result.diceRolls || []) {
      const info: DiceRollInfo = { character: result.character, roll };
      const parenMatches = [...roll.matchAll(/\(([^)]+)\)/g)];
      const content = parenMatches.length > 0 ? parenMatches[parenMatches.length - 1][1] : null;
      if (content) {
        const successMatch = content.match(/\s*=\s*(success|failure|critical|fumble)\s*$/i);
        if (successMatch) info.success = successMatch[1].toLowerCase() as DiceRollInfo['success'];
        const penaltyMatch = content.match(/(?:penalty\s+die|bonus\s+die|-\s*\d+\s*%?|\(\s*-\s*\d+\s*\))/i);
        if (penaltyMatch) info.penalty = penaltyMatch[0].trim();
        const beforeEquals = content.replace(/\s*=\s*(success|failure|critical|fumble)\s*$/i, '').trim();
        const skillPart = beforeEquals.replace(/(?:penalty\s+die|bonus\s+die|-\s*\d+\s*%?|\(\s*-\s*\d+\s*\)).*/gi, '').trim();
        if (skillPart && (/\d+%\s*$/.test(skillPart) || skillPart.length < 40)) info.skill = skillPart;
      }
      infos.push(info);
    }
  }
  return infos;
}

function filterDiceRollsForPlayer(
  diceRolls: DiceRollInfo[] | string[] | undefined,
  playerName?: string
): DiceRollInfo[] | string[] | undefined {
  if (!diceRolls || diceRolls.length === 0) return diceRolls;
  const playerNameNormalized = normalizeName(playerName);
  if (!playerNameNormalized) return diceRolls;
  const first = diceRolls[0] as DiceRollInfo | string;
  if (typeof first === 'string') return diceRolls;
  return (diceRolls as DiceRollInfo[]).filter((roll) => {
    const rollNameNormalized = normalizeName(roll.character);
    return !!rollNameNormalized && rollNameNormalized === playerNameNormalized;
  });
}

interface Message {
  role: 'character' | 'keeper';
  content: string;
  timestamp: string;
  turnNumber: number;
  turnId?: string;
  isStreaming?: boolean;
  imageUrl?: string;
  imageCaption?: string;
  diceRolls?: DiceRollInfo[] | string[];
  gameDay?: number | null;
  gameTime?: string | null;
}

interface GameEndingInfo {
  isEnded: boolean;
  endingType: 'death' | 'time_limit' | 'victory' | 'failure' | 'other';
  reason: string;
  timestamp: string;
}

// GameState interface - compatible with both GameState and DynamicGameState
interface GameState {
  gameEnding: GameEndingInfo | null;
  gameDay?: number;
  timeOfDay?: string;
  // Additional fields from DynamicGameState (optional, for compatibility)
  [key: string]: any; // Allow additional fields for DynamicGameState compatibility
}

interface GameChatProps {
  sessionId: string;
  apiBaseUrl?: string;
  characterName?: string;
  moduleIntroduction?: { introduction: string; moduleNotes: string } | null;
  initialMessages?: Message[];
  onNarrativeComplete?: () => void;
}

export function GameChat({ sessionId, apiBaseUrl = '/api', characterName = 'Investigator', moduleIntroduction, initialMessages, onNarrativeComplete }: GameChatProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages || []);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isGameEnded, setIsGameEnded] = useState(false);
  const [currentGameState, setCurrentGameState] = useState<{ gameDay?: number; timeOfDay?: string } | null>(null);
  const [availableSkills, setAvailableSkills] = useState<Array<{ name: string; value: number; displayNameZh?: string }>>([]);
  const [selectedSkill, setSelectedSkill] = useState('');
  const [isSkillAuto, setIsSkillAuto] = useState(false);
  const [suggestedSkills, setSuggestedSkills] = useState<Array<{ name: string; value: number; displayName?: string }>>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isSkillPickerOpen, setIsSkillPickerOpen] = useState(false);
  const [suggestedLanguage, setSuggestedLanguage] = useState<'en' | 'zh'>('zh');
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
  const [isInputCollapsed, setIsInputCollapsed] = useState(true);
  const collapseTimeoutRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedTurnIdsRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef<boolean>(true); // Track if we should auto-reconnect
  const currentSessionIdRef = useRef<string | null>(null); // Track current session to avoid duplicate connections
  // Refs to access latest values without causing WebSocket reconnection
  const messagesRef = useRef<Message[]>(messages);
  const onNarrativeCompleteRef = useRef(onNarrativeComplete);
  const fetchGameEndingRef = useRef<(() => Promise<void>) | null>(null);
  const suggestRequestIdRef = useRef(0);
  const { turn, isPolling, error, startPolling, stopPolling } = useTurnPolling(apiBaseUrl);
  
  // State for dice animation
  const [pendingDiceRolls, setPendingDiceRolls] = useState<{ turnNumber: number; turnId?: string; diceRolls: DiceRollInfo[] | string[]; narrative: string; timestamp: string; gameDay?: number | null; gameTime?: string | null; isStreaming?: boolean } | null>(null);
  const [showingDiceAnimation, setShowingDiceAnimation] = useState(false);
  const [diceAnimationCompleted, setDiceAnimationCompleted] = useState(false);

  // Update refs when values change
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const streamingBufferRef = useRef<Map<string, string>>(new Map());
  const streamingBlockedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    onNarrativeCompleteRef.current = onNarrativeComplete;
  }, [onNarrativeComplete]);

  const normalizeSkills = useCallback((skills: Record<string, unknown> | undefined | null) => {
    if (!skills || typeof skills !== 'object') return [];
    return Object.entries(skills)
      .map(([name, raw]) => {
        if (typeof raw === 'number') return { name, value: raw };
        if (raw && typeof raw === 'object' && 'value' in raw && typeof (raw as { value: unknown }).value === 'number') {
          return { name, value: (raw as { value: number }).value };
        }
        return null;
      })
      .filter((entry): entry is { name: string; value: number } => Boolean(entry))
      .map((entry) => ({
        ...entry,
        displayNameZh: getSkillNameZh(entry.name),
      }))
      .sort((a, b) => {
        if (b.value !== a.value) return b.value - a.value;
        return a.name.localeCompare(b.name);
      });
  }, []);

  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 2 || isGameEnded) {
      setSuggestedSkills([]);
      setIsSuggesting(false);
      return;
    }

    const requestId = ++suggestRequestIdRef.current;
    const controller = new AbortController();

    const timeoutId = window.setTimeout(async () => {
      setIsSuggesting(true);
      try {
        const response = await authFetch(`${apiBaseUrl}/skills/suggest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: trimmed,
            max: 3,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error('Failed to fetch skill suggestions');
        }

        const data = await response.json();
        if (requestId !== suggestRequestIdRef.current) return;

        const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];
        if (data?.language === 'en' || data?.language === 'zh') {
          setSuggestedLanguage(data.language);
        }
        const nextLanguage = data?.language === 'en' || data?.language === 'zh' ? data.language : suggestedLanguage;
        setSuggestedSkills(
          suggestions
            .filter((skill: { name?: string; value?: number }) => typeof skill?.name === 'string')
            .map((skill: { name: string; value?: number; displayName?: string }) => ({
              name: skill.name,
              value: typeof skill.value === 'number' ? skill.value : 0,
              displayName: typeof skill.displayName === 'string' ? skill.displayName : (nextLanguage === 'zh' ? getSkillNameZh(skill.name) : skill.name),
            }))
        );
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        console.warn('[GameChat] Failed to fetch skill suggestions:', err);
        if (requestId === suggestRequestIdRef.current) {
          setSuggestedSkills([]);
        }
      } finally {
        if (requestId === suggestRequestIdRef.current) {
          setIsSuggesting(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [apiBaseUrl, inputValue, isGameEnded]);

  const fetchGameEnding = useCallback(async () => {
    if (!sessionId) return;

    try {
      const response = await authFetch(`${apiBaseUrl}/gamestate`);
      if (!response.ok) {
        return;
      }

      const data = await response.json();
      const endingInfo: GameEndingInfo | null = data?.gameState?.gameEnding ?? null;
      setIsGameEnded(Boolean(endingInfo?.isEnded));
      
      // Update current game state for time display
      if (data?.gameState) {
        setCurrentGameState({
          gameDay: data.gameState.gameDay,
          timeOfDay: data.gameState.timeOfDay,
        });
        const skills = normalizeSkills(data.gameState.playerCharacter?.skills);
        setAvailableSkills(skills);
        if (selectedSkill && !skills.find(skill => skill.name === selectedSkill)) {
          setSelectedSkill('');
        }
      }
    } catch (err) {
      console.error('[GameChat] Failed to fetch game state:', err);
    }
  }, [apiBaseUrl, sessionId, selectedSkill, normalizeSkills]);

  // Update ref when fetchGameEnding changes
  useEffect(() => {
    fetchGameEndingRef.current = fetchGameEnding;
  }, [fetchGameEnding]);

  useEffect(() => {
    setIsGameEnded(false);
    if (sessionId && fetchGameEndingRef.current) {
      fetchGameEndingRef.current();
    }
  }, [sessionId, apiBaseUrl]); // Use apiBaseUrl instead of fetchGameEnding to avoid reconnection


  // WebSocket connection for progression checking
  useEffect(() => {
    if (!sessionId || isGameEnded) return;

    // Check if we already have a connection for this sessionId
    if (currentSessionIdRef.current === sessionId && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log(`[WebSocket] Already connected for session ${sessionId}, skipping...`);
      return;
    }

    // Get WebSocket URL from apiBaseUrl
    // If apiBaseUrl is relative, use current window location
    let wsUrl: string;
    if (apiBaseUrl.startsWith('/')) {
      // Relative path - use current protocol and host (skip Vite ws proxy in dev)
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const isViteDev = import.meta.env.DEV && window.location.port === '5173';
      const host = isViteDev ? `${window.location.hostname}:3000` : window.location.host;
      wsUrl = `${protocol}//${host}`;
    } else {
      // Absolute URL - convert to WebSocket URL
      wsUrl = apiBaseUrl.replace('/api', '').replace('http://', 'ws://').replace('https://', 'wss://');
    }
    const token = localStorage.getItem('accessToken');
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    const wsPath = `${wsUrl}/ws?sessionId=${sessionId}${tokenParam}`;

    console.log(`[WebSocket] Connecting to ${wsPath}`);

    // Mark that we should reconnect if connection closes (unless cleanup disables it)
    shouldReconnectRef.current = true;
    currentSessionIdRef.current = sessionId;

    const connectWebSocket = () => {
      // Check if we should still connect (might have been cancelled by cleanup)
      if (!shouldReconnectRef.current || currentSessionIdRef.current !== sessionId) {
        console.log(`[WebSocket] Connection cancelled or session changed, aborting...`);
        return;
      }

      try {
        // Close existing connection if any
        if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) {
          console.log(`[WebSocket] Closing existing connection before creating new one`);
          shouldReconnectRef.current = false; // Prevent auto-reconnect from old connection
          wsRef.current.close();
        }

        const ws = new WebSocket(wsPath);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log('[WebSocket] Connected');
          // Clear any reconnect timeout
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
        };

        ws.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            console.log('[WebSocket] Received message:', message);

            if (message.type === 'connected') {
              console.log(`[WebSocket] Connection confirmed for session ${message.sessionId}`);
            } else if (message.type === 'keeper_dice_rolls') {
              const diceRolls = filterDiceRollsForPlayer(
                message.diceRolls as DiceRollInfo[] | string[] | undefined,
                characterName
              );
              const turnId = message.turnId as string | undefined;
              if (!diceRolls || diceRolls.length === 0) return;

              if (turnId) {
                streamingBlockedRef.current.add(turnId);
                setStreamingTurnId(turnId);
              }

              const turnNumber = typeof message.turnNumber === 'number'
                ? message.turnNumber
                : messagesRef.current.length > 0
                  ? Math.max(...messagesRef.current.map(m => m.turnNumber)) + 1
                  : 1;

              setPendingDiceRolls({
                turnNumber,
                turnId,
                diceRolls,
                narrative: '',
                timestamp: message.timestamp || new Date().toISOString(),
                gameDay: message.gameDay ?? null,
                gameTime: message.gameTime ?? null,
                isStreaming: true,
              });
              setShowingDiceAnimation(true);
              setDiceAnimationCompleted(false);
            } else if (message.type === 'keeper_stream_start') {
              const turnId = message.turnId as string | undefined;
              if (!turnId) return;

              setStreamingTurnId(turnId);
              setMessages(prev => {
                const existing = prev.find(msg => msg.turnId === turnId);
                if (existing) {
                  return prev.map(msg =>
                    msg.turnId === turnId ? { ...msg, isStreaming: true } : msg
                  );
                }

                const nextTurnNumber = typeof message.turnNumber === 'number'
                  ? message.turnNumber
                  : prev.length > 0 ? Math.max(...prev.map(m => m.turnNumber)) + 1 : 1;

                return [
                  ...prev,
                  {
                    role: 'keeper' as const,
                    content: '',
                    timestamp: message.timestamp || new Date().toISOString(),
                    turnNumber: nextTurnNumber,
                    turnId: turnId,
                    isStreaming: true,
                    gameDay: message.gameDay ?? null,
                    gameTime: message.gameTime ?? null,
                  }
                ];
              });
            } else if (message.type === 'keeper_stream_delta') {
              const turnId = message.turnId as string | undefined;
              const delta = message.delta as string | undefined;
              if (!turnId || !delta) return;

              if (streamingBlockedRef.current.has(turnId)) {
                const existing = streamingBufferRef.current.get(turnId) || '';
                streamingBufferRef.current.set(turnId, existing + delta);

                setMessages(prev => {
                  const found = prev.find(msg => msg.turnId === turnId);
                  if (found) return prev;
                  const nextTurnNumber = prev.length > 0 ? Math.max(...prev.map(m => m.turnNumber)) + 1 : 1;
                  return [
                    ...prev,
                    {
                      role: 'keeper' as const,
                      content: '',
                      timestamp: new Date().toISOString(),
                      turnNumber: nextTurnNumber,
                      turnId: turnId,
                      isStreaming: true,
                      gameDay: null,
                      gameTime: null,
                    }
                  ];
                });
                return;
              }

              setMessages(prev => {
                let found = false;
                const next = prev.map(msg => {
                  if (msg.turnId === turnId) {
                    found = true;
                    return { ...msg, content: msg.content + delta, isStreaming: true };
                  }
                  return msg;
                });

                if (!found) {
                  const nextTurnNumber = prev.length > 0 ? Math.max(...prev.map(m => m.turnNumber)) + 1 : 1;
                  next.push({
                    role: 'keeper' as const,
                    content: delta,
                    timestamp: new Date().toISOString(),
                    turnNumber: nextTurnNumber,
                    turnId: turnId,
                    isStreaming: true,
                    gameDay: null,
                    gameTime: null,
                  });
                }

                return next;
              });
            } else if (message.type === 'keeper_stream_end') {
              const turnId = message.turnId as string | undefined;
              if (!turnId) return;

              setMessages(prev =>
                prev.map(msg =>
                  msg.turnId === turnId ? { ...msg, isStreaming: false } : msg
                )
              );

              setStreamingTurnId(current => current === turnId ? null : current);
            } else if (message.type === 'scene_image') {
              if (onNarrativeCompleteRef.current) {
                onNarrativeCompleteRef.current();
              }
            } else if (message.type === 'simulate_triggered') {
              console.log('[WebSocket] Simulate triggered:', message);
              // Handle simulated narrative
              if (message.keeperNarrative) {
                // Find the latest turn number and add 1 for the simulated turn
                // Use ref to get latest messages without causing reconnection
                const latestTurnNumber = messagesRef.current.length > 0 
                  ? Math.max(...messagesRef.current.map(m => m.turnNumber))
                  : 0;
                
                setMessages(prev => {
                  // Check if this turn already exists
                  const existingTurn = prev.find(m => m.turnNumber === latestTurnNumber + 1);
                  if (existingTurn) return prev;

                  return [
                    ...prev,
                    {
                      role: 'keeper' as const,
                      content: message.keeperNarrative,
                      timestamp: message.timestamp || new Date().toISOString(),
                      turnNumber: latestTurnNumber + 1,
                      turnId: message.turnId,
                      gameDay: message.gameDay ?? null,
                      gameTime: message.gameTime ?? null,
                    }
                  ];
                });

                // Trigger sidebar refresh using ref
                if (onNarrativeCompleteRef.current) {
                  onNarrativeCompleteRef.current();
                }
              }
              // Use ref to call fetchGameEnding without causing reconnection
              if (fetchGameEndingRef.current) {
                fetchGameEndingRef.current();
              }
            } else if (message.type === 'pong') {
              // Heartbeat response
              console.log('[WebSocket] Heartbeat received');
            } else if (message.type === 'progression_check_result') {
              console.log('[WebSocket] Progression check result:', message.triggered);
            } else if (message.type === 'error') {
              console.error('[WebSocket] Error:', message.message || message.error);
            }
          } catch (error) {
            console.error('[WebSocket] Error parsing message:', error);
          }
        };

        ws.onerror = (error) => {
          console.error('[WebSocket] Error:', error);
        };

        ws.onclose = () => {
          console.log('[WebSocket] Connection closed');
          wsRef.current = null;
          
          // Only reconnect if we should and session hasn't changed
          if (shouldReconnectRef.current && currentSessionIdRef.current === sessionId) {
            console.log('[WebSocket] Attempting to reconnect in 5 seconds...');
            reconnectTimeoutRef.current = window.setTimeout(() => {
              connectWebSocket();
            }, 5000);
          } else {
            console.log('[WebSocket] Reconnect disabled or session changed, not reconnecting');
          }
        };
      } catch (error) {
        console.error('[WebSocket] Failed to connect:', error);
        // Retry connection after 5 seconds only if we should reconnect
        if (shouldReconnectRef.current && currentSessionIdRef.current === sessionId) {
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connectWebSocket();
          }, 5000);
        }
      }
    };

    connectWebSocket();

    // Cleanup on unmount or when dependencies change
    return () => {
      console.log(`[WebSocket] Cleanup: disabling reconnect and closing connection`);
      shouldReconnectRef.current = false; // Disable auto-reconnect
      
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      
      if (wsRef.current) {
        // Remove event handlers to prevent onclose from triggering reconnect
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [sessionId, apiBaseUrl, isGameEnded]); // Removed fetchGameEnding to prevent unnecessary reconnections

  // Send heartbeat ping every 60 seconds
  useEffect(() => {
    if (isGameEnded) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const heartbeatInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
        console.log('[WebSocket] Sent heartbeat ping');
      }
    }, 60000); // Send ping every 60 seconds

    return () => clearInterval(heartbeatInterval);
  }, [sessionId, isGameEnded]);

  // Load conversation history on mount or when sessionId changes
  useEffect(() => {
    setStreamingTurnId(null);
    streamingBufferRef.current.clear();
    streamingBlockedRef.current.clear();
    // If initialMessages are provided, use them; otherwise load from API
    if (initialMessages && initialMessages.length > 0) {
      setMessages(initialMessages);
      // Mark all existing turnNumbers as processed
      const existingTurnNumbers = new Set(initialMessages.map(msg => msg.turnNumber));
      processedTurnIdsRef.current = new Set(Array.from(existingTurnNumbers).map(n => `turn-${n}`));
    } else if (sessionId) {
      loadConversationHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Update messages when initialMessages prop changes (e.g., when loading checkpoint)
  useEffect(() => {
    if (initialMessages && initialMessages.length > 0) {
      setMessages(initialMessages);
      // Mark all existing turnNumbers as processed
      const existingTurnNumbers = new Set(initialMessages.map(msg => msg.turnNumber));
      processedTurnIdsRef.current = new Set(Array.from(existingTurnNumbers).map(n => `turn-${n}`));
    } else if (!initialMessages && sessionId) {
      // If initialMessages is cleared, reload from API
      loadConversationHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessages]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle dice animation completion - use useRef to access latest pendingDiceRolls
  const pendingDiceRollsRef = useRef(pendingDiceRolls);
  useEffect(() => {
    pendingDiceRollsRef.current = pendingDiceRolls;
  }, [pendingDiceRolls]);

  // Track if callback has been called for current dice rolls to prevent duplicate calls
  const diceAnimationCallbackCalledRef = useRef<string>('');

  const handleDiceAnimationComplete = useCallback(() => {
    console.log(`[GameChat] Dice animation completed`);
    const currentPendingDiceRolls = pendingDiceRollsRef.current;
    console.log(`[GameChat] Current pendingDiceRolls:`, currentPendingDiceRolls);
    
    if (!currentPendingDiceRolls) {
      console.warn(`[GameChat] handleDiceAnimationComplete called but pendingDiceRolls is null`);
      return;
    }

    // Create a unique key for this set of dice rolls
    const diceRollsKey = JSON.stringify({
      turnNumber: currentPendingDiceRolls.turnNumber,
      diceRolls: currentPendingDiceRolls.diceRolls,
      timestamp: currentPendingDiceRolls.timestamp
    });

    // Prevent duplicate calls for the same dice roll set
    if (diceAnimationCallbackCalledRef.current === diceRollsKey) {
      console.log(`[GameChat] Callback already called for this dice roll set, skipping...`);
      return;
    }

    // Mark this set as processed
    diceAnimationCallbackCalledRef.current = diceRollsKey;
    
    // Mark animation as completed - this will trigger narrative display
    console.log(`[GameChat] Setting diceAnimationCompleted to true, narrative length: ${currentPendingDiceRolls.narrative?.length || 0}`);
    setDiceAnimationCompleted(true);
    
    // Trigger sidebar refresh using ref to avoid dependency issues
    if (onNarrativeCompleteRef.current) {
      onNarrativeCompleteRef.current();
    }
  }, []); // No dependencies - uses refs to access latest values

  // Add completed dice animation message to messages array
  useEffect(() => {
    if (diceAnimationCompleted && pendingDiceRolls) {
      console.log(`[GameChat] Adding completed dice animation to messages`);

      if (pendingDiceRolls.isStreaming) {
        const turnId = pendingDiceRolls.turnId;

        if (turnId) {
          streamingBlockedRef.current.delete(turnId);
        }
        const buffered = turnId ? (streamingBufferRef.current.get(turnId) || '') : '';
        if (turnId && buffered) {
          streamingBufferRef.current.delete(turnId);
        }

        if (turnId) {
          setMessages(prev => {
            const hasMessage = prev.some(msg => msg.turnId === turnId);
            const next = hasMessage
              ? prev.map(msg =>
                  msg.turnId === turnId
                    ? {
                        ...msg,
                        content: msg.content + buffered,
                        isStreaming: true,
                        diceRolls: msg.diceRolls ?? pendingDiceRolls.diceRolls,
                        gameDay: pendingDiceRolls.gameDay ?? msg.gameDay ?? null,
                        gameTime: pendingDiceRolls.gameTime ?? msg.gameTime ?? null,
                      }
                    : msg
                )
              : [
                  ...prev,
                  {
                    role: 'keeper' as const,
                    content: buffered,
                    timestamp: pendingDiceRolls.timestamp,
                    turnNumber: pendingDiceRolls.turnNumber,
                    turnId: pendingDiceRolls.turnId,
                    isStreaming: true,
                    diceRolls: pendingDiceRolls.diceRolls,
                    gameDay: pendingDiceRolls.gameDay ?? null,
                    gameTime: pendingDiceRolls.gameTime ?? null,
                  }
                ];
            return next;
          });
        }

        setShowingDiceAnimation(false);
        setPendingDiceRolls(null);
        setDiceAnimationCompleted(false);
        return;
      }

      setMessages(prev => {
        // Check if this message already exists
        const existingMessage = prev.find(msg =>
          msg.turnNumber === pendingDiceRolls.turnNumber && msg.role === 'keeper'
        );
        if (existingMessage) {
          console.log(`[GameChat] Message for turn ${pendingDiceRolls.turnNumber} already exists, skipping...`);
          return prev;
        }

        // Add the keeper message with dice rolls
        const keeperMessage: Message = {
          role: 'keeper',
          content: pendingDiceRolls.narrative,
          timestamp: pendingDiceRolls.timestamp,
          turnNumber: pendingDiceRolls.turnNumber,
          turnId: pendingDiceRolls.turnId,
          diceRolls: pendingDiceRolls.diceRolls,
          gameDay: pendingDiceRolls.gameDay ?? null,
          gameTime: pendingDiceRolls.gameTime ?? null,
        };
        return [...prev, keeperMessage];
      });

      // Clear the pending dice rolls to hide the temporary animation message
      setShowingDiceAnimation(false);
      setPendingDiceRolls(null);
      setDiceAnimationCompleted(false);
    }
  }, [diceAnimationCompleted, pendingDiceRolls]);

  // Update messages when turn completes
  useEffect(() => {
    if (turn && turn.status === 'completed') {
      // Check if we've already processed this turn to avoid duplicates
      const turnKey = turn.turnId || `turn-${turn.turnNumber}`;
      const turnNumberKey = `turn-${turn.turnNumber}`;
      if (
        processedTurnIdsRef.current.has(turnKey) ||
        processedTurnIdsRef.current.has(turnNumberKey) ||
        (turn.turnId && processedTurnIdsRef.current.has(turn.turnId))
      ) {
        console.log(`[GameChat] Turn ${turnKey} already processed, skipping...`);
        return;
      }

      // Log turn details for debugging
      console.log(`[GameChat] Processing completed turn:`, {
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        hasKeeperNarrative: !!turn.keeperNarrative,
        keeperNarrativeLength: turn.keeperNarrative?.length || 0,
        hasActionResults: !!turn.actionResults,
        actionResultsCount: turn.actionResults?.length || 0,
        actionResultsType: typeof turn.actionResults,
        actionResultsValue: turn.actionResults,
        characterInput: turn.characterInput?.substring(0, 50) + '...',
      });

      // Mark this turn as processed
      processedTurnIdsRef.current.add(turnKey);
      processedTurnIdsRef.current.add(turnNumberKey);
      if (turn.turnId) {
        processedTurnIdsRef.current.add(turn.turnId);
      }

      // Build structured dice roll infos from action results
      const allDiceRolls: DiceRollInfo[] = buildDiceRollInfos(
        turn.actionResults || [],
        characterName
      );
      console.log(`[GameChat] Has keeperNarrative: ${!!turn.keeperNarrative}`);

      const existingStreamingMessage = turn.turnId
        ? messagesRef.current.find(msg => msg.turnId === turn.turnId && msg.role === 'keeper')
        : null;

      if (existingStreamingMessage) {
        setMessages(prev => prev.map(msg => {
          if (msg.turnId !== turn.turnId) return msg;
          return {
            ...msg,
            content: turn.keeperNarrative || msg.content,
            timestamp: turn.completedAt || turn.startedAt,
            turnNumber: turn.turnNumber,
            isStreaming: false,
            diceRolls: allDiceRolls.length > 0 ? allDiceRolls : msg.diceRolls,
            gameDay: turn.gameDay ?? msg.gameDay ?? null,
            gameTime: turn.gameTime ?? msg.gameTime ?? null,
          };
        }));

        if (turn.turnId) {
          setStreamingTurnId(current => current === turn.turnId ? null : current);
        }

        if (onNarrativeComplete) {
          onNarrativeComplete();
        }

        setIsSending(false);
        if (fetchGameEndingRef.current) {
          fetchGameEndingRef.current();
        }
        return;
      }

      // If there are dice rolls, show animation first
      if (allDiceRolls.length > 0 && turn.keeperNarrative) {
        console.log(`[GameChat] Showing dice animation for ${allDiceRolls.length} dice rolls`);
        // Reset callback tracking when new dice rolls are set
        diceAnimationCallbackCalledRef.current = ''; // Reset to allow new callback
        setPendingDiceRolls({
          turnNumber: turn.turnNumber,
          turnId: turn.turnId,
          diceRolls: allDiceRolls,
          narrative: turn.keeperNarrative,
          timestamp: turn.completedAt || turn.startedAt,
          gameDay: turn.gameDay ?? null,
          gameTime: turn.gameTime ?? null,
        });
        setShowingDiceAnimation(true);
        setDiceAnimationCompleted(false); // Reset animation completed state
      } else {
        // No dice rolls, add narrative directly to messages
        setMessages(prev => {
          // Check if keeper response for this turn already exists
          const existingKeeperMessage = prev.find(msg => 
            msg.role === 'keeper' && (
              (turn.turnId && msg.turnId === turn.turnId) ||
              msg.turnNumber === turn.turnNumber
            )
          );
          if (existingKeeperMessage) {
            console.log(`[GameChat] Keeper message for turn ${turn.turnNumber} already exists, skipping...`);
            return prev;
          }

          // Only add keeper message if narrative exists
          if (turn.keeperNarrative) {
            const keeperMessage: Message = {
              role: 'keeper' as const,
              content: turn.keeperNarrative,
              timestamp: turn.completedAt || turn.startedAt,
              turnNumber: turn.turnNumber,
              turnId: turn.turnId,
              gameDay: turn.gameDay ?? null,
              gameTime: turn.gameTime ?? null,
            };
            return [...prev, keeperMessage];
          } else {
            console.warn(`[GameChat] Turn ${turn.turnNumber} completed but keeperNarrative is empty`);
            return prev;
          }
        });

        // Trigger sidebar refresh when narrative is complete
        if (onNarrativeComplete) {
          onNarrativeComplete();
        }
      }

      setIsSending(false);
      // Use ref to call fetchGameEnding without causing reconnection
      if (fetchGameEndingRef.current) {
        fetchGameEndingRef.current();
      }
    } else if (turn && turn.status === 'error') {
      // Handle error case
      console.error(`[GameChat] Turn ${turn.turnId || turn.turnNumber} failed:`, turn.errorMessage);
      setIsSending(false);
    }
  }, [turn, onNarrativeComplete]);

  useEffect(() => {
    if (!isGameEnded) return;

    stopPolling();
    setIsSending(false);
    shouldReconnectRef.current = false;

    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, [isGameEnded, stopPolling]);

  const loadConversationHistory = async () => {
    try {
      const response = await authFetch(`${apiBaseUrl}/sessions/${sessionId}/conversation`);
      const data = await response.json();

      if (data.success && data.conversation) {
        setMessages(data.conversation);
        // Mark all existing turnNumbers as processed
        const existingTurnNumbers = new Set(data.conversation.map((msg: Message) => msg.turnNumber));
        processedTurnIdsRef.current = new Set(Array.from(existingTurnNumbers).map(n => `turn-${n}`));
      } else {
        setMessages([]);
        processedTurnIdsRef.current.clear();
      }
    } catch (err) {
      console.error('Failed to load conversation history:', err);
      setMessages([]);
      processedTurnIdsRef.current.clear();
    }
  };

  const handleSendMessage = async () => {
    if (!inputValue.trim() || isSending || isGameEnded) return;

    const messageText = inputValue.trim();
    const trimmedSkill = selectedSkill.trim();
    const hasSelectedSkill = trimmedSkill.length > 0;
    const skillToSend = hasSelectedSkill ? trimmedSkill : null;
    const skillSelectionMode = hasSelectedSkill ? 'manual' : (isSkillAuto ? 'auto' : 'manual');
    setInputValue('');
    setIsSending(true);
    setIsSkillPickerOpen(false);

    // Immediately add user message to chat
    const nextTurnNumber = messages.length > 0 ? Math.max(...messages.map(m => m.turnNumber)) + 1 : 1;
    const userMessage: Message = {
      role: 'character' as const,
      content: messageText,
      timestamp: new Date().toISOString(),
      turnNumber: nextTurnNumber,
      gameDay: currentGameState?.gameDay ?? null,
      gameTime: currentGameState?.timeOfDay ?? null,
    };
    
    setMessages(prev => [...prev, userMessage]);

    try {
      // Send message and create turn
      const response = await authFetch(`${apiBaseUrl}/turns`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: messageText,
          selectedSkill: skillToSend,
          skillSelectionMode,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to send message');
      }

      setSelectedSkill('');
      // Start polling for turn completion
      startPolling(data.turnId);

    } catch (err) {
      console.error('Failed to send message:', err);
      setIsSending(false);
      
      // Remove the user message that was optimistically added
      setMessages(prev => prev.filter(msg => 
        !(msg.role === 'character' && msg.content === messageText && msg.turnNumber === userMessage.turnNumber)
      ));
      
      alert('Failed to send message: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      handleSendMessage();
    }
  };

  // Collapsible input area handlers
  const handleInputAreaMouseEnter = () => {
    // Clear any pending collapse timeout
    if (collapseTimeoutRef.current) {
      clearTimeout(collapseTimeoutRef.current);
      collapseTimeoutRef.current = null;
    }
    // Expand the input area
    setIsInputCollapsed(false);
  };

  const handleInputAreaMouseLeave = () => {
    // Only collapse if input is empty
    if (!inputValue.trim()) {
      // Start a 1-second timeout before collapsing
      collapseTimeoutRef.current = setTimeout(() => {
        setIsInputCollapsed(true);
      }, 1000);
    }
  };

  // Expand input when user starts typing
  useEffect(() => {
    if (inputValue.trim()) {
      setIsInputCollapsed(false);
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
        collapseTimeoutRef.current = null;
      }
    }
  }, [inputValue]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, []);

  const handleSaveCheckpoint = async () => {
    if (isSaving) return;

    setIsSaving(true);
    setSaveMessage(null);

    try {
      const response = await authFetch(`${apiBaseUrl}/checkpoints/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to save checkpoint');
      }

      setSaveMessage(`✓ ${data.message}: ${data.checkpointName}`);
      
      // Clear message after 3 seconds
      setTimeout(() => {
        setSaveMessage(null);
      }, 3000);
    } catch (err) {
      console.error('Failed to save checkpoint:', err);
      setSaveMessage('Failed to save: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="game-chat-container backdrop-blur-sm border border-slate-200 shadow-md rounded-lg">
      {/* Session Info Bar */}
      <div className="session-info-bar">
        <div className="character-info backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-3 py-1.5 h-9 flex items-center">
          <span className="character-label">Playing as:</span>
          <span className="character-value">{characterName}</span>
        </div>
        <div className="save-checkpoint-section">
          <button
            className="save-checkpoint-btn backdrop-blur-md bg-white/50 border border-slate-200 shadow-md rounded-xl px-3 py-1.5 text-sm hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 transition-all h-9"
            onClick={handleSaveCheckpoint}
            disabled={isSaving}
            title="Save current game progress"
          >
            {isSaving ? '💾 Saving...' : '💾 Save'}
          </button>
          {saveMessage && (
            <span className="save-message" style={{
              marginLeft: '10px',
              fontSize: '0.85rem',
              color: saveMessage.startsWith('✓') ? '#155724' : '#721c24'
            }}>
              {saveMessage}
            </span>
          )}
        </div>
      </div>

      {/* Messages Area */}
      <div className="messages-scroll-area">
        {messages.length === 0 && (
          <div className="empty-chat-prompt">
            <p>🎲 Welcome to Call of Cthulhu!</p>
            <p>Describe your investigator's actions to begin the adventure...</p>
          </div>
        )}

        {messages.map((msg, index) => (
          <div key={index} className={`chat-message ${msg.role}`}>
            <div className="message-meta">
              <span className="sender-name">
                {msg.role === 'character' ? `📝 ${characterName}` : '🎭 Keeper'}
              </span>
              <span className="message-timestamp">
                {msg.gameTime && msg.gameTime !== null && msg.gameTime !== undefined && msg.gameTime !== ''
                  ? `Day ${msg.gameDay ?? 1}, ${msg.gameTime}`
                  : new Date(msg.timestamp).toLocaleTimeString('en-US', { 
                      hour: '2-digit', 
                      minute: '2-digit' 
                    })}
              </span>
            </div>
            {msg.diceRolls && msg.diceRolls.length > 0 && (
              <DiceAnimation 
              diceRolls={msg.diceRolls} 
              onAnimationComplete={undefined}
            />
            )}
            {msg.imageUrl && (
              <div className="scene-image-wrapper">
                <img
                  className="scene-image"
                  src={msg.imageUrl}
                  alt={msg.imageCaption || 'Scene image'}
                />
                {msg.imageCaption && (
                  <div className="scene-image-caption">{msg.imageCaption}</div>
                )}
              </div>
            )}
            {msg.content && (
              <div className={`message-text backdrop-blur-sm border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px] ${
                msg.role === 'character' 
                  ? 'bg-[rgba(232,220,196,0.5)]' 
                  : 'bg-white/50'
              }`}>
                <ReactMarkdown className="markdown-content">{msg.content}</ReactMarkdown>
              </div>
            )}
          </div>
        ))}

        {showingDiceAnimation && pendingDiceRolls && (
          <div className="chat-message keeper dice-message">
            <div className="message-meta">
              <span className="sender-name">🎭 Keeper</span>
              <span className="message-timestamp">
                {pendingDiceRolls.gameTime && pendingDiceRolls.gameTime !== null && pendingDiceRolls.gameTime !== undefined && pendingDiceRolls.gameTime !== ''
                  ? `Day ${pendingDiceRolls.gameDay ?? 1}, ${pendingDiceRolls.gameTime}`
                  : new Date(pendingDiceRolls.timestamp).toLocaleTimeString('en-US', { 
                      hour: '2-digit', 
                      minute: '2-digit' 
                    })}
              </span>
            </div>
            <DiceAnimation 
              diceRolls={pendingDiceRolls.diceRolls} 
              onAnimationComplete={handleDiceAnimationComplete}
            />
            {/* Show narrative after dice animation completes */}
            {diceAnimationCompleted && pendingDiceRolls && pendingDiceRolls.narrative && (
              <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]" style={{ marginTop: '16px' }}>
                <ReactMarkdown className="markdown-content">{pendingDiceRolls.narrative}</ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {(isSending || isPolling) && !streamingTurnId && (
          <div className="chat-message keeper loading">
            <div className="message-meta">
              <span className="sender-name">🎭 Keeper</span>
            </div>
            <div className="message-text backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-[18px] py-[14px]">
              <span className="typing-indicator">
                <span>•</span><span>•</span><span>•</span>
              </span>
              {isPolling ? ' The Keeper contemplates...' : ' Processing your action...'}
            </div>
          </div>
        )}

        {error && (
          <div className="error-message">
            <strong>⚠️ Error:</strong> {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="fixed bottom-0 left-0 right-0 z-30 pointer-events-none px-2 sm:px-0">
        <div
          onMouseEnter={handleInputAreaMouseEnter}
          onMouseLeave={handleInputAreaMouseLeave}
          className={`mx-auto w-full px-4 sm:px-0 pointer-events-auto rounded-3xl border border-white/30 dark:border-white/20 backdrop-blur-md shadow-[0_5px_13px_rgba(15,23,42,0.55)] ease-in-out ${
            isInputCollapsed && !inputValue.trim()
              ? 'max-w-[160px] max-h-6 overflow-hidden mb-3 [transition:max-height_0.5s_ease-in-out,max-width_1s_ease-in-out_0.5s]'
              : 'max-w-xl max-h-[80vh] mb-2 [transition:max-width_1s_ease-in-out,max-height_0.5s_ease-in-out]'
          }`}
        >
          <div
            className={`flex flex-col transition-opacity duration-300 ${
              isInputCollapsed && !inputValue.trim()
                ? 'space-y-0 opacity-0 pointer-events-none invisible'
                : 'space-y-1 opacity-100 visible'
            }`}
            aria-hidden={isInputCollapsed && !inputValue.trim()}
          >
            {/* Input Form */}
            <div className="px-2 pb-2 pt-2">
              <div className="relative">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-6 bottom-[-40px] h-24 rounded-full bg-slate-500/10 blur-3xl dark:bg-slate-900/60"
                />
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendMessage();
                  }}
                  className="relative z-10 overflow-hidden rounded-2xl border border-white/50 shadow-[0_6px_15px_rgba(15,23,42,0.25)] transition-all duration-300 ease-in-out bg-white/80 dark:bg-slate-950/60 supports-[backdrop-filter]:bg-white/55 supports-[backdrop-filter]:backdrop-blur-2xl dark:supports-[backdrop-filter]:bg-slate-900/40"
                >
                  {(suggestedSkills.length > 0 || selectedSkill || isSkillAuto) && (
                    <div className="px-3 pt-2">
                      <div className="flex items-center">
                        <span className="text-[10px] uppercase tracking-wide text-slate-500">
                          Suggested Skills{isSuggesting ? '...' : ''}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {selectedSkill && (
                          <button
                            type="button"
                            className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-200 px-2 py-0.5 text-[11px] text-amber-900 shadow-[0_10px_20px_rgba(124,45,18,0.25)] transition-all -translate-y-0.5"
                            onClick={() => {
                              setSelectedSkill('');
                              setIsSkillAuto(false);
                            }}
                            disabled={isSending || isPolling || isGameEnded}
                          >
                            {(() => {
                              const selectedDisplay =
                                suggestedSkills.find((item) => item.name === selectedSkill)?.displayName ??
                                (suggestedLanguage === 'zh'
                                  ? availableSkills.find((item) => item.name === selectedSkill)?.displayNameZh ?? getSkillNameZh(selectedSkill)
                                  : selectedSkill);
                              return selectedDisplay;
                            })()}
                            {(() => {
                              const selectedValue =
                                availableSkills.find((item) => item.name === selectedSkill)?.value ??
                                suggestedSkills.find((item) => item.name === selectedSkill)?.value ??
                                null;
                              return Number.isFinite(selectedValue as number) ? ` ${selectedValue}%` : '';
                            })()}
                          </button>
                        )}
                        {suggestedSkills
                          .filter((skill) => skill.name !== selectedSkill)
                          .map((skill) => (
                        <button
                          key={skill.name}
                          type="button"
                          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-sm transition-all ${
                            selectedSkill === skill.name
                              ? 'border-amber-300 bg-amber-200 text-amber-900 -translate-y-0.5 shadow-[0_10px_20px_rgba(124,45,18,0.25)]'
                              : 'border-slate-200 bg-white/70 text-slate-700 hover:-translate-y-0.5 hover:shadow-md'
                          }`}
                          onClick={() => {
                            setSelectedSkill(selectedSkill === skill.name ? '' : skill.name);
                            setIsSkillAuto(false);
                          }}
                          disabled={isSending || isPolling || isGameEnded}
                        >
                          {skill.displayName ?? skill.name}
                          {Number.isFinite(skill.value) ? ` ${skill.value}%` : ''}
                        </button>
                      ))}
                        <div className="ml-auto flex items-center gap-1">
                          <button
                            type="button"
                            className={`flex h-6 items-center rounded-full border px-2 text-[10px] uppercase tracking-wide shadow-sm transition-all ${
                              isSkillAuto
                                ? 'border-amber-300 bg-amber-200 text-amber-900 shadow-[0_8px_16px_rgba(124,45,18,0.2)]'
                                : 'border-slate-200 bg-white/70 text-slate-600 hover:-translate-y-0.5 hover:bg-white hover:shadow-md'
                            }`}
                            onClick={() => {
                              setIsSkillAuto((prev) => {
                                const next = !prev;
                                if (next) {
                                  setSelectedSkill('');
                                  setIsSkillPickerOpen(false);
                                }
                                return next;
                              });
                            }}
                            disabled={isSending || isPolling || isGameEnded}
                            aria-label="Auto select skill"
                          >
                            auto
                          </button>
                          <button
                            type="button"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white/70 text-[11px] text-slate-600 shadow-sm transition-all hover:-translate-y-0.5 hover:bg-white hover:shadow-md [&_svg]:shrink-0"
                            onClick={() => setIsSkillPickerOpen((prev) => !prev)}
                            disabled={isSending || isPolling || isGameEnded || availableSkills.length === 0}
                            aria-label="Choose skill"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                              aria-hidden="true"
                            >
                              <circle cx="6" cy="12" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="18" cy="12" r="2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {isSkillPickerOpen && availableSkills.length > 0 && (
                    <div className="mx-3 mt-2 max-h-40 overflow-auto rounded-xl border border-slate-200 bg-white/80 p-2 text-[11px] text-slate-700 shadow-sm">
                      <div className="flex flex-wrap gap-1.5">
                        {availableSkills.map((skill) => (
                          <button
                            key={skill.name}
                            type="button"
                            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-sm transition-all ${
                              selectedSkill === skill.name
                                ? 'border-amber-300 bg-amber-200 text-amber-900 shadow-[0_8px_16px_rgba(124,45,18,0.2)]'
                                : 'border-slate-200 bg-white/70 text-slate-700 hover:-translate-y-0.5 hover:shadow-md'
                            }`}
                            onClick={() => {
                              setSelectedSkill(selectedSkill === skill.name ? '' : skill.name);
                              setIsSkillAuto(false);
                              setIsSkillPickerOpen(false);
                            }}
                            disabled={isSending || isPolling || isGameEnded}
                          >
                            {suggestedLanguage === 'zh'
                              ? (skill.displayNameZh ?? getSkillNameZh(skill.name))
                              : skill.name}
                            {Number.isFinite(skill.value) ? ` ${skill.value}%` : ''}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <textarea
                    className="select-none md:text-sm max-h-12 px-4 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 w-full flex items-center h-16 min-h-10 resize-none rounded-md bg-transparent border-0 py-1 pl-2 pr-0.5 mt-2 shadow-none focus-visible:ring-0"
                    autoComplete="off"
                    name="message"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={isGameEnded ? "The story has ended." : "Type your message here..."}
                    disabled={isSending || isPolling || isGameEnded}
                  />
                  <div className="flex items-center p-1.5 pt-0">
                    <button
                      type="submit"
                      className="inline-flex items-center justify-center whitespace-nowrap font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 backdrop-blur-md bg-white/50 border border-slate-200 text-slate-900 shadow-md hover:bg-white/70 hover:border-slate-300 hover:-translate-y-0.5 rounded-xl px-3 text-xs ml-auto gap-0.5 h-[30px]"
                      disabled={!inputValue.trim() || isSending || isPolling || isGameEnded}
                    >
                      {isGameEnded ? 'Game Ended' : isSending || isPolling ? 'Processing...' : 'Send Message'}
                      {!isGameEnded && !isSending && !isPolling && (
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-send size-3.5">
                          <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/>
                          <path d="m21.854 2.147-10.94 10.939"/>
                        </svg>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
