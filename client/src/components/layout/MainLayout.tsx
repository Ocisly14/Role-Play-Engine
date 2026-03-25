import type React from "react";
import { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext";
import { useGameSession } from "../../hooks/useGameSession";
import { Analytics } from "../Analytics";
import { UserMenu } from "./UserMenu";

export const MainLayout: React.FC = () => {
  const { user, logout } = useAuth();
  const gameSession = useGameSession();
  const { clearSession } = gameSession;
  const [showAnalytics, setShowAnalytics] = useState(false);
  const location = useLocation();

  const handleLogout = async () => {
    try {
      await logout();
      clearSession();
    } catch (error) {
      console.error("Error logging out:", error);
    }
  };

  // Hide UserMenu on game page (mobile only)
  const isGamePage = location.pathname === "/game";

  return (
    <>
      <div className={isGamePage ? "hide-user-menu-mobile" : ""}>
        <UserMenu
          user={user}
          onLogout={handleLogout}
          onShowAnalytics={() => setShowAnalytics(true)}
        />
      </div>

      <Outlet />

      {showAnalytics && <Analytics onClose={() => setShowAnalytics(false)} />}

      <style>{`
        .close-button {
          position: absolute;
          top: 1.5rem;
          right: 1.5rem;
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          background: rgba(255, 255, 255, 0.3);
          border: 1px solid rgba(226, 232, 240, 0.8);
          color: rgba(0, 0, 0, 0.7);
          border-radius: 0.75rem;
          width: 40px;
          height: 40px;
          font-size: 1.5rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10;
          transition: all 0.2s ease-in-out;
          opacity: 0.7;
          box-shadow: 0 2px 4px -1px rgba(0, 0, 0, 0.1);
        }

        .close-button:hover {
          opacity: 1;
          background: rgba(255, 255, 255, 0.5);
          border-color: rgba(203, 213, 225, 1);
        }
      `}</style>
    </>
  );
};
