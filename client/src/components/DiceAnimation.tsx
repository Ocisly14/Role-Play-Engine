/**
 * DiceAnimation Component - Displays animated dice rolls
 * 
 * Shows spinning dice animation, then reveals the final result.
 */

import { useState, useEffect, useMemo, useRef } from 'react';

interface DiceAnimationProps {
  diceRolls: string[];
  onAnimationComplete?: () => void;
}

interface ParsedDiceRoll {
  expression: string;
  result: number;
  diceType: string; // e.g., "d100", "d6"
  numDice: number;
}

// Parse dice roll function (extracted for reuse)
function parseDiceRoll(roll: string): ParsedDiceRoll {
  console.log(`[DiceAnimation] Parsing dice roll: "${roll}"`);
  
  // Format 1: "roll_dice: 1d100 -> 1 = 9" or "roll_dice: 1d100 -> 9"
  let match = roll.match(/roll_dice:\s*(\d+)d(\d+)\s*->\s*(?:[\d+\s=]+\s*=\s*)?(\d+)/);
  if (match) {
    const expression = `${match[1]}d${match[2]}`;
    const result = parseInt(match[3], 10);
    console.log(`[DiceAnimation] Matched format 1: expression=${expression}, result=${result}`);
    return {
      expression: expression,
      result: result,
      diceType: `d${match[2]}`,
      numDice: parseInt(match[1], 10),
    };
  }
  
  // Format 2: "1d100 -> 45" (simple format)
  match = roll.match(/^(\d+)d(\d+)\s*->\s*(\d+)$/);
  if (match) {
    const expression = `${match[1]}d${match[2]}`;
    const result = parseInt(match[3], 10);
    console.log(`[DiceAnimation] Matched format 2: expression=${expression}, result=${result}`);
    return {
      expression: expression,
      result: result,
      diceType: `d${match[2]}`,
      numDice: parseInt(match[1], 10),
    };
  }
  
  // Format 3: "1d100: 9 (Perception 25% = success)" (log format)
  match = roll.match(/(\d+)d(\d+):\s*(\d+)/);
  if (match) {
    const expression = `${match[1]}d${match[2]}`;
    const result = parseInt(match[3], 10);
    console.log(`[DiceAnimation] Matched format 3: expression=${expression}, result=${result}`);
    return {
      expression: expression,
      result: result,
      diceType: `d${match[2]}`,
      numDice: parseInt(match[1], 10),
    };
  }
  
  // Format 4: Extract expression and result separately
  const exprMatch = roll.match(/(\d+)d(\d+)/);
  const resultMatch = roll.match(/(?:->|:|=)\s*(\d+)/);
  if (exprMatch && resultMatch) {
    const expression = `${exprMatch[1]}d${exprMatch[2]}`;
    const result = parseInt(resultMatch[1], 10);
    console.log(`[DiceAnimation] Matched format 4: expression=${expression}, result=${result}`);
    return {
      expression: expression,
      result: result,
      diceType: `d${exprMatch[2]}`,
      numDice: parseInt(exprMatch[1], 10),
    };
  }
  
  // Fallback: try to extract any number as result
  const fallbackMatch = roll.match(/(\d+)$/);
  const fallbackExpr = roll.match(/(\d+)d(\d+)/);
  if (fallbackMatch) {
    const expression = fallbackExpr ? `${fallbackExpr[1]}d${fallbackExpr[2]}` : '1d100';
    const result = parseInt(fallbackMatch[1], 10);
    console.log(`[DiceAnimation] Matched fallback: expression=${expression}, result=${result}`);
    return {
      expression: expression,
      result: result,
      diceType: fallbackExpr ? `d${fallbackExpr[2]}` : 'd100',
      numDice: fallbackExpr ? parseInt(fallbackExpr[1], 10) : 1,
    };
  }
  
  console.warn(`[DiceAnimation] Failed to parse dice roll: "${roll}"`);
  return {
    expression: roll,
    result: 0,
    diceType: 'd100',
    numDice: 1,
  };
}

export function DiceAnimation({ diceRolls, onAnimationComplete }: DiceAnimationProps) {
  const [isAnimating, setIsAnimating] = useState(true);
  const [animationCompleted, setAnimationCompleted] = useState(false);
  const hasStartedAnimation = useRef(false);
  const animationTimerRef = useRef<number | null>(null);
  
  // Parse dice rolls synchronously using useMemo so it's available on first render
  const parsedRolls = useMemo(() => {
    if (!diceRolls || diceRolls.length === 0) {
      return [];
    }
    
    // Parse dice rolls from various formats:
    // - "roll_dice: 1d100 -> 1 = 9" (actual format from tools.ts)
    // - "1d100 -> 45" (simple format)
    // - "1d100: 9 (Perception 25% = success)" (log format)
    const parsed = diceRolls.map(parseDiceRoll);
    
    // Filter out invalid rolls
    const validParsed = parsed.filter(p => p.result > 0);
    console.log(`[DiceAnimation] Parsed ${validParsed.length} valid dice rolls out of ${parsed.length}`);
    return validParsed;
  }, [diceRolls]);

  // Track the diceRolls that have been animated to prevent re-animation
  const animatedDiceRollsRef = useRef<string>('');
  // Track if callback has been called for current dice rolls to prevent duplicate calls
  const callbackCalledRef = useRef<string>('');

  useEffect(() => {
    // If no callback, this is a saved message - show result directly without animation
    if (onAnimationComplete === undefined) {
      setIsAnimating(false);
      setAnimationCompleted(true);
      return;
    }

    // Create a unique key from diceRolls to track if this set has been animated
    const diceRollsKey = JSON.stringify(diceRolls);
    
    // If this set of diceRolls has already been animated, don't animate again
    // Also don't call callback again if it was already called for this set
    if (animatedDiceRollsRef.current === diceRollsKey) {
      setIsAnimating(false);
      setAnimationCompleted(true);
      // Only call callback if it hasn't been called for this dice roll set
      if (onAnimationComplete && callbackCalledRef.current !== diceRollsKey) {
        callbackCalledRef.current = diceRollsKey;
        setTimeout(() => {
          onAnimationComplete();
        }, 100);
      }
      return;
    }

    // Mark this set as animated and reset callback tracking for new set
    animatedDiceRollsRef.current = diceRollsKey;
    callbackCalledRef.current = ''; // Reset callback tracking for new dice rolls
    hasStartedAnimation.current = true;
    setIsAnimating(true);
    setAnimationCompleted(false);

    // Animation duration: 1.5-2 seconds
    const animationDuration = 1800;
    animationTimerRef.current = window.setTimeout(() => {
      setIsAnimating(false);
      setAnimationCompleted(true);
      if (onAnimationComplete && callbackCalledRef.current !== diceRollsKey) {
        // Mark callback as called for this dice roll set
        callbackCalledRef.current = diceRollsKey;
        // Small delay before calling callback to show final result
        setTimeout(() => {
          onAnimationComplete();
        }, 300);
      }
    }, animationDuration);

    return () => {
      if (animationTimerRef.current !== null) {
        clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
  }, [diceRolls, onAnimationComplete]);

  if (parsedRolls.length === 0) {
    console.warn(`[DiceAnimation] No valid dice rolls to display. Original diceRolls:`, diceRolls);
    return null;
  }

  return (
    <div className="dice-animation-container">
      <div className="dice-animation-header">
        <span className="dice-icon">🎲</span>
        <span className="dice-label">Dice Roll</span>
      </div>
      <div className="dice-rolls-container">
        {parsedRolls.map((roll, index) => (
          <div key={index} className="dice-roll-item">
            <div className="dice-expression">{roll.expression}</div>
            <div className={`dice-result ${isAnimating ? 'dice-spinning' : 'dice-final'}`}>
              {isAnimating ? (
                <div className="dice-spinner">
                  <span className="dice-face">⚀</span>
                  <span className="dice-face">⚁</span>
                  <span className="dice-face">⚂</span>
                  <span className="dice-face">⚃</span>
                  <span className="dice-face">⚄</span>
                  <span className="dice-face">⚅</span>
                </div>
              ) : (
                <div className="dice-final-value">{roll.result}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

