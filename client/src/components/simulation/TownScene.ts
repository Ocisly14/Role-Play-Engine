import Phaser from "phaser";

interface ScenarioConfig {
  x: number;
  y: number;
  thumbnail?: string;
}

interface RoadConfig {
  points: [number, number][];
}

interface MapConfig {
  town?: { background?: string };
  scenarios?: Record<string, ScenarioConfig>;
  roads?: Record<string, RoadConfig>;
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

const NODE_WIDTH = 360;
const NODE_HEIGHT = 240;
const NPC_DOT_RADIUS = 8;
const NPC_JITTER = 40;
const ROAD_COLOR = 0xd4a843;
const ROAD_ALPHA = 0.35;
const ROAD_WIDTH = 4;

export class TownScene extends Phaser.Scene {
  private scenarioOutlines: ScenarioOutlineData[] = [];
  private transportEdges: TransportEdgeData[] = [];
  private scenes: SceneData[] = [];
  private junctions: JunctionData[] = [];
  private nodePositions: Map<string, { x: number; y: number }> = new Map();
  private nodeContainers: Map<string, Phaser.GameObjects.Container> = new Map();
  private npcDots: Map<string, NpcDotData> = new Map();
  private colorIndex = 0;
  private configCache: MapConfig | null = null;
  private baseUrl = "";
  private isBuilt = false;
  private mapWidth = 0;
  private mapHeight = 0;
  private minZoom = 0.15;

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
          Phaser.Math.Clamp(cam.zoom + (deltaY > 0 ? -0.05 : 0.05), this.minZoom, 10)
        );
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

    const unpositioned = this.scenarioOutlines.filter(
      (o) => !this.nodePositions.has(o.id)
    );
    if (unpositioned.length > 0) {
      const cx = 400;
      const cy = 300;
      const radius = Math.max(150, unpositioned.length * 40);
      const startAngle = -Math.PI / 2;
      unpositioned.forEach((o, i) => {
        const angle = startAngle + (2 * Math.PI * i) / unpositioned.length;
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

  // ── Build ──────────────────────────────────────────────────────

  private buildGraph() {
    if (this.isBuilt) return;
    this.isBuilt = true;

    // Background map image
    if (this.textures.exists("town_bg")) {
      const bg = this.add.image(0, 0, "town_bg").setOrigin(0, 0).setDepth(-1);
      this.mapWidth = bg.width;
      this.mapHeight = bg.height;
    }

    this.drawRoads();
    this.drawNodes();
    this.fitCamera();
  }

  private drawRoads() {
    const roads = this.configCache?.roads;
    if (!roads) return;

    const gfx = this.add.graphics().setDepth(0);

    for (const road of Object.values(roads)) {
      const pts = road.points;
      if (pts.length < 2) continue;

      // Glow pass
      gfx.lineStyle(ROAD_WIDTH + 4, ROAD_COLOR, ROAD_ALPHA * 0.4);
      gfx.beginPath();
      gfx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        gfx.lineTo(pts[i][0], pts[i][1]);
      }
      gfx.strokePath();

      // Core line
      gfx.lineStyle(ROAD_WIDTH, ROAD_COLOR, ROAD_ALPHA);
      gfx.beginPath();
      gfx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        gfx.lineTo(pts[i][0], pts[i][1]);
      }
      gfx.strokePath();
    }
  }

  private drawNodes() {
    for (const outline of this.scenarioOutlines) {
      const pos = this.nodePositions.get(outline.id);
      if (!pos) continue;

      const container = this.add.container(pos.x, pos.y).setDepth(1);
      const thumbKey = `thumb_${outline.id}`;
      const halfW = NODE_WIDTH / 2;
      const halfH = NODE_HEIGHT / 2;

      // Shadow
      const shadow = this.add.graphics();
      shadow.fillStyle(0x000000, 0.4);
      shadow.fillRoundedRect(-halfW + 6, -halfH + 6, NODE_WIDTH, NODE_HEIGHT, 16);
      container.add(shadow);

      // Card background
      const cardBg = this.add.graphics();
      cardBg.fillStyle(0x1a1a2e, 0.9);
      cardBg.fillRoundedRect(-halfW, -halfH, NODE_WIDTH, NODE_HEIGHT, 16);
      container.add(cardBg);

      // Thumbnail
      if (this.textures.exists(thumbKey)) {
        const thumb = this.add.image(0, 0, thumbKey);
        const scale = Math.max(
          NODE_WIDTH / thumb.width,
          NODE_HEIGHT / thumb.height
        );
        thumb.setScale(scale);

        // Mask to rounded rect
        const maskGfx = this.make.graphics({ x: 0, y: 0 });
        maskGfx.fillStyle(0xffffff);
        maskGfx.fillRoundedRect(
          pos.x - halfW,
          pos.y - halfH,
          NODE_WIDTH,
          NODE_HEIGHT,
          16
        );
        thumb.setMask(maskGfx.createGeometryMask());

        container.add(thumb);
      }

      // Border
      const border = this.add.graphics();
      border.lineStyle(3, 0x6a6a8a, 0.8);
      border.strokeRoundedRect(-halfW, -halfH, NODE_WIDTH, NODE_HEIGHT, 16);
      container.add(border);

      // Hover glow (hidden)
      const hoverGlow = this.add.graphics();
      hoverGlow.lineStyle(5, 0xd4a843, 0.9);
      hoverGlow.strokeRoundedRect(-halfW - 2, -halfH - 2, NODE_WIDTH + 4, NODE_HEIGHT + 4, 18);
      hoverGlow.setAlpha(0);
      container.add(hoverGlow);

      // Label
      const label = this.add
        .text(0, halfH + 12, outline.name, {
          fontSize: "32px",
          color: "#e8dcc8",
          fontFamily: "serif",
          align: "center",
          stroke: "#111118",
          strokeThickness: 6,
        })
        .setOrigin(0.5, 0);
      container.add(label);

      // Interactive
      const hitZone = this.add
        .zone(0, 0, NODE_WIDTH, NODE_HEIGHT)
        .setInteractive({ useHandCursor: true });
      container.add(hitZone);

      hitZone.on("pointerover", () => {
        this.tweens.add({
          targets: container,
          scaleX: 1.12,
          scaleY: 1.12,
          duration: 200,
          ease: "Back.easeOut",
        });
        this.tweens.add({
          targets: hoverGlow,
          alpha: 1,
          duration: 200,
        });
      });
      hitZone.on("pointerout", () => {
        this.tweens.add({
          targets: container,
          scaleX: 1.0,
          scaleY: 1.0,
          duration: 200,
          ease: "Sine.easeOut",
        });
        this.tweens.add({
          targets: hoverGlow,
          alpha: 0,
          duration: 200,
        });
      });
      hitZone.on("pointerdown", () => {
        this.game.events.emit("building-clicked", {
          scenarioId: outline.id,
          entrySceneId: outline.entrySceneId,
        });
      });

      this.nodeContainers.set(outline.id, container);
    }
  }

  private fitCamera() {
    const cam = this.cameras.main;
    if (this.mapWidth > 0 && this.mapHeight > 0) {
      // Use background image bounds
      cam.setBounds(0, 0, this.mapWidth, this.mapHeight);
      cam.centerOn(this.mapWidth / 2, this.mapHeight / 2);
      // minZoom = cover (map always fills viewport, no black edges)
      this.minZoom = Math.max(cam.width / this.mapWidth, cam.height / this.mapHeight);
      // Default zoom = 300% of cover
      cam.setZoom(this.minZoom * 3);
    } else if (this.nodePositions.size > 0) {
      // Fallback to node bounds
      const margin = 150;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const pos of this.nodePositions.values()) {
        minX = Math.min(minX, pos.x);
        minY = Math.min(minY, pos.y);
        maxX = Math.max(maxX, pos.x);
        maxY = Math.max(maxY, pos.y);
      }
      const w = maxX - minX + margin * 2;
      const h = maxY - minY + margin * 2;
      cam.setBounds(minX - margin, minY - margin, w, h);
      cam.centerOn((minX + maxX) / 2, (minY + maxY) / 2);
      cam.setZoom(Math.min(cam.width / w, cam.height / h, 1));
    }
  }

  // ── NPC positions ──────────────────────────────────────────────

  private handleNpcPositionUpdate(data: {
    positions: Record<string, CharacterPosition>;
    npcStatuses: NpcStatusEntry[];
    scenes: SceneData[];
    junctions: JunctionData[];
    transportEdges: TransportEdgeData[];
  }) {
    const sceneToParent = new Map<string, string>();
    for (const s of data.scenes) sceneToParent.set(s.id, s.parentLocationId);

    const junctionMap = new Map<string, JunctionData>();
    for (const j of data.junctions) junctionMap.set(j.id, j);

    const roadToEdge = new Map<string, TransportEdgeData>();
    for (const edge of data.transportEdges)
      roadToEdge.set(edge.streetSceneId, edge);

    const npcNameMap = new Map<string, string>();
    for (const npc of data.npcStatuses) npcNameMap.set(npc.npcId, npc.name);

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
        if (
          Math.abs(existing.currentX - target.x) > 1 ||
          Math.abs(existing.currentY - target.y) > 1
        ) {
          this.tweens.add({
            targets: existing.dot,
            x: target.x,
            y: target.y,
            duration: 400,
            ease: "Sine.easeInOut",
          });
          this.tweens.add({
            targets: existing.label,
            x: target.x,
            y: target.y + NPC_DOT_RADIUS + 4,
            duration: 400,
            ease: "Sine.easeInOut",
          });
          existing.currentX = target.x;
          existing.currentY = target.y;
        }
      } else {
        const color = NPC_COLORS[this.colorIndex % NPC_COLORS.length];
        this.colorIndex++;

        const dot = this.add
          .circle(target.x, target.y, NPC_DOT_RADIUS, color, 0.9)
          .setStrokeStyle(2, 0xffffff, 0.6)
          .setDepth(10);
        const label = this.add
          .text(target.x, target.y + NPC_DOT_RADIUS + 4, name, {
            fontSize: "11px",
            color: "#fff",
            fontFamily: "serif",
            stroke: "#000",
            strokeThickness: 3,
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
