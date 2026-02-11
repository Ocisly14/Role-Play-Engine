/**
 * Hook for managing scene transition overlay
 */

import { useState, useRef, useCallback, useEffect } from "react";

export interface UseSceneTransitionResult {
  isSceneChanging: boolean;
  setIsSceneChanging: (changing: boolean) => void;
  clearSceneChanging: () => void;
}

export function useSceneTransition(): UseSceneTransitionResult {
  const [isSceneChanging, setIsSceneChanging] = useState(false);
  const sceneChangeTimeoutRef = useRef<number | null>(null);

  const clearSceneChanging = useCallback(() => {
    setIsSceneChanging(false);
    if (sceneChangeTimeoutRef.current !== null) {
      clearTimeout(sceneChangeTimeoutRef.current);
      sceneChangeTimeoutRef.current = null;
    }
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (sceneChangeTimeoutRef.current !== null) {
        clearTimeout(sceneChangeTimeoutRef.current);
      }
    };
  }, []);

  return {
    isSceneChanging,
    setIsSceneChanging,
    clearSceneChanging,
  };
}
