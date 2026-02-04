/**
 * DiceAnimation Component - Displays animated dice rolls
 *
 * Shows character, skill, penalty, and dice result.
 */

import { useState, useEffect, useMemo, useRef } from 'react';

/** Structured dice roll info (matches backend DiceRollInfo) */
export interface DiceRollInfo {
  character: string;
  roll: string;
  skill?: string;
  success?: 'success' | 'failure' | 'critical' | 'fumble';
  penalty?: string;
}

interface DiceAnimationProps {
  /** Dice rolls: structured (DiceRollInfo[]) or legacy (string[]) */
  diceRolls: DiceRollInfo[] | string[];
  onAnimationComplete?: () => void;
}

interface ParsedDiceRoll {
  expression: string;
  result: number;
  diceType: string;
  numDice: number;
  character: string;
  skill?: string;
  success?: string;
  penalty?: string;
}

/** Psychology check: do not display dice result (Keeper secret) */
function isPsychologyRoll(info: DiceRollInfo): boolean {
  const skill = (info.skill ?? '').toLowerCase();
  const roll = (info.roll ?? '').toLowerCase();
  return (
    skill.includes('psychology') ||
    skill.includes('心理学') ||
    roll.includes('psychology') ||
    roll.includes('心理学')
  );
}

/** Normalize input to DiceRollInfo[] */
function normalizeDiceRolls(input: DiceRollInfo[] | string[]): DiceRollInfo[] {
  if (!input?.length) return [];
  const first = input[0];
  if (typeof first === 'string') {
    return (input as string[]).map((roll) => ({ character: '', roll }));
  }
  return input as DiceRollInfo[];
}

/** Parse expression and result from roll string */
function parseDiceRoll(roll: string): { expression: string; result: number; diceType: string; numDice: number } {
  let match = roll.match(/roll_dice:\s*(\d+)d(\d+)\s*->\s*(?:[\d+\s=]+\s*=\s*)?(\d+)/);
  if (match) {
    return {
      expression: `${match[1]}d${match[2]}`,
      result: parseInt(match[3], 10),
      diceType: `d${match[2]}`,
      numDice: parseInt(match[1], 10),
    };
  }
  match = roll.match(/^(\d+)d(\d+)\s*->\s*(\d+)$/);
  if (match) {
    return {
      expression: `${match[1]}d${match[2]}`,
      result: parseInt(match[3], 10),
      diceType: `d${match[2]}`,
      numDice: parseInt(match[1], 10),
    };
  }
  match = roll.match(/(\d+)d(\d+)(?:\[\d+\])?:\s*(\d+)/);
  if (match) {
    return {
      expression: `${match[1]}d${match[2]}`,
      result: parseInt(match[3], 10),
      diceType: `d${match[2]}`,
      numDice: parseInt(match[1], 10),
    };
  }
  const exprMatch = roll.match(/(\d+)d(\d+)/);
  const resultMatch = roll.match(/(?:->|:|=)\s*(\d+)/);
  if (exprMatch && resultMatch) {
    return {
      expression: `${exprMatch[1]}d${exprMatch[2]}`,
      result: parseInt(resultMatch[1], 10),
      diceType: `d${exprMatch[2]}`,
      numDice: parseInt(exprMatch[1], 10),
    };
  }
  const fallbackMatch = roll.match(/(\d+)$/);
  const fallbackExpr = roll.match(/(\d+)d(\d+)/);
  if (fallbackMatch) {
    return {
      expression: fallbackExpr ? `${fallbackExpr[1]}d${fallbackExpr[2]}` : '1d100',
      result: parseInt(fallbackMatch[1], 10),
      diceType: fallbackExpr ? `d${fallbackExpr[2]}` : 'd100',
      numDice: fallbackExpr ? parseInt(fallbackExpr[1], 10) : 1,
    };
  }
  return { expression: roll, result: 0, diceType: 'd100', numDice: 1 };
}

export function DiceAnimation({ diceRolls, onAnimationComplete }: DiceAnimationProps) {
  const [isAnimating, setIsAnimating] = useState(true);
  const [animationCompleted, setAnimationCompleted] = useState(false);
  const animationTimerRef = useRef<number | null>(null);

  const normalized = useMemo(() => normalizeDiceRolls(diceRolls), [diceRolls]);

  const parsedRolls = useMemo((): ParsedDiceRoll[] => {
    if (!normalized.length) return [];
    return normalized
      .filter((info) => !isPsychologyRoll(info))
      .map((info) => {
        const parsed = parseDiceRoll(info.roll);
        return {
          ...parsed,
          character: info.character || '',
          skill: info.skill,
          success: info.success,
          penalty: info.penalty,
        };
      })
      .filter((p) => p.result > 0);
  }, [normalized]);

  const animatedDiceRollsRef = useRef<string>('');
  const callbackCalledRef = useRef<string>('');

  useEffect(() => {
    if (onAnimationComplete === undefined) {
      setIsAnimating(false);
      setAnimationCompleted(true);
      return;
    }

    const diceRollsKey = JSON.stringify(diceRolls);

    if (animatedDiceRollsRef.current === diceRollsKey) {
      setIsAnimating(false);
      setAnimationCompleted(true);
      if (onAnimationComplete && callbackCalledRef.current !== diceRollsKey) {
        callbackCalledRef.current = diceRollsKey;
        setTimeout(() => onAnimationComplete(), 100);
      }
      return;
    }

    animatedDiceRollsRef.current = diceRollsKey;
    callbackCalledRef.current = '';
    setIsAnimating(true);
    setAnimationCompleted(false);

    const animationDuration = 1800;
    animationTimerRef.current = window.setTimeout(() => {
      setIsAnimating(false);
      setAnimationCompleted(true);
      if (onAnimationComplete && callbackCalledRef.current !== diceRollsKey) {
        callbackCalledRef.current = diceRollsKey;
        setTimeout(() => onAnimationComplete(), 300);
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
            <div className="dice-roll-meta">
              {roll.character && (
                <span className="dice-roll-character">{roll.character}</span>
              )}
              {roll.skill && (
                <span className="dice-roll-skill">{roll.skill}</span>
              )}
              {roll.penalty && (
                <span className="dice-roll-penalty">{roll.penalty}</span>
              )}
              {roll.success && (
                <span className={`dice-roll-success dice-roll-success--${roll.success}`}>
                  {roll.success}
                </span>
              )}
            </div>
            <div className="dice-roll-values">
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
          </div>
        ))}
      </div>
    </div>
  );
}
