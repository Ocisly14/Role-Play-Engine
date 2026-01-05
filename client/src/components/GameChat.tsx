/**
 * GameChat Component - Main game interaction interface
 * 
 * Handles sending messages to the game and displaying conversation history.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTurnPolling } from '../hooks/useTurnPolling';
import { DiceAnimation } from './DiceAnimation';

interface Message {
  role: 'character' | 'keeper';
  content: string;
  timestamp: string;
  turnNumber: number;
  diceRolls?: string[]; // Optional dice rolls for keeper messages
}

interface GameChatProps {
  sessionId: string;
  apiBaseUrl?: string;
  characterName?: string;
  moduleIntroduction?: { introduction: string; moduleNotes: string } | null;
  initialMessages?: Message[];
  onNarrativeComplete?: () => void;
}

export function GameChat({ sessionId, apiBaseUrl = 'http://localhost:3000/api', characterName = 'Investigator', moduleIntroduction, initialMessages, onNarrativeComplete }: GameChatProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages || []);
  const [inputValue, setInputValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processedTurnIdsRef = useRef<Set<string>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef<boolean>(true); // Track if we should auto-reconnect
  const currentSessionIdRef = useRef<string | null>(null); // Track current session to avoid duplicate connections
  // Refs to access latest values without causing WebSocket reconnection
  const messagesRef = useRef<Message[]>(messages);
  const onNarrativeCompleteRef = useRef(onNarrativeComplete);
  const { turn, isPolling, error, startPolling } = useTurnPolling(apiBaseUrl);
  
  // State for dice animation
  const [pendingDiceRolls, setPendingDiceRolls] = useState<{ turnNumber: number; diceRolls: string[]; narrative: string; timestamp: string } | null>(null);
  const [showingDiceAnimation, setShowingDiceAnimation] = useState(false);
  const [diceAnimationCompleted, setDiceAnimationCompleted] = useState(false);

  // Update refs when values change
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    onNarrativeCompleteRef.current = onNarrativeComplete;
  }, [onNarrativeComplete]);

  // WebSocket connection for progression checking
  useEffect(() => {
    if (!sessionId) return;

    // Check if we already have a connection for this sessionId
    if (currentSessionIdRef.current === sessionId && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      console.log(`[WebSocket] Already connected for session ${sessionId}, skipping...`);
      return;
    }

    // Get WebSocket URL from apiBaseUrl
    const wsUrl = apiBaseUrl.replace('/api', '').replace('http://', 'ws://').replace('https://', 'wss://');
    const wsPath = `${wsUrl}/ws?sessionId=${sessionId}`;

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
                    }
                  ];
                });

                // Trigger sidebar refresh using ref
                if (onNarrativeCompleteRef.current) {
                  onNarrativeCompleteRef.current();
                }
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
  }, [sessionId, apiBaseUrl]); // Removed messages and onNarrativeComplete from dependencies

  // Send heartbeat ping every 60 seconds
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const heartbeatInterval = setInterval(() => {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
        console.log('[WebSocket] Sent heartbeat ping');
      }
    }, 60000); // Send ping every 60 seconds

    return () => clearInterval(heartbeatInterval);
  }, [sessionId]);

  // Load conversation history on mount or when sessionId changes
  useEffect(() => {
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
      if (processedTurnIdsRef.current.has(turnKey)) {
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

      // If there are dice rolls, show animation first
      if (allDiceRolls.length > 0 && turn.keeperNarrative) {
        console.log(`[GameChat] Showing dice animation for ${allDiceRolls.length} dice rolls`);
        // Reset callback tracking when new dice rolls are set
        diceAnimationCallbackCalledRef.current = ''; // Reset to allow new callback
        setPendingDiceRolls({
          turnNumber: turn.turnNumber,
          diceRolls: allDiceRolls,
          narrative: turn.keeperNarrative,
          timestamp: turn.completedAt || turn.startedAt,
        });
        setShowingDiceAnimation(true);
        setDiceAnimationCompleted(false); // Reset animation completed state
      } else {
        // No dice rolls, add narrative directly to messages
        setMessages(prev => {
          // Check if keeper response for this turn already exists
          const existingKeeperMessage = prev.find(msg => 
            msg.turnNumber === turn.turnNumber && msg.role === 'keeper'
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
    } else if (turn && turn.status === 'error') {
      // Handle error case
      console.error(`[GameChat] Turn ${turn.turnId || turn.turnNumber} failed:`, turn.errorMessage);
      setIsSending(false);
    }
  }, [turn, onNarrativeComplete]);

  const loadConversationHistory = async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/sessions/${sessionId}/conversation`);
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
    if (!inputValue.trim() || isSending) return;

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
    };
    
    setMessages(prev => [...prev, userMessage]);

    try {
      // Send message and create turn
      const response = await fetch(`${apiBaseUrl}/turns`, {
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
      const response = await fetch(`${apiBaseUrl}/checkpoints/save`, {
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
        <div className="session-metadata">
          <span className="session-label">Session ID:</span>
          <span className="session-value">{sessionId}</span>
        </div>
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
                {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { 
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
            <div className="message-text">{msg.content}</div>
          </div>
        ))}

        {showingDiceAnimation && pendingDiceRolls && (
          <div className="chat-message keeper dice-message">
            <div className="message-meta">
              <span className="sender-name">🎭 Keeper</span>
              <span className="message-timestamp">
                {new Date(pendingDiceRolls.timestamp).toLocaleTimeString('zh-CN', { 
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

        {(isSending || isPolling) && (
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
          placeholder="I examine the ancient tome on the desk..."
          disabled={isSending || isPolling}
          rows={3}
        />
        <button
          className="submit-action-btn"
          onClick={handleSendMessage}
          disabled={!inputValue.trim() || isSending || isPolling}
        >
          {isSending || isPolling ? '⏳ Processing...' : '🎲 Declare Action'}
        </button>
      </div>
    </div>
  );
}