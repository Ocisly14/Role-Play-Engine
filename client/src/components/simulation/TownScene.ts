import Phaser from "phaser";

interface ScenarioConfig {
  x: number;
  y: number;
  thumbnail?: string;
}

interface RoadConfig {
  roadId?: string;
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
  currentAction?: string | null;
}

interface NpcDotData {
  dot: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  /** Local x/y offset relative to parent container (or world coords for road NPCs). */
  currentX: number;
  currentY: number;
  /** Which building container this dot belongs to, or null for road NPCs. */
  buildingId: string | null;
  /** Action bubble — dark tooltip showing current action. */
  bubbleBg: Phaser.GameObjects.Graphics | null;
  bubbleText: Phaser.GameObjects.Text | null;
}

const NPC_COLORS = [
  0xff6b6b, 0x4ecdc4, 0xffe66d, 0xa29bfe, 0xfd79a8, 0x00b894, 0xe17055,
  0x6c5ce7,
];

const NODE_WIDTH = 360;
const NODE_HEIGHT = 240;
const NPC_DOT_RADIUS = 8;
const ROAD_COLOR = 0xd4a843;
const ROAD_ALPHA = 0.35;
const ROAD_WIDTH = 4;
const BUBBLE_ARROW_H = 8;
const BUBBLE_LABEL_GAP = 32;
export class TownScene extends Phaser.Scene {
  private scenarioOutlines: ScenarioOutlineData[] = [];
  private nodePositions: Map<string, { x: number; y: number }> = new Map();
  private nodeContainers: Map<string, Phaser.GameObjects.Container> = new Map();
  private npcDots: Map<string, NpcDotData> = new Map();
  private colorIndex = 0;
  private configCache: MapConfig | null = null;
  private roadPolylines: Map<string, [number, number][]> = new Map();
  private baseUrl = "";
  private isBuilt = false;
  /** Animation state for road NPCs — constant-speed interpolation between snapshots. */
  private npcAnimTargets: Map<
    string,
    {
      startX: number;
      startY: number;
      targetX: number;
      targetY: number;
      startTime: number;
    }
  > = new Map();
  /** Expected ms between position snapshots — used to pace NPC movement. */
  private displayIntervalMs = 60_000;
  private mapWidth = 0;
  private mapHeight = 0;
  private minZoom = 0.15;
  private referenceZoom = 1;
  private lastPinchDist = 0;
  private lastPinchMidX = 0;
  private lastPinchMidY = 0;

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
    this.game.events.on("npc-action-update", this.handleNpcActionUpdate, this);
    this.game.events.on("set-input-enabled", (enabled: boolean) => {
      this.input.enabled = enabled;
    });
  }

  /** Returns true when a pointer event originated outside the Phaser canvas (i.e. on a UI overlay). */
  private isOverUI(pointer: Phaser.Input.Pointer): boolean {
    const domEvent = pointer.event as
      | PointerEvent
      | MouseEvent
      | WheelEvent
      | undefined;
    if (!domEvent?.target) return false;
    return domEvent.target !== this.game.canvas;
  }

  create() {
    // Globally disable Phaser hit-testing when the pointer is over a DOM overlay.
    // This prevents building-clicked, pointerover/out, etc. from firing through UI.
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.isOverUI(pointer)) {
        this.input.enabled = false;
        // Re-enable on next frame so subsequent canvas interactions work normally.
        this.time.delayedCall(0, () => {
          this.input.enabled = true;
        });
      }
    });

    this.input.on(
      "wheel",
      (
        pointer: Phaser.Input.Pointer,
        _gameObjects: Phaser.GameObjects.GameObject[],
        deltaX: number,
        deltaY: number
      ) => {
        if (this.isOverUI(pointer)) return;
        const cam = this.cameras.main;
        const domEvent = pointer.event as WheelEvent | undefined;
        if (domEvent?.ctrlKey) {
          // Trackpad pinch or Ctrl+scroll → zoom
          cam.setZoom(
            Phaser.Math.Clamp(cam.zoom * (1 - deltaY * 0.01), this.minZoom, 10)
          );
        } else {
          // Trackpad two-finger scroll or mouse wheel → pan
          cam.scrollX += deltaX / cam.zoom;
          cam.scrollY += deltaY / cam.zoom;
        }
      }
    );

    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (this.isOverUI(pointer)) return;
      // Skip single-pointer drag when two fingers are active (pinch gesture)
      if (this.input.pointer1.isDown && this.input.pointer2.isDown) return;
      // Cross-check Phaser state with actual DOM button state to prevent
      // "stuck drag" when pointerup fires on a DOM overlay instead of canvas.
      const domEvent = pointer.event as PointerEvent | MouseEvent | undefined;
      const buttonsPressed = domEvent?.buttons ?? 0;
      if (pointer.isDown && buttonsPressed > 0) {
        const cam = this.cameras.main;
        cam.scrollX -= (pointer.x - pointer.prevPosition.x) / cam.zoom;
        cam.scrollY -= (pointer.y - pointer.prevPosition.y) / cam.zoom;
      }
    });

    // Touch: pinch-to-zoom + two-finger pan
    this.input.addPointer(1); // enable 2nd pointer
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      if (this.isOverUI(pointer)) return;
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (p1.isDown && p2.isDown) {
        this.lastPinchDist = Phaser.Math.Distance.Between(
          p1.x,
          p1.y,
          p2.x,
          p2.y
        );
        this.lastPinchMidX = (p1.x + p2.x) / 2;
        this.lastPinchMidY = (p1.y + p2.y) / 2;
      }
    });
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
      if (this.isOverUI(pointer)) return;
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (!p1.isDown || !p2.isDown) return;

      const cam = this.cameras.main;
      const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      // Pinch zoom
      if (this.lastPinchDist > 0) {
        const scale = dist / this.lastPinchDist;
        cam.setZoom(Phaser.Math.Clamp(cam.zoom * scale, this.minZoom, 10));
      }

      // Two-finger pan
      cam.scrollX -= (midX - this.lastPinchMidX) / cam.zoom;
      cam.scrollY -= (midY - this.lastPinchMidY) / cam.zoom;

      this.lastPinchDist = dist;
      this.lastPinchMidX = midX;
      this.lastPinchMidY = midY;
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

    this.buildRoadPolylines();
    this.drawRoads();
    this.drawNodes();
    this.fitCamera();
  }

  private buildRoadPolylines() {
    const roads = this.configCache?.roads;
    if (!roads) return;
    for (const road of Object.values(roads)) {
      if (road.roadId && road.points.length >= 2) {
        this.roadPolylines.set(road.roadId, road.points);
      }
    }
  }

  /**
   * Interpolate along a polyline given t in [0, 1].
   * Returns the [x, y] position at fraction t of the polyline's total length.
   */
  private interpolatePolyline(
    points: [number, number][],
    t: number
  ): { x: number; y: number } {
    if (points.length < 2) return { x: points[0][0], y: points[0][1] };
    const clampedT = Phaser.Math.Clamp(t, 0, 1);

    // Compute cumulative segment lengths
    const segLengths: number[] = [];
    let totalLength = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i][0] - points[i - 1][0];
      const dy = points[i][1] - points[i - 1][1];
      const len = Math.sqrt(dx * dx + dy * dy);
      segLengths.push(len);
      totalLength += len;
    }

    if (totalLength === 0) return { x: points[0][0], y: points[0][1] };

    const targetDist = clampedT * totalLength;
    let accumulated = 0;

    for (let i = 0; i < segLengths.length; i++) {
      const segLen = segLengths[i];
      if (accumulated + segLen >= targetDist) {
        const segT = segLen > 0 ? (targetDist - accumulated) / segLen : 0;
        return {
          x: Phaser.Math.Linear(points[i][0], points[i + 1][0], segT),
          y: Phaser.Math.Linear(points[i][1], points[i + 1][1], segT),
        };
      }
      accumulated += segLen;
    }

    // Fallback: return last point
    const last = points[points.length - 1];
    return { x: last[0], y: last[1] };
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
      shadow.fillRoundedRect(
        -halfW + 6,
        -halfH + 6,
        NODE_WIDTH,
        NODE_HEIGHT,
        16
      );
      container.add(shadow);

      // Thumbnail + mask
      let maskGfx: Phaser.GameObjects.Graphics | null = null;
      if (this.textures.exists(thumbKey)) {
        const thumb = this.add.image(0, 0, thumbKey);
        const scale = Math.max(
          NODE_WIDTH / thumb.width,
          NODE_HEIGHT / thumb.height
        );
        thumb.setScale(scale);
        container.add(thumb);

        // Mask — applied to thumb only so label/glow aren't clipped
        maskGfx = this.make.graphics({ x: pos.x, y: pos.y });
        maskGfx.fillStyle(0xffffff);
        maskGfx.fillRoundedRect(-halfW, -halfH, NODE_WIDTH, NODE_HEIGHT, 16);
        thumb.setMask(maskGfx.createGeometryMask());
      }

      // Border
      const border = this.add.graphics();
      border.lineStyle(2, 0xffffff, 0.5);
      border.strokeRoundedRect(-halfW, -halfH, NODE_WIDTH, NODE_HEIGHT, 16);
      container.add(border);

      // Hover glow (hidden) — multi-layer for bloom/highlight effect
      const hoverGlow = this.add.graphics();
      hoverGlow.lineStyle(20, 0xffffff, 0.15);
      hoverGlow.strokeRoundedRect(
        -halfW - 10,
        -halfH - 10,
        NODE_WIDTH + 20,
        NODE_HEIGHT + 20,
        26
      );
      hoverGlow.lineStyle(12, 0xffffff, 0.35);
      hoverGlow.strokeRoundedRect(
        -halfW - 6,
        -halfH - 6,
        NODE_WIDTH + 12,
        NODE_HEIGHT + 12,
        22
      );
      hoverGlow.lineStyle(6, 0xffffff, 0.65);
      hoverGlow.strokeRoundedRect(
        -halfW - 3,
        -halfH - 3,
        NODE_WIDTH + 6,
        NODE_HEIGHT + 6,
        19
      );
      hoverGlow.lineStyle(3, 0xffffff, 1);
      hoverGlow.strokeRoundedRect(
        -halfW - 1,
        -halfH - 1,
        NODE_WIDTH + 2,
        NODE_HEIGHT + 2,
        17
      );
      hoverGlow.setAlpha(0);
      container.add(hoverGlow);

      // Label — above image, hidden by default, shown on hover
      const label = this.add
        .text(0, -halfH - 16, outline.name, {
          fontSize: "32px",
          color: "#ffffff",
          fontFamily: "serif",
          align: "center",
          stroke: "#000000",
          strokeThickness: 5,
        })
        .setOrigin(0.5, 1)
        .setAlpha(0)
        .setResolution(3);
      container.add(label);

      // Interactive
      const hitZone = this.add
        .zone(0, 0, NODE_WIDTH, NODE_HEIGHT)
        .setInteractive({ useHandCursor: true });
      container.add(hitZone);

      hitZone.on("pointerover", (pointer: Phaser.Input.Pointer) => {
        if (this.isOverUI(pointer)) return;
        container.setDepth(9999);
        // Dynamically set label resolution based on camera zoom so text stays crisp
        const cam = this.cameras.main;
        label.setResolution(Math.max(3, Math.ceil(1 / cam.zoom) * 3));
        // Adaptive hover: consistent visual enlargement regardless of zoom level
        const hoverScale = Phaser.Math.Clamp(
          (1.2 * this.referenceZoom) / cam.zoom,
          1.1,
          3.0
        );
        const targets = maskGfx ? [container, maskGfx] : [container];
        this.tweens.add({
          targets,
          scaleX: hoverScale,
          scaleY: hoverScale,
          duration: 200,
          ease: "Back.easeOut",
        });
        this.tweens.add({
          targets: [hoverGlow, label],
          alpha: 1,
          duration: 200,
        });
      });
      hitZone.on("pointerout", () => {
        container.setDepth(0);
        const targets = maskGfx ? [container, maskGfx] : [container];
        this.tweens.add({
          targets,
          scaleX: 1.0,
          scaleY: 1.0,
          duration: 200,
          ease: "Sine.easeOut",
        });
        this.tweens.add({
          targets: [hoverGlow, label],
          alpha: 0,
          duration: 200,
        });
      });
      hitZone.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
        if (this.isOverUI(pointer)) return;
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
      this.minZoom = Math.max(
        cam.width / this.mapWidth,
        cam.height / this.mapHeight
      );
      // Default zoom = 300% of cover
      cam.setZoom(this.minZoom * 3);
    } else if (this.nodePositions.size > 0) {
      // Fallback to node bounds
      const margin = 150;
      let minX = Number.POSITIVE_INFINITY,
        minY = Number.POSITIVE_INFINITY,
        maxX = Number.NEGATIVE_INFINITY,
        maxY = Number.NEGATIVE_INFINITY;
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
    this.referenceZoom = cam.zoom;
  }

  // ── NPC positions ──────────────────────────────────────────────

  private handleNpcPositionUpdate(data: {
    positions: Record<string, CharacterPosition>;
    npcStatuses: NpcStatusEntry[];
    scenes: SceneData[];
    junctions: JunctionData[];
    transportEdges: TransportEdgeData[];
    displayIntervalMs?: number;
  }) {
    if (data.displayIntervalMs) {
      this.displayIntervalMs = data.displayIntervalMs;
    }
    const sceneToParent = new Map<string, string>();
    for (const s of data.scenes) sceneToParent.set(s.id, s.parentLocationId);

    const junctionMap = new Map<string, JunctionData>();
    for (const j of data.junctions) junctionMap.set(j.id, j);

    const roadToEdge = new Map<string, TransportEdgeData>();
    for (const edge of data.transportEdges)
      roadToEdge.set(edge.streetSceneId, edge);

    const npcNameMap = new Map<string, string>();
    const npcActionMap = new Map<string, string | null>();
    for (const npc of data.npcStatuses) {
      npcNameMap.set(npc.npcId, npc.name);
      npcActionMap.set(npc.npcId, npc.currentAction ?? null);
    }

    // Group NPCs by their parent building so we can lay them out horizontally
    const buildingNpcs = new Map<string, string[]>(); // buildingId → npcId[]
    const npcBuildingMap = new Map<string, string>(); // npcId → buildingId

    const activeNpcIds = new Set<string>();

    for (const [npcId, position] of Object.entries(data.positions)) {
      activeNpcIds.add(npcId);
      const buildingId = this.resolveParentBuilding(
        position,
        sceneToParent,
        junctionMap,
        roadToEdge
      );
      if (buildingId) {
        npcBuildingMap.set(npcId, buildingId);
        const list = buildingNpcs.get(buildingId);
        if (list) list.push(npcId);
        else buildingNpcs.set(buildingId, [npcId]);
      }
    }

    // Compute final positions: evenly divide the thumbnail width (local coords)
    const DOT_Y_OFFSET = NODE_HEIGHT / 2 + 16;

    for (const [buildingId, npcIds] of buildingNpcs) {
      if (!this.nodeContainers.has(buildingId)) continue;

      const count = npcIds.length;

      for (let i = 0; i < count; i++) {
        const npcId = npcIds[i];
        const name = npcNameMap.get(npcId) ?? npcId;
        // Local coords relative to container center
        const localX = -NODE_WIDTH / 2 + (NODE_WIDTH * (i + 1)) / (count + 1);
        const localY = DOT_Y_OFFSET;

        this.upsertNpcDot(npcId, name, localX, localY, buildingId);
      }
    }

    // Handle road NPCs — compute target position and let update() lerp smoothly
    for (const [npcId, position] of Object.entries(data.positions)) {
      if (npcBuildingMap.has(npcId)) continue;
      if (position.type !== "road") continue;

      const name = npcNameMap.get(npcId) ?? npcId;
      let target: { x: number; y: number } | null = null;

      // Try polyline interpolation first
      const polyline = this.roadPolylines.get(position.roadId);
      if (polyline) {
        target = this.interpolatePolyline(polyline, position.position);
      } else {
        // Fallback: straight line between building endpoints
        const edge = roadToEdge.get(position.roadId);
        if (edge) {
          const fromPos = this.nodePositions.get(edge.fromLocationId);
          const toPos = this.nodePositions.get(edge.toLocationId);
          if (fromPos && toPos) {
            target = {
              x: Phaser.Math.Linear(fromPos.x, toPos.x, position.position),
              y: Phaser.Math.Linear(fromPos.y, toPos.y, position.position),
            };
          }
        }
      }

      if (!target) continue;

      const existing = this.npcDots.get(npcId);
      // Store animation: start from current position, arrive at target over displayIntervalMs
      this.npcAnimTargets.set(npcId, {
        startX: existing ? existing.currentX : target.x,
        startY: existing ? existing.currentY : target.y,
        targetX: target.x,
        targetY: target.y,
        startTime: this.time.now,
      });

      // First appearance: place immediately (no lerp needed yet)
      if (!existing) {
        this.upsertNpcDot(npcId, name, target.x, target.y, null);
      }
    }

    for (const npcId of activeNpcIds) {
      const npcData = this.npcDots.get(npcId);
      if (!npcData) continue;
      const currentAction = npcActionMap.get(npcId) ?? null;
      if (currentAction) {
        this.upsertBubble(npcData, currentAction);
      } else {
        this.clearBubble(npcData);
      }
    }

    // Clean up animation targets for NPCs that moved into buildings
    for (const [npcId] of npcBuildingMap) {
      this.npcAnimTargets.delete(npcId);
    }

    // Remove NPCs that are no longer active
    for (const [npcId, npcData] of this.npcDots) {
      if (!activeNpcIds.has(npcId)) {
        npcData.dot.destroy();
        npcData.label.destroy();
        npcData.bubbleBg?.destroy();
        npcData.bubbleText?.destroy();
        this.npcDots.delete(npcId);
        this.npcAnimTargets.delete(npcId);
      }
    }
  }

  /** Resolve which building (scenario) an NPC belongs to, or null for road NPCs. */
  private resolveParentBuilding(
    position: CharacterPosition,
    sceneToParent: Map<string, string>,
    junctionMap: Map<string, JunctionData>,
    _roadToEdge: Map<string, TransportEdgeData>
  ): string | null {
    switch (position.type) {
      case "scene": {
        return sceneToParent.get(position.sceneId) ?? null;
      }
      case "junction": {
        const junction = junctionMap.get(position.junctionId);
        if (!junction || junction.connectedSceneIds.length === 0) return null;
        return sceneToParent.get(junction.connectedSceneIds[0]) ?? null;
      }
      case "road":
        return null;
    }
  }

  /**
   * Create or update an NPC dot + label.
   * @param tx x position (local to container if buildingId set, otherwise world)
   * @param ty y position (local to container if buildingId set, otherwise world)
   * @param buildingId attach to this building's container, or null for world-level
   */
  private upsertNpcDot(
    npcId: string,
    name: string,
    tx: number,
    ty: number,
    buildingId: string | null = null
  ) {
    const existing = this.npcDots.get(npcId);

    // If the NPC moved to a different building, remove old dot and recreate
    if (existing && existing.buildingId !== buildingId) {
      existing.dot.destroy();
      existing.label.destroy();
      existing.bubbleBg?.destroy();
      existing.bubbleText?.destroy();
      this.npcDots.delete(npcId);
      this.upsertNpcDot(npcId, name, tx, ty, buildingId);
      return;
    }

    if (existing) {
      if (
        Math.abs(existing.currentX - tx) > 1 ||
        Math.abs(existing.currentY - ty) > 1
      ) {
        if (buildingId !== null) {
          // Building NPCs: tween to new layout position
          this.tweens.add({
            targets: existing.dot,
            x: tx,
            y: ty,
            duration: 400,
            ease: "Sine.easeInOut",
          });
          this.tweens.add({
            targets: existing.label,
            x: tx,
            y: ty + NPC_DOT_RADIUS + 6,
            duration: 400,
            ease: "Sine.easeInOut",
          });
          // Move bubble with dot
          if (existing.bubbleText) {
            const bubbleY =
              ty - NPC_DOT_RADIUS - BUBBLE_LABEL_GAP - BUBBLE_ARROW_H;
            this.tweens.add({
              targets: existing.bubbleText,
              x: tx,
              y: bubbleY,
              duration: 400,
              ease: "Sine.easeInOut",
              onUpdate: () => this.redrawBubbleBg(existing),
            });
          }
          existing.currentX = tx;
          existing.currentY = ty;
        }
        // Road NPCs: skip tween — update() handles smooth per-frame lerp
      }
    } else {
      const color = NPC_COLORS[this.colorIndex % NPC_COLORS.length];
      this.colorIndex++;

      const dot = this.add
        .circle(tx, ty, NPC_DOT_RADIUS, color, 0.9)
        .setStrokeStyle(2, 0xffffff, 0.6);
      const label = this.add
        .text(tx, ty + NPC_DOT_RADIUS + 6, name, {
          fontSize: "28px",
          color: "#fff",
          fontFamily: "serif",
          stroke: "#000",
          strokeThickness: 6,
        })
        .setOrigin(0.5, 0)
        .setResolution(3);

      // Add to building container so they scale together on hover
      const container = buildingId ? this.nodeContainers.get(buildingId) : null;
      if (container) {
        container.add([dot, label]);
      } else {
        dot.setDepth(10);
        label.setDepth(11);
      }

      this.npcDots.set(npcId, {
        dot,
        label,
        currentX: tx,
        currentY: ty,
        buildingId,
        bubbleBg: null,
        bubbleText: null,
      });
    }
  }

  /**
   * Per-frame update: move road NPCs at constant speed between snapshots.
   * Each snapshot sets a start→target pair; we linearly interpolate over
   * displayIntervalMs so the NPC arrives exactly when the next snapshot drops.
   */
  update(time: number, _delta: number) {
    for (const [npcId, anim] of this.npcAnimTargets) {
      const npcData = this.npcDots.get(npcId);
      if (!npcData || npcData.buildingId !== null) continue;

      const elapsed = time - anim.startTime;
      // Clamp to [0, 1] — NPC reaches target at t=1, then holds position
      const t = Math.min(elapsed / this.displayIntervalMs, 1);

      const newX = Phaser.Math.Linear(anim.startX, anim.targetX, t);
      const newY = Phaser.Math.Linear(anim.startY, anim.targetY, t);

      npcData.dot.setPosition(newX, newY);
      npcData.label.setPosition(newX, newY + NPC_DOT_RADIUS + 6);
      // Move bubble with road NPC
      if (npcData.bubbleText && npcData.bubbleBg) {
        const bubbleY =
          newY - NPC_DOT_RADIUS - BUBBLE_LABEL_GAP - BUBBLE_ARROW_H;
        this.positionBubble(npcData, newX, bubbleY);
      }
      npcData.currentX = newX;
      npcData.currentY = newY;
    }
  }

  // ── NPC action bubbles ──────────────────────────────────────────

  private handleNpcActionUpdate(data: { npcId: string; action: string }) {
    const npcData = this.npcDots.get(data.npcId);
    if (!npcData) return;
    this.upsertBubble(npcData, data.action);
  }

  private clearBubble(npcData: NpcDotData) {
    npcData.bubbleBg?.destroy();
    npcData.bubbleText?.destroy();
    npcData.bubbleBg = null;
    npcData.bubbleText = null;
  }

  private upsertBubble(npcData: NpcDotData, action: string) {
    const truncated = action.length > 30 ? action.slice(0, 28) + "…" : action;

    if (npcData.bubbleText) {
      // Update existing bubble
      npcData.bubbleText.setText(truncated);
      this.redrawBubbleBg(npcData);
      return;
    }

    // Create new bubble
    const bubbleText = this.add
      .text(0, 0, truncated, {
        fontSize: "20px",
        color: "#ffffff",
        fontFamily: "sans-serif",
      })
      .setOrigin(0.5, 1)
      .setResolution(3);

    const bubbleBg = this.add.graphics();

    npcData.bubbleText = bubbleText;
    npcData.bubbleBg = bubbleBg;

    // Add to container if building NPC
    const container = npcData.buildingId
      ? this.nodeContainers.get(npcData.buildingId)
      : null;
    if (container) {
      container.add([bubbleBg, bubbleText]);
    } else {
      bubbleBg.setDepth(12);
      bubbleText.setDepth(13);
    }

    // Position and draw background
    const bubbleY =
      npcData.currentY - NPC_DOT_RADIUS - BUBBLE_LABEL_GAP - BUBBLE_ARROW_H;
    this.positionBubble(npcData, npcData.currentX, bubbleY);

    // Fade in
    bubbleBg.setAlpha(0);
    bubbleText.setAlpha(0);
    this.tweens.add({
      targets: [bubbleBg, bubbleText],
      alpha: 1,
      duration: 200,
    });
  }

  private positionBubble(npcData: NpcDotData, cx: number, bottomY: number) {
    const text = npcData.bubbleText!;
    text.setPosition(cx, bottomY);

    // Redraw background around text
    this.redrawBubbleBg(npcData);
  }

  private redrawBubbleBg(npcData: NpcDotData) {
    const text = npcData.bubbleText!;
    const bg = npcData.bubbleBg!;

    const padX = 8;
    const padY = 5;
    const w = text.width + padX * 2;
    const h = text.height + padY * 2;
    const cx = text.x;
    const bottomY = text.y;
    const topY = bottomY - text.height;
    const rectX = cx - w / 2;
    const rectY = topY - padY;

    bg.clear();
    bg.fillStyle(0x000000, 0.75);
    bg.fillRoundedRect(rectX, rectY, w, h, 8);
    // Arrow pointing down
    const arrowHalfW = 6;
    bg.fillTriangle(
      cx - arrowHalfW,
      rectY + h,
      cx + arrowHalfW,
      rectY + h,
      cx,
      rectY + h + BUBBLE_ARROW_H
    );
  }

  private handleZoomTo(data: { x: number; y: number; zoom: number }) {
    const cam = this.cameras.main;
    cam.pan(data.x, data.y, 500, "Power2");
    cam.zoomTo(data.zoom, 500);
  }
}
