import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatGameTime } from "../components/play/playConstants";
import { errorMessage } from "../services/playerApi";
import {
  type SimulationListItem,
  createSimulation,
  listSimulations,
} from "../services/simulationApi";

const STATE_TEXT: Record<SimulationListItem["state"], string> = {
  initializing: "启动中",
  running: "运行中",
  paused: "已暂停",
  stopped: "已停止",
  completed: "已结束",
};

/** /play — pick a session to play, or start a new Grayhaven game. */
export default function PlayListPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SimulationListItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await listSimulations());
    } catch (err) {
      setError(errorMessage(err));
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function newGame() {
    setCreating(true);
    setError(null);
    try {
      const { sessionId } = await createSimulation({
        moduleName: "grayhaven",
        language: "zh",
      });
      navigate(`/play/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
    }
  }

  return (
    <div className="fixed inset-0 overflow-y-auto bg-gray-100 text-gray-800">
      <div className="max-w-3xl mx-auto p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">单人游戏（测试）</h1>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="px-3 py-1.5 rounded bg-gray-200 text-sm hover:bg-gray-300"
            >
              刷新
            </button>
            <button
              type="button"
              disabled={creating}
              onClick={() => void newGame()}
              className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {creating ? "创建中……" : "新的灰港游戏"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded bg-red-100 text-red-700 text-sm px-3 py-2">
            {error}
          </div>
        )}

        {sessions === null ? (
          <p className="text-gray-500">加载中……</p>
        ) : sessions.length === 0 ? (
          <p className="text-gray-500">还没有会话。</p>
        ) : (
          <ul className="bg-white rounded shadow divide-y">
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <Link
                  to={`/play/${encodeURIComponent(s.sessionId)}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
                >
                  <div>
                    <div className="font-medium">
                      {s.moduleName ?? "未知模组"}
                    </div>
                    <div className="text-xs text-gray-400 font-mono">
                      {s.sessionId}
                    </div>
                  </div>
                  <div className="text-right text-sm">
                    <div>{formatGameTime(s.currentDateTime)}</div>
                    <div className="text-xs text-gray-500">
                      {STATE_TEXT[s.state] ?? s.state} · 第 {s.ticksExecuted}{" "}
                      分钟
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
