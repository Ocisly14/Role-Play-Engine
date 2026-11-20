import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { InjectPlayerForm } from "../components/play/InjectPlayerForm";
import { ManualInputs } from "../components/play/ManualInputs";
import { PendingBanner } from "../components/play/PendingBanner";
import { HerePanel, PerceptionStream } from "../components/play/PlayPanels";
import { RelationshipBoard } from "../components/play/RelationshipBoard";
import {
  type LabelLookup,
  formatGameTime,
} from "../components/play/playConstants";
import {
  type SimulationEvent,
  useSimulationWebSocket,
} from "../hooks/useSimulationWebSocket";
import {
  PlayerApiError,
  type PlayerInput,
  type PlayerMode,
  type PlayerView,
  answerPlayer,
  continuePlayer,
  errorMessage,
  fetchPlayer,
  linkBoardPeople,
  nameBoardPerson,
  noteBoardPerson,
  resumeSimulation,
  sendPlayerAdvice,
  sendPlayerCommand,
  setPlayerMode,
  unlinkBoardPeople,
} from "../services/playerApi";
import {
  type SimulationStatus,
  fetchStatus,
  fetchTopology,
  pauseSimulation,
  startSimulation,
} from "../services/simulationApi";

/** Events after which the player's view may have changed. */
const REFRESH_EVENTS = new Set([
  "player_perceived",
  "player_pending",
  "player_state",
  "player_map_updated",
  "player_died",
  "simulation_state_changed",
]);

const EMPTY_OPTIONS: PlayerView["options"] = { exits: [], mentions: [] };

const STATE_TEXT: Record<SimulationStatus["state"], string> = {
  initializing: "启动中",
  running: "运行中",
  paused: "已暂停",
  stopped: "已停止",
  completed: "已结束",
};

export default function PlayPage() {
  const { sessionId = "" } = useParams<{ sessionId: string }>();
  const [status, setStatus] = useState<SimulationStatus | null>(null);
  const [player, setPlayer] = useState<PlayerView | null>(null);
  const [playerLoaded, setPlayerLoaded] = useState(false);
  const [placeNames, setPlaceNames] = useState<Map<string, string>>(
    () => new Map()
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [advice, setAdvice] = useState("");
  const [connected, setConnected] = useState(false);

  // Only the newest player response may land (a slow GET must not overwrite
  // a newer mutation result).
  const playerSeq = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();

  const refreshPlayer = useCallback(async () => {
    if (!sessionId) return;
    const seq = ++playerSeq.current;
    try {
      const p = await fetchPlayer(sessionId);
      if (seq !== playerSeq.current) return;
      setPlayer(p);
      setPlayerLoaded(true);
    } catch (err) {
      if (seq !== playerSeq.current) return;
      setError(errorMessage(err));
      setPlayerLoaded(true);
    }
  }, [sessionId]);

  const refreshStatus = useCallback(async () => {
    if (!sessionId) return;
    try {
      setStatus(await fetchStatus(sessionId));
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [sessionId]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void refreshPlayer();
      void refreshStatus();
    }, 200);
  }, [refreshPlayer, refreshStatus]);

  // Initial load, a slow status poll (the clock), and the place names.
  useEffect(() => {
    void refreshPlayer();
    void refreshStatus();
    const poll = setInterval(() => void refreshStatus(), 5000);
    return () => {
      clearInterval(poll);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refreshPlayer, refreshStatus]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetchTopology(sessionId)
      .then((topo) => {
        if (cancelled) return;
        const names = new Map<string, string>();
        for (const s of topo.scenes ?? []) names.set(s.id, s.name);
        for (const r of topo.roads ?? []) names.set(r.id, r.name);
        for (const j of topo.junctions ?? []) names.set(j.id, j.name);
        setPlaceNames(names);
      })
      .catch(() => {
        // Names are a nicety; ids are shown without them.
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const onEvent = useCallback(
    (event: SimulationEvent) => {
      if (event.gameDateTime) {
        setStatus((prev) =>
          prev && event.gameDateTime > prev.currentDateTime
            ? { ...prev, currentDateTime: event.gameDateTime }
            : prev
        );
      }
      if (REFRESH_EVENTS.has(event.type)) scheduleRefresh();
    },
    [scheduleRefresh]
  );
  const onConnected = useCallback(() => setConnected(true), []);
  const onDisconnected = useCallback(() => setConnected(false), []);
  useSimulationWebSocket({
    sessionId: sessionId || null,
    onEvent,
    onConnected,
    onDisconnected,
  });

  const options = player?.options ?? EMPTY_OPTIONS;
  const replyWaiting = player?.state.dialogue?.at(-1)?.status === "waiting";
  useEffect(() => {
    if (!replyWaiting) return;
    const poll = setInterval(() => void refreshPlayer(), 1800);
    return () => clearInterval(poll);
  }, [replyWaiting, refreshPlayer]);
  const people = player?.board?.people;
  const labelOf = useMemo<LabelLookup>(() => {
    const labels = new Map<string, string>();
    for (const person of people ?? []) labels.set(person.handle, person.label);
    for (const m of options.exits) labels.set(m.handle, m.label);
    for (const m of options.mentions) labels.set(m.handle, m.label);
    return (id: string) => labels.get(id) ?? placeNames.get(id);
  }, [options, people, placeNames]);

  /** Run a player mutation; the response carries the new view. Returns
   *  whether it succeeded. A 422 on a command is the world's refusal. */
  async function mutate(
    run: () => Promise<PlayerView>,
    isCommand = false
  ): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const next = await run();
      playerSeq.current++;
      setPlayer(next);
      if (isCommand) setRefusal(null);
      void refreshStatus();
      return true;
    } catch (err) {
      if (isCommand && err instanceof PlayerApiError && err.status === 422) {
        setRefusal(err.message);
      } else {
        setError(errorMessage(err));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function control(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      void refreshStatus();
      void refreshPlayer();
    }
  }

  const onPlay = () =>
    control(() =>
      status && status.ticksExecuted === 0
        ? startSimulation(sessionId)
        : resumeSimulation(sessionId)
    );
  const onPause = () => control(() => pauseSimulation(sessionId));
  const onCommand = (input: PlayerInput) =>
    mutate(() => sendPlayerCommand(sessionId, input), true);
  const onMode = (mode: PlayerMode) =>
    void mutate(() => setPlayerMode(sessionId, mode));
  const onContinue = () => void mutate(() => continuePlayer(sessionId));
  const onAnswer = (text: string) =>
    mutate(() => answerPlayer(sessionId, text));
  const onAdvice = async () => {
    const text = advice.trim();
    if (!text) return;
    if (await mutate(() => sendPlayerAdvice(sessionId, text))) setAdvice("");
  };

  const running =
    status?.state === "running" || status?.state === "initializing";
  const ended = status?.state === "stopped" || status?.state === "completed";
  const pending = player?.state.pending ?? null;
  const dead = player !== null && (!player.alive || pending?.kind === "dead");
  const mode = player?.state.mode ?? "manual";

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-100 text-gray-800">
      {/* Top bar */}
      <header className="flex flex-wrap items-center gap-3 px-4 py-2 bg-gray-800 text-gray-100 shadow">
        <Link to="/play" className="text-sm text-gray-300 hover:text-white">
          ← 游戏列表
        </Link>
        <div className="font-mono text-lg">
          {formatGameTime(status?.currentDateTime)}
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded ${
            running ? "bg-green-600" : ended ? "bg-gray-500" : "bg-amber-600"
          }`}
        >
          {status ? STATE_TEXT[status.state] : "…"}
        </span>
        <span
          className={`text-xs ${connected ? "text-green-300" : "text-red-300"}`}
          title="实时连接"
        >
          {connected ? "● 已连接" : "○ 未连接"}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy || running || ended || !status}
            onClick={() => void onPlay()}
            className="px-3 py-1 rounded bg-green-600 text-sm hover:bg-green-700 disabled:opacity-40"
          >
            ▶ {status && status.ticksExecuted === 0 ? "开始" : "继续"}
          </button>
          <button
            type="button"
            disabled={busy || !running}
            onClick={() => void onPause()}
            className="px-3 py-1 rounded bg-amber-600 text-sm hover:bg-amber-700 disabled:opacity-40"
          >
            ⏸ 暂停
          </button>
        </div>
        {player && (
          <div className="flex rounded overflow-hidden border border-gray-500 ml-auto">
            {(["manual", "delegated"] as const).map((m) => (
              <button
                key={m}
                type="button"
                disabled={busy || replyWaiting || dead || mode === m}
                onClick={() => onMode(m)}
                className={`px-3 py-1 text-sm ${
                  mode === m
                    ? "bg-blue-600 text-white"
                    : "bg-gray-700 text-gray-300 hover:bg-gray-600"
                }`}
              >
                {m === "manual" ? "手动" : "托管"}
              </button>
            ))}
          </div>
        )}
      </header>

      {error && (
        <div className="px-4 py-2 bg-red-100 text-red-700 text-sm flex justify-between">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-500 hover:text-red-700"
          >
            ✕
          </button>
        </div>
      )}

      {!playerLoaded ? (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          加载中……
        </div>
      ) : player === null ? (
        <div className="flex-1 overflow-y-auto p-6">
          {status && status.state !== "paused" && (
            <p className="max-w-2xl mx-auto mb-3 text-sm text-amber-700">
              世界正在{STATE_TEXT[status.state]}，请先暂停再创建角色。
            </p>
          )}
          <InjectPlayerForm
            sessionId={sessionId}
            onInjected={() => {
              void refreshPlayer();
              void refreshStatus();
            }}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-4 p-4">
          <aside className="w-80 shrink-0 space-y-4 overflow-y-auto">
            <HerePanel player={player} labelOf={labelOf} />
            {player.board ? (
              <RelationshipBoard
                board={player.board}
                disabled={busy || dead || ended}
                onName={(handle, name) =>
                  mutate(() => nameBoardPerson(sessionId, handle, name))
                }
                onNote={(handle, note) =>
                  mutate(() => noteBoardPerson(sessionId, handle, note))
                }
                onLink={(a, b, label) =>
                  mutate(() => linkBoardPeople(sessionId, a, b, label))
                }
                onUnlink={(id) =>
                  void mutate(() => unlinkBoardPeople(sessionId, id))
                }
              />
            ) : (
              <p className="rounded bg-white p-3 text-sm text-gray-500">
                暂时无法加载关系板。
              </p>
            )}
          </aside>

          <main className="flex-1 min-w-0 flex flex-col gap-3">
            <div className="flex-1 min-h-0">
              <PerceptionStream player={player} labelOf={labelOf} />
            </div>

            <div className="text-sm bg-white rounded shadow px-3 py-2">
              <span className="text-gray-500">当前行动：</span>
              {player.currentAction ? (
                <>
                  {player.currentAction.description}
                  <span className="ml-2 text-xs text-gray-400">
                    已进行 {player.currentAction.progressMinutes}
                    {player.currentAction.resolvedDurationTicks !== undefined
                      ? ` / ${player.currentAction.resolvedDurationTicks}`
                      : ""}{" "}
                    分钟
                  </span>
                </>
              ) : (
                <span className="text-gray-400">无</span>
              )}
            </div>

            <div className="max-h-[45vh] overflow-y-auto space-y-3 bg-white rounded shadow p-3">
              {dead ? (
                <PendingBanner
                  pending={
                    pending?.kind === "dead"
                      ? pending
                      : {
                          kind: "dead",
                          since: status?.currentDateTime ?? "",
                        }
                  }
                  busy={busy}
                  onContinue={onContinue}
                  onAnswer={onAnswer}
                />
              ) : (
                <>
                  {pending && (
                    <PendingBanner
                      pending={pending}
                      busy={busy}
                      onContinue={onContinue}
                      onAnswer={onAnswer}
                    />
                  )}
                  {mode === "manual" ? (
                    <ManualInputs
                      options={options}
                      learnedLanguages={player.learnedLanguages ?? []}
                      skillValues={player.skillValues ?? {}}
                      busy={busy || replyWaiting}
                      labelOf={labelOf}
                      refusal={refusal}
                      onCommand={onCommand}
                    />
                  ) : (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void onAdvice();
                      }}
                    >
                      <input
                        className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
                        placeholder="对你的角色说……"
                        value={advice}
                        onChange={(e) => setAdvice(e.target.value)}
                      />
                      <button
                        type="submit"
                        disabled={busy || !advice.trim()}
                        className="px-3 py-1 rounded bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                      >
                        说
                      </button>
                    </form>
                  )}
                </>
              )}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
