import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../services/api";

interface DailyStats {
  id: string;
  stat_date: string;
  login_users_count: number;
  active_users_count: number;
  new_users_count: number;
  total_simulations_count: number;
  total_simulation_events_count: number;
  avg_simulations_per_active_user: number;
  new_mods_short_count: number;
  new_mods_medium_count: number;
  new_mods_long_count: number;
  total_new_mods_count: number;
  created_at: string;
  updated_at: string;
}

interface WindowStats {
  window_start: string;
  window_end: string;
  login_users_count: number;
  active_users_count: number;
  new_users_count: number;
  total_simulations_count: number;
  total_simulation_events_count: number;
  avg_simulations_per_active_user: number;
  new_mods_short_count: number;
  new_mods_medium_count: number;
  new_mods_long_count: number;
  total_new_mods_count: number;
}

interface AccumulatedStats {
  accumulated_users_count: number;
  accumulated_simulations_count: number;
}

interface TopUserSimulations {
  email: string;
  username: string | null;
  simulations_count: number;
}

interface VisitorHourlyEntry {
  hour: number;
  count: number;
}

interface VisitorIpEntry {
  ip: string;
  visitCount: number;
  avgDurationSeconds: number;
}

interface VisitorStatsData {
  today: {
    totalVisits: number;
    avgDurationSeconds: number;
  };
  hourly: VisitorHourlyEntry[];
  byIp: VisitorIpEntry[];
}

interface ChartEntry {
  date: string;
  loginUsers: number;
  activeUsers: number;
  newUsers: number;
  simulations: number;
  simulationEvents: number;
  avgSimsPerUser: number;
  newMods: number;
}

interface ModChartEntry {
  date: string;
  short: number;
  medium: number;
  long: number;
}

type TabType = "usage" | "visitors";

interface AnalyticsProps {
  onClose: () => void;
}

export function Analytics({ onClose }: AnalyticsProps) {
  const { t, i18n } = useTranslation(["home", "common"]);
  const [activeTab, setActiveTab] = useState<TabType>("usage");
  const [stats, setStats] = useState<DailyStats[]>([]);
  const [recent48h, setRecent48h] = useState<WindowStats | null>(null);
  const [accumulated, setAccumulated] = useState<AccumulatedStats | null>(null);
  const [topUsersToday, setTopUsersToday] = useState<TopUserSimulations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Visitor stats state
  const [visitorStats, setVisitorStats] = useState<VisitorStatsData | null>(
    null
  );
  const [visitorLoading, setVisitorLoading] = useState(false);
  const [visitorError, setVisitorError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when language changes to reformat dates
  useEffect(() => {
    fetchAnalytics();
  }, [i18n.language]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: visitorStats used only as a guard to avoid duplicate fetches
  useEffect(() => {
    if (activeTab === "visitors" && !visitorStats) {
      fetchVisitorStats();
    }
  }, [activeTab]);

  const fetchAnalytics = async () => {
    try {
      setLoading(true);
      const response = await api.get("/analytics/daily?days=30");
      setStats(response.data.history || []);
      setRecent48h(response.data.recent48h || null);
      setAccumulated(response.data.accumulated || null);
      setTopUsersToday(response.data.topUsersToday || []);
      setError(null);
    } catch (err) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(
        axiosErr.response?.data?.error || t("home:analytics.errors.loadFailed")
      );
      console.error("Analytics fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  const fetchVisitorStats = async () => {
    try {
      setVisitorLoading(true);
      const response = await api.get("/analytics/visitor/stats");
      setVisitorStats(response.data.data);
      setVisitorError(null);
    } catch (err: any) {
      setVisitorError(
        err.response?.data?.error || t("home:analytics.errors.loadFailed")
      );
      console.error("Visitor stats fetch error:", err);
    } finally {
      setVisitorLoading(false);
    }
  };

  const handleRefresh = async () => {
    if (activeTab === "visitors") {
      await fetchVisitorStats();
      return;
    }
    try {
      setLoading(true);
      await api.post("/analytics/refresh");
      await fetchAnalytics();
    } catch (err) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setError(
        axiosErr.response?.data?.error ||
          t("home:analytics.errors.refreshFailed")
      );
      console.error("Analytics refresh error:", err);
      setLoading(false);
    }
  };

  const dateLocale = i18n.language === "zh" ? "zh-CN" : "en-US";

  // Format data for charts (reverse to show oldest to newest)
  const chartData = [...stats].reverse().map((stat) => ({
    date: new Date(stat.stat_date).toLocaleDateString(dateLocale, {
      month: "short",
      day: "numeric",
    }),
    loginUsers: stat.login_users_count,
    activeUsers: stat.active_users_count,
    newUsers: stat.new_users_count,
    simulations: stat.total_simulations_count,
    simulationEvents: stat.total_simulation_events_count,
    avgSimsPerUser: Number(stat.avg_simulations_per_active_user.toFixed(1)),
    newMods: stat.total_new_mods_count,
  }));

  const modChartData = [...stats].reverse().map((stat) => ({
    date: new Date(stat.stat_date).toLocaleDateString(dateLocale, {
      month: "short",
      day: "numeric",
    }),
    short: stat.new_mods_short_count,
    medium: stat.new_mods_medium_count,
    long: stat.new_mods_long_count,
  }));

  const metricLabels = useMemo(
    () => ({
      loginUsers: t("home:analytics.metrics.loginUsers"),
      activeUsers: t("home:analytics.metrics.activeUsers"),
      newUsers: t("home:analytics.metrics.newUsers"),
      simulations: t("home:analytics.metrics.simulations"),
      simulationEvents: t("home:analytics.metrics.simulationEvents"),
      avgSimsPerUser: t("home:analytics.metrics.avgSimsPerUser"),
      newMods: t("home:analytics.metrics.newMods"),
      short: t("home:analytics.length.short"),
      medium: t("home:analytics.length.medium"),
      long: t("home:analytics.length.long"),
    }),
    [t]
  );

  const formatMetric = (value: string): string =>
    metricLabels[value as keyof typeof metricLabels] || value;

  const todayStats = stats[0];
  const formatDateTime = (isoString: string): string =>
    new Date(isoString).toLocaleString(dateLocale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: i18n.language !== "zh",
    });

  const isLoading = activeTab === "usage" ? loading : visitorLoading;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.5)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        padding: "20px",
      }}
      onClick={onClose}
      onKeyDown={(e) => e.key === "Escape" && onClose()}
      role="presentation"
    >
      <div
        style={{
          backgroundColor: "white",
          borderRadius: "16px",
          maxWidth: "1200px",
          width: "100%",
          maxHeight: "90vh",
          overflow: "auto",
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div
          style={{
            padding: "24px 32px",
            borderBottom: "1px solid #e5e7eb",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            position: "sticky",
            top: 0,
            backgroundColor: "white",
            borderTopLeftRadius: "16px",
            borderTopRightRadius: "16px",
            zIndex: 10,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: "24px",
              fontWeight: "700",
              fontFamily: "var(--serif)",
              color: "var(--title)",
            }}
          >
            {t("home:analytics.title")}
          </h2>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                backgroundColor: "white",
                cursor: isLoading ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: "600",
                color: "#374151",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                if (!isLoading)
                  e.currentTarget.style.backgroundColor = "#f3f4f6";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "white";
              }}
            >
              {isLoading
                ? t("home:analytics.actions.refreshing")
                : t("home:analytics.actions.refresh")}
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: "#ef4444",
                color: "white",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: "600",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = "#dc2626";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "#ef4444";
              }}
            >
              {t("common:button.close")}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: "flex",
            borderBottom: "1px solid #e5e7eb",
            padding: "0 32px",
            position: "sticky",
            top: "73px",
            backgroundColor: "white",
            zIndex: 10,
          }}
        >
          {(["usage", "visitors"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "12px 24px",
                border: "none",
                borderBottom:
                  activeTab === tab
                    ? "2px solid #3b82f6"
                    : "2px solid transparent",
                backgroundColor: "transparent",
                cursor: "pointer",
                fontSize: "14px",
                fontWeight: activeTab === tab ? "600" : "400",
                color: activeTab === tab ? "#3b82f6" : "#6b7280",
                transition: "all 0.2s",
              }}
            >
              {t(`home:analytics.tabs.${tab}`)}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ padding: "32px" }}>
          {activeTab === "usage" ? (
            <UsageTab
              stats={stats}
              accumulated={accumulated}
              topUsersToday={topUsersToday}
              todayStats={todayStats}
              recent48h={recent48h}
              chartData={chartData}
              modChartData={modChartData}
              loading={loading}
              error={error}
              formatMetric={formatMetric}
              formatDateTime={formatDateTime}
              t={t}
            />
          ) : (
            <VisitorTab
              data={visitorStats}
              loading={visitorLoading}
              error={visitorError}
              t={t}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Usage Tab (existing content) ──────────────────────────────────

function UsageTab({
  stats,
  accumulated,
  topUsersToday,
  todayStats,
  recent48h,
  chartData,
  modChartData,
  loading,
  error,
  formatMetric,
  formatDateTime,
  t,
}: {
  stats: DailyStats[];
  accumulated: AccumulatedStats | null;
  topUsersToday: TopUserSimulations[];
  todayStats: DailyStats | undefined;
  recent48h: WindowStats | null;
  chartData: ChartEntry[];
  modChartData: ModChartEntry[];
  loading: boolean;
  error: string | null;
  formatMetric: (v: string) => string;
  formatDateTime: (v: string) => string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  return (
    <>
      {error && (
        <div
          style={{
            padding: "16px",
            backgroundColor: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "8px",
            color: "#dc2626",
            marginBottom: "24px",
          }}
        >
          {error}
        </div>
      )}

      {loading && stats.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <div
            style={{
              fontSize: "18px",
              color: "#6b7280",
              fontFamily: "var(--serif)",
            }}
          >
            {t("home:analytics.states.loading")}
          </div>
        </div>
      ) : stats.length === 0 ? (
        <div style={{ textAlign: "center", padding: "60px 0" }}>
          <div
            style={{
              fontSize: "18px",
              color: "#6b7280",
              fontFamily: "var(--serif)",
            }}
          >
            {t("home:analytics.states.empty")}
          </div>
        </div>
      ) : (
        <>
          {/* Accumulated Summary Cards */}
          {accumulated && (
            <div style={{ marginBottom: "32px" }}>
              <h3
                style={{
                  fontSize: "18px",
                  fontWeight: "700",
                  marginBottom: "16px",
                  fontFamily: "var(--serif)",
                  color: "var(--title)",
                }}
              >
                {t("home:analytics.accumulatedSummary")}
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "16px",
                }}
              >
                <StatCard
                  label={t("home:analytics.metrics.accumulatedUsers")}
                  value={accumulated.accumulated_users_count}
                  color="#0ea5e9"
                />
                <StatCard
                  label={t("home:analytics.metrics.accumulatedSimulations")}
                  value={accumulated.accumulated_simulations_count}
                  color="#f97316"
                />
              </div>
            </div>
          )}

          {/* Today's Top 5 Users */}
          {topUsersToday.length > 0 && (
            <div style={{ marginBottom: "32px" }}>
              <h3
                style={{
                  fontSize: "18px",
                  fontWeight: "700",
                  marginBottom: "16px",
                  fontFamily: "var(--serif)",
                  color: "var(--title)",
                }}
              >
                {t("home:analytics.todayTopUsers")}
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  gap: "16px",
                }}
              >
                {topUsersToday.slice(0, 5).map((user, index) => {
                  const name = user.username?.trim();
                  const displayLabel =
                    name && name !== user.email
                      ? `${index + 1}. ${name} (${user.email})`
                      : `${index + 1}. ${user.email}`;

                  return (
                    <StatCard
                      key={`${user.email}-${index}`}
                      label={displayLabel}
                      value={user.simulations_count}
                      color="#0ea5e9"
                    />
                  );
                })}
              </div>
            </div>
          )}

          {/* Today's Summary Cards */}
          {todayStats && (
            <div style={{ marginBottom: "32px" }}>
              <h3
                style={{
                  fontSize: "18px",
                  fontWeight: "700",
                  marginBottom: "16px",
                  fontFamily: "var(--serif)",
                  color: "var(--title)",
                }}
              >
                {t("home:analytics.todaySummary", {
                  date: todayStats.stat_date,
                })}
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "16px",
                }}
              >
                <StatCard
                  label={t("home:analytics.metrics.loginUsers")}
                  value={todayStats.login_users_count}
                  color="#3b82f6"
                />
                <StatCard
                  label={t("home:analytics.metrics.activeUsers")}
                  value={todayStats.active_users_count}
                  color="#10b981"
                />
                <StatCard
                  label={t("home:analytics.metrics.newUsers")}
                  value={todayStats.new_users_count}
                  color="#8b5cf6"
                />
                <StatCard
                  label={t("home:analytics.metrics.totalSimulations")}
                  value={todayStats.total_simulations_count}
                  color="#f59e0b"
                />
                <StatCard
                  label={t("home:analytics.metrics.simulationEvents")}
                  value={todayStats.total_simulation_events_count}
                  color="#06b6d4"
                />
                <StatCard
                  label={t("home:analytics.metrics.avgSimsPerUser")}
                  value={todayStats.avg_simulations_per_active_user.toFixed(1)}
                  color="#8b5cf6"
                />
                <StatCard
                  label={t("home:analytics.metrics.newMods")}
                  value={todayStats.total_new_mods_count}
                  color="#ec4899"
                />
              </div>
            </div>
          )}

          {/* Recent 48 Hours Summary Cards */}
          {recent48h && (
            <div style={{ marginBottom: "32px" }}>
              <h3
                style={{
                  fontSize: "18px",
                  fontWeight: "700",
                  marginBottom: "16px",
                  fontFamily: "var(--serif)",
                  color: "var(--title)",
                }}
              >
                {t("home:analytics.recent48hSummary", {
                  start: formatDateTime(recent48h.window_start),
                  end: formatDateTime(recent48h.window_end),
                })}
              </h3>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "16px",
                }}
              >
                <StatCard
                  label={t("home:analytics.metrics.loginUsers")}
                  value={recent48h.login_users_count}
                  color="#3b82f6"
                />
                <StatCard
                  label={t("home:analytics.metrics.activeUsers")}
                  value={recent48h.active_users_count}
                  color="#10b981"
                />
                <StatCard
                  label={t("home:analytics.metrics.newUsers")}
                  value={recent48h.new_users_count}
                  color="#8b5cf6"
                />
                <StatCard
                  label={t("home:analytics.metrics.totalSimulations")}
                  value={recent48h.total_simulations_count}
                  color="#f59e0b"
                />
                <StatCard
                  label={t("home:analytics.metrics.simulationEvents")}
                  value={recent48h.total_simulation_events_count}
                  color="#06b6d4"
                />
                <StatCard
                  label={t("home:analytics.metrics.avgSimsPerUser")}
                  value={recent48h.avg_simulations_per_active_user.toFixed(1)}
                  color="#8b5cf6"
                />
                <StatCard
                  label={t("home:analytics.metrics.newMods")}
                  value={recent48h.total_new_mods_count}
                  color="#ec4899"
                />
                <StatCard
                  label={t("home:analytics.metrics.newModsShort")}
                  value={recent48h.new_mods_short_count}
                  color="#22c55e"
                />
                <StatCard
                  label={t("home:analytics.metrics.newModsMedium")}
                  value={recent48h.new_mods_medium_count}
                  color="#f97316"
                />
                <StatCard
                  label={t("home:analytics.metrics.newModsLong")}
                  value={recent48h.new_mods_long_count}
                  color="#ef4444"
                />
              </div>
            </div>
          )}

          {/* User Activity Chart */}
          <div style={{ marginBottom: "32px" }}>
            <h3
              style={{
                fontSize: "18px",
                fontWeight: "700",
                marginBottom: "16px",
                fontFamily: "var(--serif)",
                color: "var(--title)",
              }}
            >
              {t("home:analytics.charts.userActivity")}
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip
                  formatter={(value, name) => [
                    value,
                    formatMetric(String(name)),
                  ]}
                />
                <Legend formatter={(value) => formatMetric(String(value))} />
                <Line
                  type="monotone"
                  dataKey="loginUsers"
                  stroke="#3b82f6"
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="activeUsers"
                  stroke="#10b981"
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="newUsers"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Simulation Activity Chart */}
          <div style={{ marginBottom: "32px" }}>
            <h3
              style={{
                fontSize: "18px",
                fontWeight: "700",
                marginBottom: "16px",
                fontFamily: "var(--serif)",
                color: "var(--title)",
              }}
            >
              {t("home:analytics.charts.simulationActivity")}
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis />
                <Tooltip
                  formatter={(value, name) => [
                    value,
                    formatMetric(String(name)),
                  ]}
                />
                <Legend formatter={(value) => formatMetric(String(value))} />
                <Line
                  type="monotone"
                  dataKey="simulations"
                  stroke="#f59e0b"
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="simulationEvents"
                  stroke="#06b6d4"
                  strokeWidth={2}
                />
                <Line
                  type="monotone"
                  dataKey="avgSimsPerUser"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Module Generation Chart */}
          {modChartData.some((d) => d.short + d.medium + d.long > 0) && (
            <div style={{ marginBottom: "32px" }}>
              <h3
                style={{
                  fontSize: "18px",
                  fontWeight: "700",
                  marginBottom: "16px",
                  fontFamily: "var(--serif)",
                  color: "var(--title)",
                }}
              >
                {t("home:analytics.charts.moduleGeneration")}
              </h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={modChartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <Tooltip
                    formatter={(value, name) => [
                      value,
                      formatMetric(String(name)),
                    ]}
                  />
                  <Legend formatter={(value) => formatMetric(String(value))} />
                  <Bar dataKey="short" fill="#10b981" />
                  <Bar dataKey="medium" fill="#f59e0b" />
                  <Bar dataKey="long" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
    </>
  );
}

// ─── Visitor Tab ───────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function VisitorTab({
  data,
  loading,
  error,
  t,
}: {
  data: VisitorStatsData | null;
  loading: boolean;
  error: string | null;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  if (error) {
    return (
      <div
        style={{
          padding: "16px",
          backgroundColor: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "8px",
          color: "#dc2626",
        }}
      >
        {error}
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div style={{ textAlign: "center", padding: "60px 0" }}>
        <div
          style={{
            fontSize: "18px",
            color: "#6b7280",
            fontFamily: "var(--serif)",
          }}
        >
          {t("home:analytics.states.loading")}
        </div>
      </div>
    );
  }

  if (data.today.totalVisits === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 0" }}>
        <div
          style={{
            fontSize: "18px",
            color: "#6b7280",
            fontFamily: "var(--serif)",
          }}
        >
          {t("home:analytics.visitors.noData")}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Today summary cards */}
      <div style={{ marginBottom: "32px" }}>
        <h3
          style={{
            fontSize: "18px",
            fontWeight: "700",
            marginBottom: "16px",
            fontFamily: "var(--serif)",
            color: "var(--title)",
          }}
        >
          {t("home:analytics.visitors.todaySummary")}
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "16px",
          }}
        >
          <StatCard
            label={t("home:analytics.visitors.totalVisits")}
            value={data.today.totalVisits}
            color="#3b82f6"
          />
          <StatCard
            label={t("home:analytics.visitors.avgDuration")}
            value={formatDuration(data.today.avgDurationSeconds)}
            color="#10b981"
          />
        </div>
      </div>

      {/* Hourly line chart */}
      <div style={{ marginBottom: "32px" }}>
        <h3
          style={{
            fontSize: "18px",
            fontWeight: "700",
            marginBottom: "16px",
            fontFamily: "var(--serif)",
            color: "var(--title)",
          }}
        >
          {t("home:analytics.visitors.hourlyChart")}
        </h3>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data.hourly}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="hour" tickFormatter={(h) => `${h}:00`} />
            <YAxis allowDecimals={false} />
            <Tooltip
              labelFormatter={(h) => `${h}:00`}
              formatter={(value: number) => [
                value,
                t("home:analytics.visitors.visitCount"),
              ]}
            />
            <Line
              type="monotone"
              dataKey="count"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Per-IP table */}
      <div style={{ marginBottom: "32px" }}>
        <h3
          style={{
            fontSize: "18px",
            fontWeight: "700",
            marginBottom: "16px",
            fontFamily: "var(--serif)",
            color: "var(--title)",
          }}
        >
          {t("home:analytics.visitors.ipTable")}
        </h3>
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: "12px",
            overflow: "auto",
            maxHeight: "400px",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "14px",
            }}
          >
            <thead>
              <tr
                style={{
                  backgroundColor: "#f9fafb",
                  position: "sticky",
                  top: 0,
                }}
              >
                <th
                  style={{
                    padding: "12px 16px",
                    textAlign: "left",
                    fontWeight: "600",
                    color: "#374151",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  {t("home:analytics.visitors.ip")}
                </th>
                <th
                  style={{
                    padding: "12px 16px",
                    textAlign: "right",
                    fontWeight: "600",
                    color: "#374151",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  {t("home:analytics.visitors.visitCount")}
                </th>
                <th
                  style={{
                    padding: "12px 16px",
                    textAlign: "right",
                    fontWeight: "600",
                    color: "#374151",
                    borderBottom: "1px solid #e5e7eb",
                  }}
                >
                  {t("home:analytics.visitors.avgDurationCol")}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.byIp.map((row) => (
                <tr key={row.ip} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td
                    style={{
                      padding: "10px 16px",
                      color: "#111827",
                      fontFamily: "monospace",
                    }}
                  >
                    {row.ip}
                  </td>
                  <td
                    style={{
                      padding: "10px 16px",
                      textAlign: "right",
                      color: "#374151",
                    }}
                  >
                    {row.visitCount}
                  </td>
                  <td
                    style={{
                      padding: "10px 16px",
                      textAlign: "right",
                      color: "#374151",
                    }}
                  >
                    {formatDuration(row.avgDurationSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ─── Shared Components ─────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div
      style={{
        padding: "20px",
        backgroundColor: "white",
        border: "1px solid #e5e7eb",
        borderRadius: "12px",
        boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)",
      }}
    >
      <div
        style={{
          fontSize: "14px",
          color: "#6b7280",
          marginBottom: "8px",
          fontWeight: "500",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "32px",
          fontWeight: "700",
          color: color,
          fontFamily: "var(--serif)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
