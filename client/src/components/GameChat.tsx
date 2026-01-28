/**
 * GameChat Component - Main game interaction interface
 * 
 * Handles sending messages to the game and displaying conversation history.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTurnPolling } from '../hooks/useTurnPolling';
import { DiceAnimation } from './DiceAnimation';
import { authFetch } from '../utils/authFetch';

interface Message {
  role: 'character' | 'keeper';
  content: string;
  timestamp: string;
  turnNumber: number;
  turnId?: string;
  isStreaming?: boolean;
  imageUrl?: string;
  imageCaption?: string;
  diceRolls?: string[]; // Optional dice rolls for keeper messages
  gameDay?: number | null; // Game day when message was sent
  gameTime?: string | null; // Game time (HH:MM format) when message was sent
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
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null);
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
  const { turn, isPolling, error, startPolling, stopPolling } = useTurnPolling(apiBaseUrl);
  
  // State for dice animation
  const [pendingDiceRolls, setPendingDiceRolls] = useState<{ turnNumber: number; turnId?: string; diceRolls: string[]; narrative: string; timestamp: string; gameDay?: number | null; gameTime?: string | null; isStreaming?: boolean } | null>(null);
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
      }
    } catch (err) {
      console.error('[GameChat] Failed to fetch game state:', err);
    }
  }, [apiBaseUrl, sessionId]);

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
              const diceRolls = message.diceRolls as string[] | undefined;
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
                    role: 'keeper',
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
                      role: 'keeper',
                      content: '',
                      timestamp: new Date().toISOString(),
                      turnNumber: nextTurnNumber,
                      turnId: turnId,
                      isStreaming: true,
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
                    role: 'keeper',
                    content: delta,
                    timestamp: new Date().toISOString(),
                    turnNumber: nextTurnNumber,
                    turnId: turnId,
                    isStreaming: true,
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
                      role: 'keeper',
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
                    role: 'keeper',
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

      // Check if there are dice rolls to show
      const allDiceRolls: string[] = [];
      if (turn.actionResults && turn.actionResults.length > 0) {
        console.log(`[GameChat] Processing ${turn.actionResults.length} actionResults`);
        turn.actionResults.forEach((result, index) => {
          console.log(`[GameChat] ActionResult[${index}]:`, {
            hasDiceRolls: !!result.diceRolls,
            diceRollsType: typeof result.diceRolls,
            diceRollsValue: result.diceRolls,
            diceRollsLength: result.diceRolls?.length || 0,
            result: result.result?.substring(0, 50) + '...',
          });
          if (result.diceRolls && result.diceRolls.length > 0) {
            console.log(`[GameChat] Found dice rolls in actionResult[${index}]:`, result.diceRolls);
            allDiceRolls.push(...result.diceRolls);
          } else {
            console.log(`[GameChat] ActionResult[${index}] has no diceRolls or diceRolls is empty`);
          }
        });
      } else {
        console.log(`[GameChat] No actionResults or actionResults is empty:`, {
          actionResults: turn.actionResults,
          isArray: Array.isArray(turn.actionResults),
          isNull: turn.actionResults === null,
          isUndefined: turn.actionResults === undefined,
        });
      }

      console.log(`[GameChat] Total dice rolls collected: ${allDiceRolls.length}`, allDiceRolls);
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
              role: 'keeper',
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
    setInputValue('');
    setIsSending(true);

    // Immediately add user message to chat
    const nextTurnNumber = messages.length > 0 ? Math.max(...messages.map(m => m.turnNumber)) + 1 : 1;
    const userMessage: Message = {
      role: 'character',
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
        }),
      });

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Failed to send message');
      }

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

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

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
    <div className="game-chat-container">
      {/* Session Info Bar */}
      <div className="session-info-bar">
        <div className="character-info">
          <span className="character-label">Playing as:</span>
          <span className="character-value">{characterName}</span>
        </div>
        <div className="save-checkpoint-section">
          <button
            className="save-checkpoint-btn"
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
            {msg.content && <div className="message-text">{msg.content}</div>}
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
              <div className="message-text" style={{ marginTop: '16px' }}>
                {pendingDiceRolls.narrative}
              </div>
            )}
          </div>
        )}

        {(isSending || isPolling) && !streamingTurnId && (
          <div className="chat-message keeper loading">
            <div className="message-meta">
              <span className="sender-name">🎭 Keeper</span>
            </div>
            <div className="message-text">
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
      <div className="chat-input-area">
        <textarea
          className="action-input"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={isGameEnded ? "The story has ended." : "I examine the ancient tome on the desk..."}
          disabled={isSending || isPolling || isGameEnded}
          rows={3}
        />
        <button
          className="submit-action-btn"
          onClick={handleSendMessage}
          disabled={!inputValue.trim() || isSending || isPolling || isGameEnded}
        >
          {isGameEnded ? '🏁 Game Ended' : isSending || isPolling ? '⏳ Processing...' : '🎲 Declare Action'}
        </button>
      </div>
    </div>
  );
}
