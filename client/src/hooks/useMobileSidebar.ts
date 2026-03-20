import { useEffect, useState } from "react";

export const useMobileSidebar = () => {
  const [isMobile, setIsMobile] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    return !window.matchMedia("(max-width: 768px)").matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 768px)");

    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
      // Auto-open sidebar when switching to desktop
      if (!e.matches) {
        setIsSidebarOpen(true);
      }
    };

    // Initial check
    handleChange(mediaQuery);

    // Listen for changes
    mediaQuery.addEventListener("change", handleChange);

    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  const toggleSidebar = () => setIsSidebarOpen((prev) => !prev);
  const closeSidebar = () => setIsSidebarOpen(false);

  return { isMobile, isSidebarOpen, toggleSidebar, closeSidebar };
};
