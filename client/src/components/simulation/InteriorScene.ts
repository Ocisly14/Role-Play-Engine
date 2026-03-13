import Phaser from "phaser";

export class InteriorScene extends Phaser.Scene {
  private currentSceneId: string | null = null;

  constructor() {
    super({ key: "InteriorScene" });
  }

  init() {
    this.game.events.on("load-interior", this.handleLoadInterior, this);
    this.game.events.on("switch-sub-scene", this.handleSwitchSubScene, this);
    this.game.events.on("exit-building", this.handleExitBuilding, this);
    this.game.events.on(
      "npc-position-update-interior",
      this.handleNpcUpdate,
      this
    );
  }

  create() {
    this.add
      .text(10, 10, "\u2190 Back (click or press Esc)", {
        fontSize: "14px",
        color: "#888",
      })
      .setScrollFactor(0)
      .setDepth(100)
      .setInteractive()
      .on("pointerdown", () => this.handleExitBuilding());

    this.input.keyboard?.on("keydown-ESC", () => this.handleExitBuilding());
  }

  private handleLoadInterior(data: {
    sceneId: string;
    mapUrl: string;
    tilesetUrl: string;
    tilesetKey: string;
  }) {
    this.currentSceneId = data.sceneId;
    this.children.removeAll();
    this.create();

    const mapKey = `interior_${data.sceneId}`;
    this.load.tilemapTiledJSON(mapKey, data.mapUrl);

    if (!this.textures.exists(data.tilesetKey)) {
      this.load.image(data.tilesetKey, data.tilesetUrl);
    }

    this.load.once("complete", () => {
      const map = this.make.tilemap({ key: mapKey });
      const tileset = map.addTilesetImage(
        map.tilesets[0].name,
        data.tilesetKey
      );
      if (!tileset) return;

      for (const name of ["ground", "walls", "furniture"]) {
        const layer = map.createLayer(name, tileset);
        if (layer)
          layer.setDepth(["ground", "walls", "furniture"].indexOf(name));
      }

      this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels);
      this.cameras.main.centerOn(map.widthInPixels / 2, map.heightInPixels / 2);
      this.cameras.main.setZoom(
        Math.min(
          this.scale.width / map.widthInPixels,
          this.scale.height / map.heightInPixels
        ) * 0.9
      );
    });

    this.load.start();
  }

  private handleSwitchSubScene(data: { subSceneId: string }) {
    this.currentSceneId = data.subSceneId;
  }

  private handleExitBuilding() {
    this.currentSceneId = null;
    this.scene.start("TownScene");
    this.game.events.emit("building-exited");
  }

  private handleNpcUpdate(data: {
    npcId: string;
    name: string;
    sceneId: string;
    x: number;
    y: number;
  }) {
    if (data.sceneId !== this.currentSceneId) return;

    const existing = this.children.getByName(
      data.npcId
    ) as Phaser.GameObjects.Arc;
    if (existing) {
      this.tweens.add({
        targets: existing,
        x: data.x,
        y: data.y,
        duration: 300,
      });
    } else {
      const dot = this.add.circle(data.x, data.y, 8, 0x4ecdc4).setDepth(10);
      dot.setName(data.npcId);
      this.add
        .text(data.x, data.y + 12, data.name, {
          fontSize: "10px",
          color: "#fff",
        })
        .setOrigin(0.5, 0)
        .setDepth(11);
    }
  }
}
