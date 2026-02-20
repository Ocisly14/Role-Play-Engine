import type React from "react";

interface SidebarToggleButtonProps {
  onClick: () => void;
}

export const SidebarToggleButton: React.FC<SidebarToggleButtonProps> = ({
  onClick,
}) => {
  return (
    <button
      onClick={onClick}
      className="sidebar-toggle-btn"
      aria-label="Open sidebar"
    >
      <div className="sidebar-toggle-icon">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span>Menu</span>
    </button>
  );
};
