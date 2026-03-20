import Phaser from "phaser";
import { useEffect, useRef } from "react";
import { InteriorScene } from "./InteriorScene";
import { TownScene } from "./TownScene";

interface PhaserContainerProps {
  onGameReady: (game: Phaser.Game) => void;
  sessionKey: string;
}

export function PhaserContainer({
  onGameReady,
  sessionKey,
}: PhaserContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: containerRef.current.clientWidth || window.innerWidth,
      height: containerRef.current.clientHeight || window.innerHeight,
      backgroundColor: "#111118",
      scene: [TownScene, InteriorScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      render: {
        pixelArt: false,
        antialias: true,
      },
      // This viewer does not use sound. Disabling audio avoids StrictMode
      // teardown races where Phaser tries to resume/suspend a closed context.
      audio: {
        noAudio: true,
      },
    });

    gameRef.current = game;
    game.events.once("ready", () => onGameReady(game));

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, [onGameReady, sessionKey]);

  return (
    <div
      ref={containerRef}
      style={{ position: "fixed", top: 0, left: 0, width: "100%", height: "100%" }}
    />
  );
}
