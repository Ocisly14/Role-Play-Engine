import React, { useState } from "react";

interface User {
  email: string;
  role?: string;
}

interface UserMenuProps {
  user: User | null;
  onLogout: () => void;
  onShowAnalytics?: () => void;
}

export const UserMenu: React.FC<UserMenuProps> = ({
  user,
  onLogout,
  onShowAnalytics,
}) => {
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  if (!user) {
    return null;
  }

  return (
    <>
      <div
        style={{
          position: "fixed",
          top: "20px",
          right: "20px",
          zIndex: 5000,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: "10px",
        }}
      >
        <button
          onClick={() => setIsUserMenuOpen((prev) => !prev)}
          className="backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-xl px-3 py-2 hover:bg-white/70 transition-all"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            maxWidth: "220px",
            fontFamily: "var(--serif)",
            letterSpacing: "0.5px",
            color: "var(--title)",
            fontSize: "0.85rem",
            fontWeight: "700",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = "translateY(-2px)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "translateY(0)";
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user.email.split("@")[0]}
          </span>
          <span
            style={{
              fontSize: "0.8rem",
              opacity: 0.9,
              transition: "transform 0.3s ease",
              transform: isUserMenuOpen ? "rotate(180deg)" : "rotate(0deg)",
              display: "inline-block",
            }}
          >
            ▼
          </span>
        </button>
        {isUserMenuOpen && (
          <div
            className="backdrop-blur-sm bg-white/50 border border-slate-200 shadow-xl rounded-xl"
            style={{
              width: "240px",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              animation: "dropdownSlideIn 0.3s ease-out",
            }}
          >
            <div
              style={{
                fontSize: "0.9rem",
                color: "var(--title)",
                borderBottom: "1px solid rgba(226, 232, 240, 0.6)",
                paddingBottom: "10px",
                wordBreak: "break-all",
                fontFamily: "var(--serif)",
                fontWeight: "600",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "#888",
                  marginBottom: "4px",
                }}
              >
                Signed in as:
              </div>
              {user.email}
            </div>
            {user.role === "ADMIN" && onShowAnalytics && (
              <button
                onClick={() => {
                  console.log("Analytics button clicked");
                  onShowAnalytics();
                  setIsUserMenuOpen(false);
                }}
                className="backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-4 py-3 hover:bg-white/70 transition-all"
                style={{
                  fontWeight: "700",
                  fontSize: "0.95rem",
                  cursor: "pointer",
                  fontFamily: "var(--serif)",
                  letterSpacing: "1px",
                  textTransform: "uppercase",
                  color: "#3b82f6",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-2px)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "translateY(0)";
                }}
              >
                Analytics
              </button>
            )}
            <button
              onClick={() => {
                onLogout();
                setIsUserMenuOpen(false);
              }}
              className="backdrop-blur-sm bg-white/50 border border-slate-200 shadow-md rounded-lg px-4 py-3 hover:bg-white/70 transition-all"
              style={{
                fontWeight: "700",
                fontSize: "0.95rem",
                cursor: "pointer",
                fontFamily: "var(--serif)",
                letterSpacing: "1px",
                textTransform: "uppercase",
                color: "var(--title)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-2px)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "translateY(0)";
              }}
            >
              Logout
            </button>
          </div>
        )}
      </div>
      <style>{`
        @keyframes dropdownSlideIn {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </>
  );
};
