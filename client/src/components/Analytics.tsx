import React, { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { api } from "../services/api";

interface DailyStats {
  id: string;
  stat_date: string;
  login_users_count: number;
  active_users_count: number;
  new_users_count: number;
  total_messages_count: number;
  avg_messages_per_active_user: number;
  new_mods_short_count: number;
  new_mods_medium_count: number;
  new_mods_long_count: number;
  total_new_mods_count: number;
  created_at: string;
  updated_at: string;
}

interface AnalyticsProps {
  onClose: () => void;
}

export function Analytics({ onClose }: AnalyticsProps) {
  const [stats, setStats] = useState<DailyStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      setLoading(true);
      const response = await api.get("/analytics/daily?days=30");
      setStats(response.data.history || []);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to load analytics");
      console.error("Analytics fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleRefresh = async () => {
    try {
      setLoading(true);
      await api.post("/analytics/refresh");
      await fetchAnalytics();
    } catch (err: any) {
      setError(err.response?.data?.error || "Failed to refresh analytics");
      console.error("Analytics refresh error:", err);
      setLoading(false);
    }
  };

  // Format data for charts (reverse to show oldest to newest)
  const chartData = [...stats].reverse().map((stat) => ({
    date: new Date(stat.stat_date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    "Login Users": stat.login_users_count,
    "Active Users": stat.active_users_count,
    "New Users": stat.new_users_count,
    Messages: stat.total_messages_count,
    "Avg Msgs/User": Number(stat.avg_messages_per_active_user.toFixed(1)),
    "New Mods": stat.total_new_mods_count,
  }));

  const modChartData = [...stats].reverse().map((stat) => ({
    date: new Date(stat.stat_date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
    Short: stat.new_mods_short_count,
    Medium: stat.new_mods_medium_count,
    Long: stat.new_mods_long_count,
  }));

  const todayStats = stats[0];

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
            Analytics Dashboard
          </h2>
          <div style={{ display: "flex", gap: "12px" }}>
            <button
              onClick={handleRefresh}
              disabled={loading}
              style={{
                padding: "8px 16px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                backgroundColor: "white",
                cursor: loading ? "not-allowed" : "pointer",
                fontSize: "14px",
                fontWeight: "600",
                color: "#374151",
                transition: "all 0.2s",
              }}
              onMouseEnter={(e) => {
                if (!loading) e.currentTarget.style.backgroundColor = "#f3f4f6";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = "white";
              }}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button
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
              Close
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={{ padding: "32px" }}>
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
                Loading analytics...
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
                No analytics data available yet
              </div>
            </div>
          ) : (
            <>
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
                    Today's Summary ({todayStats.stat_date})
                  </h3>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                      gap: "16px",
                    }}
                  >
                    <StatCard
                      label="Login Users"
                      value={todayStats.login_users_count}
                      color="#3b82f6"
                    />
                    <StatCard
                      label="Active Users"
                      value={todayStats.active_users_count}
                      color="#10b981"
                    />
                    <StatCard
                      label="New Users"
                      value={todayStats.new_users_count}
                      color="#8b5cf6"
                    />
                    <StatCard
                      label="Total Messages"
                      value={todayStats.total_messages_count}
                      color="#f59e0b"
                    />
                    <StatCard
                      label="Avg Msgs/User"
                      value={todayStats.avg_messages_per_active_user.toFixed(1)}
                      color="#06b6d4"
                    />
                    <StatCard
                      label="New Mods"
                      value={todayStats.total_new_mods_count}
                      color="#ec4899"
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
                  User Activity Trends
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="Login Users"
                      stroke="#3b82f6"
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="Active Users"
                      stroke="#10b981"
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="New Users"
                      stroke="#8b5cf6"
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Message Activity Chart */}
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
                  Message Activity
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="Messages"
                      stroke="#f59e0b"
                      strokeWidth={2}
                    />
                    <Line
                      type="monotone"
                      dataKey="Avg Msgs/User"
                      stroke="#06b6d4"
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Module Generation Chart */}
              {modChartData.some((d) => d.Short + d.Medium + d.Long > 0) && (
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
                    Module Generations by Length
                  </h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={modChartData}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" />
                      <YAxis />
                      <Tooltip />
                      <Legend />
                      <Bar dataKey="Short" fill="#10b981" />
                      <Bar dataKey="Medium" fill="#f59e0b" />
                      <Bar dataKey="Long" fill="#ef4444" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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
