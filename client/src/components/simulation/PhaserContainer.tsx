import Phaser from "phaser";
import { useEffect, useRef } from "react";
import { InteriorScene } from "./InteriorScene";
import { TownScene } from "./TownScene";

interface PhaserContainerProps {
  onGameReady: (game: Phaser.Game) => void;
  moduleName: string;
}

export function PhaserContainer({
  onGameReady,
  moduleName,
}: PhaserContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);

  useEffect(() => {
    if (!containerRef.current || gameRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
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
    });

    gameRef.current = game;
    onGameReady(game);

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, [onGameReady, moduleName]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{}}
    />
  );
}
