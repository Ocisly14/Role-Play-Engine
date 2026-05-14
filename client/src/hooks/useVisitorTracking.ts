import { useEffect, useRef } from "react";

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
const ACTIVITY_EVENTS = ["click", "scroll", "keydown", "mousemove"] as const;

function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Tracks visitor sessions via activity-triggered heartbeats.
 * Place in App.tsx so it covers all pages including unauthenticated ones.
 */
export function useVisitorTracking() {
  const sessionIdRef = useRef<string | null>(null);
  const isActiveRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const sessionId = generateSessionId();
    sessionIdRef.current = sessionId;

    // Create session
    fetch("/api/analytics/visitor/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {
      // Silently ignore — analytics should never break the app
    });

    // Activity listener
    const onActivity = () => {
      isActiveRef.current = true;
    };

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }

    // Heartbeat interval
    intervalRef.current = setInterval(() => {
      if (isActiveRef.current && sessionIdRef.current) {
        isActiveRef.current = false;
        fetch("/api/analytics/visitor/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        }).catch(() => {
          // Silently ignore
        });
      }
    }, HEARTBEAT_INTERVAL);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);
}
