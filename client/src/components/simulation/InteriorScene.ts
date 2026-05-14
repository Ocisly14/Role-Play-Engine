import Phaser from "phaser";

interface NpcArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface InteriorNpcData {
  dot: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
}

interface SceneConfig {
  background: string;
  npcAreas: Array<{ x: number; y: number; width: number; height: number }>;
}

interface MapConfig {
  scenes: Record<string, SceneConfig>;
}

const NPC_COLORS = [
  0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa29bfe, 0xfd79a8, 0x00b894, 0xe17055,
  0x6c5ce7,
];

export class InteriorScene extends Phaser.Scene {
  private currentSceneId: string | null = null;
  private npcAreas: NpcArea[] = [];
  private npcSprites: Map<string, InteriorNpcData> = new Map();
  private colorIndex = 0;
  private configCache: MapConfig | null = null;
  private baseUrl = "";

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
    this.addBackButton();
    this.input.keyboard?.on("keydown-ESC", () => this.handleExitBuilding());

    // Boot once in the background so global game events can target this scene
    // before the first user-driven scene switch.
    if (!this.currentSceneId) {
      this.scene.sleep();
    }
  }

  private addBackButton() {
    this.add
      .text(10, 10, "\u2190 Back (click or press Esc)", {
        fontSize: "14px",
        color: "#888",
      })
      .setScrollFactor(0)
      .setDepth(100)
      .setInteractive()
      .on("pointerdown", () => this.handleExitBuilding());
  }

  private handleLoadInterior(data: {
    sceneId: string;
    configUrl: string;
    baseUrl: string;
  }) {
    this.currentSceneId = data.sceneId;
    this.baseUrl = data.baseUrl;
    this.children.removeAll();
    this.npcSprites.clear();
    this.npcAreas = [];
    this.colorIndex = 0;

    this.addBackButton();
    this.input.keyboard?.on("keydown-ESC", () => this.handleExitBuilding());

    if (this.configCache) {
      this.loadScene(data.sceneId);
      return;
    }

    fetch(data.configUrl)
      .then((res) => res.json())
      .then((config: MapConfig) => {
        this.configCache = config;
        this.loadScene(data.sceneId);
      });
  }

  private loadScene(sceneId: string) {
    const scene = this.configCache?.scenes?.[sceneId];
    if (!scene) return;

    const bgKey = `interior_bg_${sceneId}`;
    if (scene.background) {
      const bgUrl = `${this.baseUrl}${scene.background}`;
      if (!this.textures.exists(bgKey)) {
        this.load.image(bgKey, bgUrl);
      }
      this.load.once("complete", () => this.buildScene(scene, bgKey));
      this.load.start();
    } else {
      this.buildScene(scene, null);
    }
  }

  private buildScene(scene: SceneConfig, bgKey: string | null) {
    let w = 800;
    let h = 600;

    if (bgKey && this.textures.exists(bgKey)) {
      const bg = this.add.image(0, 0, bgKey).setOrigin(0, 0).setDepth(0);
      w = bg.width;
      h = bg.height;
    }

    for (const a of scene.npcAreas) {
      this.npcAreas.push({ x: a.x, y: a.y, width: a.width, height: a.height });
    }

    this.cameras.main.setBounds(0, 0, w, h);
    this.cameras.main.centerOn(w / 2, h / 2);
    this.cameras.main.setZoom(
      Math.min(this.scale.width / w, this.scale.height / h) * 0.9
    );
  }

  private handleSwitchSubScene(data: {
    subSceneId: string;
    configUrl: string;
    baseUrl: string;
  }) {
    this.handleLoadInterior({
      sceneId: data.subSceneId,
      configUrl: data.configUrl,
      baseUrl: data.baseUrl,
    });
  }

  private handleExitBuilding() {
    this.currentSceneId = null;
    this.npcSprites.clear();
    this.npcAreas = [];
    this.scene.switch("TownScene");
    this.game.events.emit("building-exited");
  }

  private handleNpcUpdate(data: {
    npcId: string;
    name: string;
    sceneId: string;
  }) {
    if (data.sceneId !== this.currentSceneId) return;
    if (this.npcSprites.has(data.npcId)) return;

    const pos = this.pickRandomPos();
    const color = NPC_COLORS[this.colorIndex % NPC_COLORS.length];
    this.colorIndex++;

    const dot = this.add.circle(pos.x, pos.y, 8, color).setDepth(10);
    dot.setName(data.npcId);

    const label = this.add
      .text(pos.x, pos.y + 12, data.name, {
        fontSize: "10px",
        color: "#fff",
        backgroundColor: "rgba(0,0,0,0.5)",
        padding: { x: 2, y: 1 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11);

    this.npcSprites.set(data.npcId, { dot, label });
  }

  private pickRandomPos(): { x: number; y: number } {
    if (this.npcAreas.length === 0) {
      const cam = this.cameras.main;
      return {
        x: cam.scrollX + cam.width / 2 + (Math.random() - 0.5) * 100,
        y: cam.scrollY + cam.height / 2 + (Math.random() - 0.5) * 100,
      };
    }
    const a = this.npcAreas[Math.floor(Math.random() * this.npcAreas.length)];
    return {
      x: a.x + Math.random() * a.width,
      y: a.y + Math.random() * a.height,
    };
  }
}
