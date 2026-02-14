/**
 * Hook for managing scene transition overlay
 */

import { useState, useRef, useCallback, useEffect } from "react";

export type SceneTransitionKind = "scene" | "worldline";

export interface UseSceneTransitionResult {
  isSceneChanging: boolean;
  sceneChangingTextKey: "sceneTransition" | "worldlineTransition";
  startSceneChanging: (kind: SceneTransitionKind) => void;
  clearSceneChanging: (kind?: SceneTransitionKind | "fallback") => void;
}

export function useSceneTransition(): UseSceneTransitionResult {
  const [activeTransitions, setActiveTransitions] = useState<{
    scene: boolean;
    worldline: boolean;
  }>({
    scene: false,
    worldline: false,
  });
  const sceneChangeTimeoutRef = useRef<number | null>(null);

  const startSceneChanging = useCallback((kind: SceneTransitionKind) => {
    setActiveTransitions((prev) => ({ ...prev, [kind]: true }));
  }, []);

  const clearSceneChanging = useCallback((kind: SceneTransitionKind | "fallback" = "scene") => {
    setActiveTransitions((prev) => {
      if (kind === "fallback") {
        return { ...prev, scene: false };
      }
      return { ...prev, [kind]: false };
    });
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
    isSceneChanging: activeTransitions.scene || activeTransitions.worldline,
    sceneChangingTextKey: activeTransitions.worldline
      ? "worldlineTransition"
      : "sceneTransition",
    startSceneChanging,
    clearSceneChanging,
  };
}
