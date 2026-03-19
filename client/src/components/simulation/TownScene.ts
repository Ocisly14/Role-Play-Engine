import Phaser from "phaser";

interface ScenarioConfig {
  x: number;
  y: number;
  thumbnail?: string;
}

interface MapConfig {
  town?: { background?: string };
  scenarios?: Record<string, ScenarioConfig>;
}

interface ScenarioOutlineData {
  id: string;
  name: string;
  entrySceneId?: string;
  residents?: string[];
  subSceneCount: number;
}

interface TransportEdgeData {
  fromLocationId: string;
  toLocationId: string;
  streetSceneId: string;
  travelTimeMinutes: number;
}

interface SceneData {
  id: string;
  name: string;
  parentLocationId: string;
}

interface JunctionData {
  id: string;
  name: string;
  connectedSceneIds: string[];
}

type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }
  | { type: "scene"; sceneId: string };

interface NpcStatusEntry {
  npcId: string;
  name: string;
}

interface NpcDotData {
  dot: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  currentX: number;
  currentY: number;
}

const NPC_COLORS = [
  0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa29bfe, 0xfd79a8, 0x00b894, 0xe17055,
  0x6c5ce7,
];

const NODE_WIDTH = 120;
const NODE_HEIGHT = 80;
const EDGE_COLOR = 0x888888;
const EDGE_WIDTH = 2;
const NPC_DOT_RADIUS = 6;
const NPC_JITTER = 30;

export class TownScene extends Phaser.Scene {
  private scenarioOutlines: ScenarioOutlineData[] = [];
  private transportEdges: TransportEdgeData[] = [];
  private scenes: SceneData[] = [];
  private junctions: JunctionData[] = [];
  private nodePositions: Map<string, { x: number; y: number }> = new Map();
  private nodeContainers: Map<string, Phaser.GameObjects.Container> = new Map();
  private npcDots: Map<string, NpcDotData> = new Map();
  private edgeGraphics: Phaser.GameObjects.Graphics | null = null;
  private colorIndex = 0;
  private configCache: MapConfig | null = null;
  private baseUrl = "";
  private isBuilt = false;

  constructor() {
    super({ key: "TownScene" });
  }

  init() {
    this.game.events.on("load-town-map", this.handleLoadTownMap, this);
    this.game.events.on(
      "npc-position-update-town",
      this.handleNpcPositionUpdate,
      this
    );
    this.game.events.on("zoom-to", this.handleZoomTo, this);
  }

  create() {
    // Scroll zoom
    this.input.on(
      "wheel",
      (
        _pointer: Phaser.Input.Pointer,
        _gameObjects: Phaser.GameObjects.GameObject[],
        _deltaX: number,
        deltaY: number
      ) => {
        const cam = this.cameras.main;
        cam.setZoom(
          Phaser.Math.Clamp(cam.zoom + (deltaY > 0 ? -0.1 : 0.1), 0.3, 3)
        );
      }
    );

    // Drag pan
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (pointer.isDown) {
        const cam = this.cameras.main;
        cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
        cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
      }
    });
  }

  private handleLoadTownMap(data: {
    configUrl: string;
    baseUrl: string;
    scenarioOutlines: ScenarioOutlineData[];
    transportEdges: TransportEdgeData[];
    scenes: SceneData[];
    junctions: JunctionData[];
  }) {
    this.scenarioOutlines = data.scenarioOutlines ?? [];
    this.transportEdges = data.transportEdges ?? [];
    this.scenes = data.scenes ?? [];
    this.junctions = data.junctions ?? [];
    this.baseUrl = data.baseUrl;

    if (this.isBuilt) return;

    fetch(data.configUrl)
      .then((res) => res.json())
      .then((config: MapConfig) => {
        this.configCache = config;
        this.computeNodePositions();
        this.loadThumbnails();
      })
      .catch(() => {
        this.configCache = {};
        this.computeNodePositions();
        this.buildGraph();
      });
  }

  private computeNodePositions() {
    const scenarios = this.configCache?.scenarios;
    if (scenarios) {
      for (const outline of this.scenarioOutlines) {
        const cfg = scenarios[outline.id];
        if (cfg) {
          this.nodePositions.set(outline.id, { x: cfg.x, y: cfg.y });
        }
      }
    }

    // Auto-layout for scenarios without config
    const unpositioned = this.scenarioOutlines.filter(
      (o) => !this.nodePositions.has(o.id)
    );
    if (unpositioned.length > 0) {
      const cx = 400;
      const cy = 300;
      const radius = Math.max(150, unpositioned.length * 40);
      const startAngle = -Math.PI / 2;
      unpositioned.forEach((o, i) => {
        const angle =
          startAngle + (2 * Math.PI * i) / unpositioned.length;
        this.nodePositions.set(o.id, {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        });
      });
    }
  }

  private async loadThumbnails() {
    const scenarios = this.configCache?.scenarios;
    const loadPromises: Promise<void>[] = [];

    for (const outline of this.scenarioOutlines) {
      const cfg = scenarios?.[outline.id];
      const thumbFile = cfg?.thumbnail;
      if (thumbFile && !this.textures.exists(`thumb_${outline.id}`)) {
        loadPromises.push(
          this.fetchAndAddTexture(
            `thumb_${outline.id}`,
            `${this.baseUrl}${thumbFile}`
          )
        );
      }
    }

    if (
      this.configCache?.town?.background &&
      !this.textures.exists("town_bg")
    ) {
      loadPromises.push(
        this.fetchAndAddTexture(
          "town_bg",
          `${this.baseUrl}${this.configCache.town.background}`
        )
      );
    }

    await Promise.allSettled(loadPromises);
    this.buildGraph();
  }

  private fetchAndAddTexture(key: string, url: string): Promise<void> {
    return fetch(url)
      .then((res) => res.blob())
      .then(
        (blob) =>
          new Promise<void>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              if (!this.textures.exists(key)) {
                this.textures.addImage(key, img);
              }
              URL.revokeObjectURL(img.src);
              resolve();
            };
            img.onerror = () => {
              URL.revokeObjectURL(img.src);
              reject(new Error(`Failed to decode ${url}`));
            };
            img.src = URL.createObjectURL(blob);
          })
      )
      .catch((err) => {
        console.warn(`[TownScene] Skip texture ${key}:`, err.message);
      });
  }

  private buildGraph() {
    if (this.isBuilt) return;
    this.isBuilt = true;

    // Optional background
    if (this.textures.exists("town_bg")) {
      this.add.image(0, 0, "town_bg").setOrigin(0, 0).setDepth(-1);
    }

    // Draw edges
    this.edgeGraphics = this.add.graphics().setDepth(0);
    this.edgeGraphics.lineStyle(EDGE_WIDTH, EDGE_COLOR, 0.6);

    for (const edge of this.transportEdges) {
      const fromPos = this.nodePositions.get(edge.fromLocationId);
      const toPos = this.nodePositions.get(edge.toLocationId);
      if (fromPos && toPos) {
        this.edgeGraphics.beginPath();
        this.edgeGraphics.moveTo(fromPos.x, fromPos.y);
        this.edgeGraphics.lineTo(toPos.x, toPos.y);
        this.edgeGraphics.strokePath();
      }
    }

    // Draw nodes
    for (const outline of this.scenarioOutlines) {
      const pos = this.nodePositions.get(outline.id);
      if (!pos) continue;

      const container = this.add.container(pos.x, pos.y).setDepth(1);
      const thumbKey = `thumb_${outline.id}`;

      // Background rect
      const bg = this.add
        .rectangle(0, 0, NODE_WIDTH, NODE_HEIGHT, 0x2a2a3e)
        .setStrokeStyle(2, 0x5566aa);
      container.add(bg);

      // Thumbnail image
      if (this.textures.exists(thumbKey)) {
        const thumb = this.add.image(0, 0, thumbKey);
        const scale = Math.min(
          NODE_WIDTH / thumb.width,
          NODE_HEIGHT / thumb.height
        );
        thumb.setScale(scale);
        container.add(thumb);
      }

      // Label
      const label = this.add
        .text(0, NODE_HEIGHT / 2 + 8, outline.name, {
          fontSize: "11px",
          color: "#ddd",
          fontFamily: "Arial",
          align: "center",
          backgroundColor: "rgba(0,0,0,0.6)",
          padding: { x: 4, y: 2 },
        })
        .setOrigin(0.5, 0);
      container.add(label);

      // Make interactive
      bg.setInteractive({ useHandCursor: true });
      bg.on("pointerover", () => {
        this.tweens.add({
          targets: container,
          scaleX: 1.1,
          scaleY: 1.1,
          duration: 150,
          ease: "Power2",
        });
      });
      bg.on("pointerout", () => {
        this.tweens.add({
          targets: container,
          scaleX: 1.0,
          scaleY: 1.0,
          duration: 150,
          ease: "Power2",
        });
      });
      bg.on("pointerdown", () => {
        this.game.events.emit("building-clicked", {
          scenarioId: outline.id,
          entrySceneId: outline.entrySceneId,
        });
      });

      this.nodeContainers.set(outline.id, container);
    }

    // Set camera bounds
    this.fitCamera();
  }

  private fitCamera() {
    if (this.nodePositions.size === 0) return;
    const margin = 150;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pos of this.nodePositions.values()) {
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x);
      maxY = Math.max(maxY, pos.y);
    }
    const w = maxX - minX + margin * 2;
    const h = maxY - minY + margin * 2;
    const cam = this.cameras.main;
    cam.setBounds(minX - margin, minY - margin, w, h);
    cam.centerOn((minX + maxX) / 2, (minY + maxY) / 2);
    cam.setZoom(Math.min(cam.width / w, cam.height / h, 1));
  }

  private handleNpcPositionUpdate(data: {
    positions: Record<string, CharacterPosition>;
    npcStatuses: NpcStatusEntry[];
    scenes: SceneData[];
    junctions: JunctionData[];
    transportEdges: TransportEdgeData[];
  }) {
    // Build lookup maps
    const sceneToParent = new Map<string, string>();
    for (const s of data.scenes) {
      sceneToParent.set(s.id, s.parentLocationId);
    }

    const junctionMap = new Map<string, JunctionData>();
    for (const j of data.junctions) {
      junctionMap.set(j.id, j);
    }

    // Build roadId → transportEdge lookup (by streetSceneId matching roadId pattern)
    const roadToEdge = new Map<string, TransportEdgeData>();
    for (const edge of data.transportEdges) {
      roadToEdge.set(edge.streetSceneId, edge);
    }

    const npcNameMap = new Map<string, string>();
    for (const npc of data.npcStatuses) {
      npcNameMap.set(npc.npcId, npc.name);
    }

    // Track which NPCs are still present
    const activeNpcIds = new Set<string>();

    for (const [npcId, position] of Object.entries(data.positions)) {
      activeNpcIds.add(npcId);
      const name = npcNameMap.get(npcId) ?? npcId;
      const target = this.resolveNpcPosition(
        position,
        sceneToParent,
        junctionMap,
        roadToEdge
      );
      if (!target) continue;

      const existing = this.npcDots.get(npcId);
      if (existing) {
        // Animate to new position
        if (
          Math.abs(existing.currentX - target.x) > 1 ||
          Math.abs(existing.currentY - target.y) > 1
        ) {
          this.tweens.add({
            targets: [existing.dot, existing.label],
            x: (current: number, _key: string, _target: unknown, targetObj: Phaser.GameObjects.Arc | Phaser.GameObjects.Text) =>
              targetObj === existing.dot ? target.x : target.x,
            y: (current: number, _key: string, _target: unknown, targetObj: Phaser.GameObjects.Arc | Phaser.GameObjects.Text) =>
              targetObj === existing.dot ? target.y : target.y + NPC_DOT_RADIUS + 4,
            duration: 300,
            ease: "Power2",
          });
          existing.currentX = target.x;
          existing.currentY = target.y;
        }
      } else {
        // Create new NPC dot
        const color = NPC_COLORS[this.colorIndex % NPC_COLORS.length];
        this.colorIndex++;

        const dot = this.add
          .circle(target.x, target.y, NPC_DOT_RADIUS, color)
          .setDepth(10);
        const label = this.add
          .text(target.x, target.y + NPC_DOT_RADIUS + 4, name, {
            fontSize: "9px",
            color: "#fff",
            backgroundColor: "rgba(0,0,0,0.6)",
            padding: { x: 2, y: 1 },
          })
          .setOrigin(0.5, 0)
          .setDepth(11);

        this.npcDots.set(npcId, {
          dot,
          label,
          currentX: target.x,
          currentY: target.y,
        });
      }
    }

    // Remove dots for NPCs no longer present
    for (const [npcId, npcData] of this.npcDots) {
      if (!activeNpcIds.has(npcId)) {
        npcData.dot.destroy();
        npcData.label.destroy();
        this.npcDots.delete(npcId);
      }
    }
  }

  private resolveNpcPosition(
    position: CharacterPosition,
    sceneToParent: Map<string, string>,
    junctionMap: Map<string, JunctionData>,
    roadToEdge: Map<string, TransportEdgeData>
  ): { x: number; y: number } | null {
    switch (position.type) {
      case "scene": {
        const parentId = sceneToParent.get(position.sceneId);
        if (!parentId) return null;
        const nodePos = this.nodePositions.get(parentId);
        if (!nodePos) return null;
        return {
          x: nodePos.x + (Math.random() - 0.5) * NPC_JITTER,
          y: nodePos.y + (Math.random() - 0.5) * NPC_JITTER,
        };
      }
      case "road": {
        // Find transportEdge whose streetSceneId matches roadId
        const edge = roadToEdge.get(position.roadId);
        if (edge) {
          const fromPos = this.nodePositions.get(edge.fromLocationId);
          const toPos = this.nodePositions.get(edge.toLocationId);
          if (fromPos && toPos) {
            return {
              x: Phaser.Math.Linear(fromPos.x, toPos.x, position.position),
              y: Phaser.Math.Linear(fromPos.y, toPos.y, position.position),
            };
          }
        }
        return null;
      }
      case "junction": {
        const junction = junctionMap.get(position.junctionId);
        if (!junction || junction.connectedSceneIds.length === 0) return null;
        const firstSceneId = junction.connectedSceneIds[0];
        const parentId = sceneToParent.get(firstSceneId);
        if (!parentId) return null;
        const nodePos = this.nodePositions.get(parentId);
        if (!nodePos) return null;
        return {
          x: nodePos.x + (Math.random() - 0.5) * NPC_JITTER,
          y: nodePos.y + (Math.random() - 0.5) * NPC_JITTER,
        };
      }
    }
  }

  private handleZoomTo(data: { x: number; y: number; zoom: number }) {
    this.cameras.main.pan(data.x, data.y, 500, "Power2");
    this.cameras.main.zoomTo(data.zoom, 500);
  }
}
