import Phaser from "phaser";

interface NpcSpriteData {
  dot: Phaser.GameObjects.Arc;
  sprite?: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  npcId: string;
  color: number;
}

const ZOOM_SPRITE_THRESHOLD = 0.5;
const NPC_COLORS = [
  0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa29bfe, 0xfd79a8, 0x00b894, 0xe17055,
  0x6c5ce7,
];

export class TownScene extends Phaser.Scene {
  private npcSprites: Map<string, NpcSpriteData> = new Map();
  private mapLoaded = false;
  private junctionCoords: Record<string, { x: number; y: number }> = {};
  private colorIndex = 0;

  constructor() {
    super({ key: "TownScene" });
  }

  init() {
    this.game.events.on("load-town-map", this.handleLoadTownMap, this);
    this.game.events.on(
      "npc-position-update",
      this.handleNpcPositionUpdate,
      this
    );
    this.game.events.on(
      "set-junction-coords",
      this.handleSetJunctionCoords,
      this
    );
    this.game.events.on("zoom-to", this.handleZoomTo, this);
    this.game.events.on("enter-building", this.handleEnterBuilding, this);
  }

  create() {
    this.input.on(
      "wheel",
      (
        _pointer: Phaser.Input.Pointer,
        _gameObjects: Phaser.GameObjects.GameObject[],
        _deltaX: number,
        deltaY: number
      ) => {
        const cam = this.cameras.main;
        const newZoom = Phaser.Math.Clamp(
          cam.zoom + (deltaY > 0 ? -0.1 : 0.1),
          0.1,
          2
        );
        cam.setZoom(newZoom);
        this.updateNpcRenderMode(newZoom);
      }
    );

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) {
        const cam = this.cameras.main;
        cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
        cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
      }
    });
  }

  private handleLoadTownMap(data: {
    mapUrl: string;
    tilesetUrl: string;
    tilesetKey: string;
  }) {
    this.load.tilemapTiledJSON("town", data.mapUrl);
    this.load.image(data.tilesetKey, data.tilesetUrl);
    this.load.once("complete", () => {
      this.createTilemap(data.tilesetKey);
    });
    this.load.start();
  }

  private createTilemap(tilesetKey: string) {
    const map = this.make.tilemap({ key: "town" });
    const tileset = map.addTilesetImage(map.tilesets[0].name, tilesetKey);
    if (!tileset) return;

    const layerNames = ["ground", "roads", "buildings", "decoration"];
    for (const name of layerNames) {
      const layer = map.createLayer(name, tileset);
      if (layer) layer.setDepth(layerNames.indexOf(name));
    }

    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
    this.cameras.main.centerOn(map.widthInPixels / 2, map.heightInPixels / 2);
    this.cameras.main.setZoom(
      Math.min(
        this.scale.width / map.widthInPixels,
        this.scale.height / map.heightInPixels
      )
    );

    const entrancesLayer = map.getObjectLayer("building_entrances");
    if (entrancesLayer) {
      for (const obj of entrancesLayer.objects) {
        const sceneId = (
          obj.properties as Array<{ name: string; value: string }> | undefined
        )?.find((p) => p.name === "sceneId")?.value;
        if (sceneId && obj.x !== undefined && obj.y !== undefined) {
          const zone = this.add
            .zone(obj.x, obj.y, obj.width ?? 32, obj.height ?? 32)
            .setInteractive()
            .setOrigin(0, 0);
          zone.on("pointerdown", () => {
            this.game.events.emit("building-clicked", sceneId);
          });
        }
      }
    }

    this.mapLoaded = true;
  }

  private handleSetJunctionCoords(
    coords: Record<string, { x: number; y: number }>
  ) {
    this.junctionCoords = coords;
  }

  private handleNpcPositionUpdate(data: {
    npcId: string;
    name: string;
    position: {
      type: string;
      junctionId?: string;
      roadId?: string;
      position?: number;
      sceneId?: string;
    };
    roads?: Array<{ id: string; endpointA: string; endpointB: string }>;
  }) {
    const pixelPos = this.resolvePixelPosition(data.position, data.roads);
    if (!pixelPos) return;

    let npcData = this.npcSprites.get(data.npcId);
    if (!npcData) {
      const color = NPC_COLORS[this.colorIndex % NPC_COLORS.length];
      this.colorIndex++;

      const dot = this.add
        .circle(pixelPos.x, pixelPos.y, 6, color)
        .setDepth(10);
      const label = this.add
        .text(pixelPos.x, pixelPos.y + 10, data.name, {
          fontSize: "10px",
          color: "#ffffff",
          backgroundColor: "rgba(0,0,0,0.5)",
          padding: { x: 2, y: 1 },
        })
        .setOrigin(0.5, 0)
        .setDepth(11);

      dot.setInteractive();
      dot.on("pointerdown", () => {
        this.game.events.emit("npc-clicked", data.npcId);
      });

      npcData = { dot, label, npcId: data.npcId, color };
      this.npcSprites.set(data.npcId, npcData);
    }

    this.tweens.add({
      targets: [npcData.dot, npcData.label],
      x: pixelPos.x,
      y: (target: Phaser.GameObjects.GameObject) =>
        target === npcData!.label ? pixelPos.y + 10 : pixelPos.y,
      duration: 500,
      ease: "Power2",
    });
  }

  private resolvePixelPosition(
    position: {
      type: string;
      junctionId?: string;
      roadId?: string;
      position?: number;
      sceneId?: string;
    },
    roads?: Array<{ id: string; endpointA: string; endpointB: string }>
  ): { x: number; y: number } | null {
    switch (position.type) {
      case "junction": {
        const coords = this.junctionCoords[position.junctionId!];
        return coords ?? null;
      }
      case "road": {
        const road = roads?.find((r) => r.id === position.roadId);
        if (!road) return null;
        const a = this.junctionCoords[road.endpointA];
        const b = this.junctionCoords[road.endpointB];
        if (!a || !b) return null;
        const t = position.position ?? 0.5;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      case "scene":
        return null;
      default:
        return null;
    }
  }

  private handleZoomTo(data: { x: number; y: number; zoom: number }) {
    this.cameras.main.pan(data.x, data.y, 500, "Power2");
    this.cameras.main.zoomTo(data.zoom, 500);
  }

  private handleEnterBuilding(_data: { sceneId: string }) {
    this.scene.start("InteriorScene");
  }

  private updateNpcRenderMode(zoom: number) {
    const useSprites = zoom >= ZOOM_SPRITE_THRESHOLD;
    this.game.events.emit("zoom-level-changed", useSprites ? 2 : 1);
  }
}
