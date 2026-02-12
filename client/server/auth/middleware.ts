/// <reference path="../types/express.d.ts" />
import type { Request, Response, NextFunction } from "express";
import { generateAccessToken, verifyToken } from "./jwt.js";
import { runWithTokenContext } from "../../../src/models/index.js";
import { authDbService } from "./db-service.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

// Authentication middleware
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Get token from Header or Cookie
    const token =
      req.headers.authorization?.replace("Bearer ", "") ||
      req.cookies?.accessToken;

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    // Verify token
    const payload = verifyToken(token);

    // Check if user exists and is active
    const prisma = getPrismaClient();
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, role: true, isActive: true },
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: "Invalid user" });
    }

    // Sliding session: touch refresh token if provided
    const refreshTokenHeader = req.headers["x-refresh-token"];
    if (typeof refreshTokenHeader === "string" && refreshTokenHeader) {
      await authDbService.touchRefreshToken(refreshTokenHeader, payload.email);
    }

    // Issue a fresh access token for sliding expiration
    const nextAccessToken = generateAccessToken({
      id: user.id,
      email: user.email,
      role: user.role,
    });
    res.setHeader("x-access-token", nextAccessToken);

    // Attach user info to request
    req.user = payload;
    return runWithTokenContext({ email: payload.email }, () => next());
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Optional authentication middleware (doesn't require login)
export async function optionalAuthenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const token =
      req.headers.authorization?.replace("Bearer ", "") ||
      req.cookies?.accessToken;

    if (token) {
      const payload = verifyToken(token);
      req.user = payload;
      return runWithTokenContext({ email: payload.email }, () => next());
    }
  } catch (error) {
    // Ignore error, continue
  }
  next();
}

// Role-based authorization middleware
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    next();
  };
}
