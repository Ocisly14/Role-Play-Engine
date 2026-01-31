import type { Request } from "express";
import { randomUUID } from "crypto";

/**
 * Get client IP address from request
 * Handles proxied requests via x-forwarded-for header
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = forwarded
    ? (typeof forwarded === "string" ? forwarded.split(",")[0] : forwarded[0])
    : req.socket.remoteAddress || req.ip || "127.0.0.1";
  return ip.trim();
}

/**
 * Generate unique sessionId based on timestamp and UUID
 */
export function generateSessionIdFromIp(ip: string): string {
  return `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
