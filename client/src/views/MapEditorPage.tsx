import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

// --- Types ---

interface Rect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name: string;
}

interface MapConfig {
  town: { background: string };
  scenes: Record<string, {
    background: string;
    npcAreas: Array<{ x: number; y: number; width: number; height: number }>;
  }>;
}

type DrawTool = "npc_area" | "select";

const AREA_FILL = "rgba(0, 200, 120, 0.25)";
const AREA_BORDER = "#00c878";
const AREA_FILL_SELECTED = "rgba(0, 200, 120, 0.4)";

// --- Main Component ---

export default function MapEditorPage() {
  const { moduleName } = useParams<{ moduleName: string }>();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);

  const [currentSceneId, setCurrentSceneId] = useState<string>("");
  const [tool, setTool] = useState<DrawTool>("npc_area");
  const [rects, setRects] = useState<Rect[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bgLoaded, setBgLoaded] = useState(false);
  const [bgUrl, setBgUrl] = useState("");

  // Drawing
  const drawingRef = useRef<{ startX: number; startY: number } | null>(null);
  const [drawPreview, setDrawPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Zoom/pan
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panningRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  // Config
  const [config, setConfig] = useState<MapConfig>({ town: { background: "" }, scenes: {} });
  const [sceneIds, setSceneIds] = useState<string[]>([]);
  const [newSceneId, setNewSceneId] = useState("");

  // Load existing config
  useEffect(() => {
    if (!moduleName) return;
    fetch(`/api/maps/scene/map_config.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: MapConfig | null) => {
        if (data) {
          setConfig(data);
          setSceneIds(Object.keys(data.scenes));
        }
      })
      .catch(() => {});
  }, [moduleName]);

  function loadRectsForScene(cfg: MapConfig, sceneId: string) {
    const scene = cfg.scenes[sceneId];
    if (!scene) { setRects([]); return; }
    setRects(
      scene.npcAreas.map((a, i) => ({
        id: `area_${i}`,
        x: a.x, y: a.y, width: a.width, height: a.height,
        name: `area_${i}`,
      }))
    );
    setSelectedId(null);
  }

  // Load background
  const loadBackground = useCallback((url: string) => {
    setBgLoaded(false);
    setBgUrl(url);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      bgImageRef.current = img;
      setBgLoaded(true);
      const canvas = canvasRef.current;
      if (canvas) {
        setZoom(Math.min(canvas.width / img.width, canvas.height / img.height));
        setPan({ x: 0, y: 0 });
      }
    };
    img.src = url;
  }, []);

  // Draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const container = canvas.parentElement;
    if (container) {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(pan.x, pan.y);
    ctx.scale(zoom, zoom);

    if (bgImageRef.current && bgLoaded) {
      ctx.drawImage(bgImageRef.current, 0, 0);
    }

    for (const rect of rects) {
      const sel = rect.id === selectedId;
      ctx.fillStyle = sel ? AREA_FILL_SELECTED : AREA_FILL;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.strokeStyle = sel ? "#ffffff" : AREA_BORDER;
      ctx.lineWidth = (sel ? 2 : 1) / zoom;
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      ctx.fillStyle = "#fff";
      ctx.font = `${Math.max(10, 12 / zoom)}px sans-serif`;
      ctx.fillText(rect.name, rect.x + 3, rect.y + 14 / zoom);
    }

    if (drawPreview) {
      ctx.fillStyle = AREA_FILL;
      ctx.fillRect(drawPreview.x, drawPreview.y, drawPreview.w, drawPreview.h);
      ctx.strokeStyle = AREA_BORDER;
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(drawPreview.x, drawPreview.y, drawPreview.w, drawPreview.h);
    }

    ctx.restore();
  }, [rects, selectedId, bgLoaded, zoom, pan, drawPreview]);

  function screenToWorld(sx: number, sy: number) {
    return { x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom };
  }

  // Mouse
  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const world = screenToWorld(sx, sy);

    if (e.button === 1) {
      panningRef.current = { startX: sx, startY: sy, panX: pan.x, panY: pan.y };
      return;
    }

    if (tool === "select") {
      const clicked = [...rects].reverse().find(
        (rect) => world.x >= rect.x && world.x <= rect.x + rect.width && world.y >= rect.y && world.y <= rect.y + rect.height
      );
      setSelectedId(clicked?.id ?? null);
      if (!clicked) {
        panningRef.current = { startX: sx, startY: sy, panX: pan.x, panY: pan.y };
      }
      return;
    }

    drawingRef.current = { startX: world.x, startY: world.y };
  }

  function handleMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;

    if (panningRef.current) {
      setPan({
        x: panningRef.current.panX + (sx - panningRef.current.startX),
        y: panningRef.current.panY + (sy - panningRef.current.startY),
      });
      return;
    }

    if (drawingRef.current) {
      const world = screenToWorld(sx, sy);
      setDrawPreview({
        x: Math.min(drawingRef.current.startX, world.x),
        y: Math.min(drawingRef.current.startY, world.y),
        w: Math.abs(world.x - drawingRef.current.startX),
        h: Math.abs(world.y - drawingRef.current.startY),
      });
    }
  }

  function handleMouseUp() {
    if (panningRef.current) { panningRef.current = null; return; }

    if (drawingRef.current && drawPreview && drawPreview.w > 5 && drawPreview.h > 5) {
      const id = `area_${Date.now()}`;
      setRects((prev) => [...prev, {
        id, name: id,
        x: Math.round(drawPreview.x), y: Math.round(drawPreview.y),
        width: Math.round(drawPreview.w), height: Math.round(drawPreview.h),
      }]);
      setSelectedId(id);
    }
    drawingRef.current = null;
    setDrawPreview(null);
  }

  function handleWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.05, Math.min(5, zoom * delta));
    setPan({ x: sx - (sx - pan.x) * (newZoom / zoom), y: sy - (sy - pan.y) * (newZoom / zoom) });
    setZoom(newZoom);
  }

  const selectedRect = rects.find((r) => r.id === selectedId);

  function updateSelected(u: Partial<Rect>) {
    setRects((prev) => prev.map((r) => (r.id === selectedId ? { ...r, ...u } : r)));
  }

  function deleteSelected() {
    setRects((prev) => prev.filter((r) => r.id !== selectedId));
    setSelectedId(null);
  }

  // Save rects → config
  function saveToConfig() {
    if (!currentSceneId) return;
    setConfig((prev) => ({
      ...prev,
      scenes: {
        ...prev.scenes,
        [currentSceneId]: {
          background: bgUrl.split("/").pop() ?? "",
          npcAreas: rects.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
        },
      },
    }));
  }

  function exportConfig() {
    saveToConfig();
    setTimeout(() => {
      setConfig((cur) => {
        const blob = new Blob([JSON.stringify(cur, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "map_config.json"; a.click();
        URL.revokeObjectURL(url);
        return cur;
      });
    }, 100);
  }

  function copyConfig() {
    saveToConfig();
    setTimeout(() => {
      setConfig((cur) => { navigator.clipboard.writeText(JSON.stringify(cur, null, 2)); return cur; });
    }, 100);
  }

  function switchScene(sceneId: string) {
    saveToConfig();
    setCurrentSceneId(sceneId);
    loadRectsForScene(config, sceneId);
    const bg = config.scenes[sceneId]?.background;
    if (bg) loadBackground(`/api/maps/scene/${bg}`);
  }

  // BG input
  const [bgInput, setBgInput] = useState("");

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    loadBackground(URL.createObjectURL(file));
    setBgUrl(file.name);
  }

  // Keyboard
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !(e.target instanceof HTMLInputElement)) deleteSelected();
      if (e.key === "Escape") { setSelectedId(null); setTool("select"); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-200">
      {/* Left sidebar */}
      <div className="w-56 bg-gray-900 border-r border-gray-700 flex flex-col p-3 gap-3 overflow-y-auto">
        <h2 className="text-sm font-bold text-gray-400 uppercase">Map Editor</h2>

        {/* Background */}
        <div className="space-y-1">
          <label className="text-xs text-gray-500">Background</label>
          <div className="flex gap-1">
            <input className="flex-1 bg-gray-800 text-xs px-2 py-1 rounded border border-gray-700" placeholder="filename" value={bgInput} onChange={(e) => setBgInput(e.target.value)} />
            <button onClick={() => bgInput && loadBackground(bgInput.startsWith("http") ? bgInput : `/api/maps/scene/${bgInput}`)} className="bg-blue-600 text-xs px-2 py-1 rounded hover:bg-blue-500">Go</button>
          </div>
          <input type="file" accept="image/*" onChange={handleFileUpload} className="text-xs text-gray-500" />
        </div>

        {/* Scene list */}
        <div className="space-y-1">
          <label className="text-xs text-gray-500">Scenes</label>
          {sceneIds.map((sid) => (
            <button key={sid} onClick={() => switchScene(sid)} className={`w-full text-left text-xs px-2 py-1.5 rounded ${currentSceneId === sid ? "bg-green-600" : "bg-gray-800 hover:bg-gray-700"}`}>{sid}</button>
          ))}
          <div className="flex gap-1">
            <input className="flex-1 bg-gray-800 text-xs px-2 py-1 rounded border border-gray-700" placeholder="SCN_X_SUB_Y" value={newSceneId} onChange={(e) => setNewSceneId(e.target.value)} />
            <button onClick={() => { if (newSceneId && !sceneIds.includes(newSceneId)) { setSceneIds((p) => [...p, newSceneId]); setNewSceneId(""); } }} className="bg-gray-700 text-xs px-2 py-1 rounded hover:bg-gray-600">+</button>
          </div>
        </div>

        {/* Tools */}
        <div className="space-y-1">
          <label className="text-xs text-gray-500">Tool</label>
          <button onClick={() => setTool("select")} className={`w-full text-left text-xs px-2 py-1.5 rounded ${tool === "select" ? "bg-purple-600" : "bg-gray-800 hover:bg-gray-700"}`}>Select / Pan</button>
          <button onClick={() => setTool("npc_area")} className={`w-full text-left text-xs px-2 py-1.5 rounded ${tool === "npc_area" ? "bg-purple-600" : "bg-gray-800 hover:bg-gray-700"}`}>Draw NPC Area</button>
        </div>

        {/* Object list */}
        <div className="space-y-1 flex-1 overflow-y-auto">
          <label className="text-xs text-gray-500">NPC Areas ({rects.length})</label>
          {rects.map((r) => (
            <div key={r.id} onClick={() => setSelectedId(r.id)} className={`text-xs px-2 py-1 rounded cursor-pointer ${r.id === selectedId ? "bg-gray-700" : "bg-gray-800 hover:bg-gray-750"}`}>
              <span className="w-2 h-2 rounded-full inline-block mr-1" style={{ backgroundColor: AREA_BORDER }} />{r.name}
            </div>
          ))}
        </div>

        {/* Export */}
        <div className="space-y-1 pt-2 border-t border-gray-700">
          <button onClick={exportConfig} className="w-full bg-green-600 text-xs px-2 py-2 rounded hover:bg-green-500 font-medium">Export JSON</button>
          <button onClick={copyConfig} className="w-full bg-gray-700 text-xs px-2 py-2 rounded hover:bg-gray-600">Copy to Clipboard</button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ cursor: tool === "select" ? "default" : "crosshair" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        <div className="absolute bottom-0 left-0 right-0 bg-gray-900/80 text-xs text-gray-400 px-3 py-1 flex gap-4">
          <span>Scene: {currentSceneId || "(none)"}</span>
          <span>Tool: {tool}</span>
          <span>Zoom: {(zoom * 100).toFixed(0)}%</span>
        </div>
      </div>

      {/* Right sidebar — properties */}
      <div className="w-52 bg-gray-900 border-l border-gray-700 p-3 space-y-3 overflow-y-auto">
        <h3 className="text-sm font-bold text-gray-400 uppercase">Properties</h3>
        {selectedRect ? (
          <div className="space-y-2">
            <Field label="Name" value={selectedRect.name} onChange={(v) => updateSelected({ name: v })} />
            <Field label="X" value={String(Math.round(selectedRect.x))} onChange={(v) => updateSelected({ x: Number(v) })} />
            <Field label="Y" value={String(Math.round(selectedRect.y))} onChange={(v) => updateSelected({ y: Number(v) })} />
            <Field label="Width" value={String(Math.round(selectedRect.width))} onChange={(v) => updateSelected({ width: Number(v) })} />
            <Field label="Height" value={String(Math.round(selectedRect.height))} onChange={(v) => updateSelected({ height: Number(v) })} />
            <button onClick={deleteSelected} className="w-full bg-red-700 text-xs px-2 py-1.5 rounded hover:bg-red-600 mt-2">Delete</button>
          </div>
        ) : (
          <p className="text-xs text-gray-500">Select an area to edit</p>
        )}
        <div className="pt-3 border-t border-gray-700 text-xs text-gray-600 space-y-0.5">
          <p>Scroll = zoom</p>
          <p>Drag (select mode) = pan</p>
          <p>Del = delete</p>
          <p>Esc = deselect</p>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange?: (v: string) => void; disabled?: boolean }) {
  return (
    <div>
      <label className="text-xs text-gray-500">{label}</label>
      <input className="w-full bg-gray-800 text-xs px-2 py-1 rounded border border-gray-700 disabled:opacity-50" value={value} onChange={(e) => onChange?.(e.target.value)} disabled={disabled} />
    </div>
  );
}
