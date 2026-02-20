/**
 * Hook for managing input area collapse/expand behavior
 */

import { useEffect, useRef, useState } from "react";

export interface UseInputCollapseParams {
  inputValue: string;
}

export interface UseInputCollapseResult {
  isInputCollapsed: boolean;
  setIsInputCollapsed: (collapsed: boolean) => void;
  handleInputAreaMouseEnter: () => void;
  handleInputAreaMouseLeave: () => void;
}

export function useInputCollapse({
  inputValue,
}: UseInputCollapseParams): UseInputCollapseResult {
  const [isInputCollapsed, setIsInputCollapsed] = useState(true);
  const collapseTimeoutRef = useRef<number | null>(null);

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

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (collapseTimeoutRef.current) {
        clearTimeout(collapseTimeoutRef.current);
      }
    };
  }, []);

  return {
    isInputCollapsed,
    setIsInputCollapsed,
    handleInputAreaMouseEnter,
    handleInputAreaMouseLeave,
  };
}
