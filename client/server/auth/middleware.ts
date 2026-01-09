import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from './jwt.js';
import Database from 'better-sqlite3';
import { CoCDatabase } from '../../../src/coc_multiagents_system/agents/memory/database/schema.js';

// Database instance
let dbInstance: CoCDatabase | null = null;

function getDB(): Database.Database {
  if (!dbInstance) {
    dbInstance = new CoCDatabase();
  }
  return dbInstance.getDatabase();
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
        role: string;
      };
    }
  }
}

// Authentication middleware
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Get token from Header or Cookie
    const token =
      req.headers.authorization?.replace('Bearer ', '') ||
      req.cookies?.accessToken;

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Verify token
    const payload = verifyToken(token);

    // Check if user exists and is active
    const db = getDB();
    const user = db.prepare(`
      SELECT id, email, role, is_active
      FROM users
      WHERE id = ?
    `).get(payload.userId) as any;

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Invalid user' });
    }

    // Attach user info to request
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
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
      req.headers.authorization?.replace('Bearer ', '') ||
      req.cookies?.accessToken;

    if (token) {
      const payload = verifyToken(token);
      req.user = payload;
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
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    next();
  };
}
