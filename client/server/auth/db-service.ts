import Database from 'better-sqlite3';
import { hashPassword, verifyPassword } from './password.js';
import { generateAccessToken, generateRefreshToken } from './jwt.js';
import { emailService } from '../email/service.js';
import crypto from 'crypto';
import path from 'path';
import { randomUUID } from 'crypto';

// Get database instance from CoCDatabase singleton
import { CoCDatabase } from '../../../src/coc_multiagents_system/agents/memory/database/schema.js';

// Create a singleton instance
let dbInstance: CoCDatabase | null = null;

function getDB(): Database.Database {
  if (!dbInstance) {
    dbInstance = new CoCDatabase();
  }
  return dbInstance.getDatabase();
}

export interface User {
  id: string;
  email: string;
  username?: string | null;
  password_hash: string;
  is_email_verified: boolean;
  is_active: boolean;
  role: string;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
}

export const authDbService = {
  // User registration
  async register(data: {
    email: string;
    password: string;
    username?: string;
  }) {
    const db = getDB();

    // Check if email already exists
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(data.email);

    if (existing) {
      throw new Error('Email already registered');
    }

    const userId = randomUUID();
    const passwordHash = await hashPassword(data.password);

    // Create user
    db.prepare(`
      INSERT INTO users (id, email, username, password_hash, is_email_verified, is_active, role)
      VALUES (?, ?, ?, ?, 0, 1, 'USER')
    `).run(userId, data.email, data.username || null, passwordHash);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;

    // Send verification email
    await this.sendEmailVerification(userId);

    return {
      user: this.sanitizeUser(user),
      message: 'Registration successful. Please check your email to verify your account.',
    };
  },

  // User login
  async login(data: {
    email: string;
    password: string;
    rememberMe?: boolean;
  }) {
    const db = getDB();

    // Find user
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(data.email) as User | undefined;

    if (!user) {
      throw new Error('Invalid email or password');
    }

    // Verify password
    const isValidPassword = await verifyPassword(data.password, user.password_hash);

    if (!isValidPassword) {
      throw new Error('Invalid email or password');
    }

    // Check account status
    if (!user.is_active) {
      throw new Error('Account is disabled');
    }

    // Update last login time
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    // Generate tokens
    const accessToken = generateAccessToken(user);
    let refreshToken: string | undefined;

    if (data.rememberMe) {
      refreshToken = generateRefreshToken(user);

      // Save refresh token
      const tokenId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO refresh_tokens (id, user_id, token, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenId, user.id, refreshToken, expiresAt);
    }

    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  },

  // Send email verification
  async sendEmailVerification(userId: string) {
    const db = getDB();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;

    if (!user) {
      throw new Error('User not found');
    }

    if (user.is_email_verified) {
      throw new Error('Email already verified');
    }

    // Generate verification token
    const token = crypto.randomBytes(32).toString('hex');
    const verificationId = randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Save to database
    db.prepare(`
      INSERT INTO email_verifications (id, user_id, token, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(verificationId, user.id, token, expiresAt);

    // Send email
    await emailService.sendVerificationEmail(user.email, token);

    return { message: 'Verification email sent' };
  },

  // Verify email
  async verifyEmail(token: string) {
    const db = getDB();

    const verification = db.prepare(`
      SELECT ev.*, u.email
      FROM email_verifications ev
      JOIN users u ON ev.user_id = u.id
      WHERE ev.token = ?
    `).get(token) as any;

    if (!verification) {
      throw new Error('Invalid verification token');
    }

    if (verification.is_used) {
      throw new Error('Token already used');
    }

    if (new Date(verification.expires_at) < new Date()) {
      throw new Error('Token expired');
    }

    // Update user status
    db.prepare('UPDATE users SET is_email_verified = 1 WHERE id = ?').run(verification.user_id);

    // Mark token as used
    db.prepare('UPDATE email_verifications SET is_used = 1 WHERE id = ?').run(verification.id);

    return { message: 'Email verified successfully' };
  },

  // Request password reset
  async requestPasswordReset(email: string) {
    const db = getDB();

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;

    if (!user) {
      // Don't reveal if user exists
      return { message: 'If the email exists, a reset link has been sent' };
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString('hex');
    const resetId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // Save to database
    db.prepare(`
      INSERT INTO password_resets (id, user_id, token, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(resetId, user.id, token, expiresAt);

    // Send email
    await emailService.sendPasswordResetEmail(user.email, token);

    return { message: 'If the email exists, a reset link has been sent' };
  },

  // Reset password
  async resetPassword(token: string, newPassword: string) {
    const db = getDB();

    const reset = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token) as any;

    if (!reset) {
      throw new Error('Invalid reset token');
    }

    if (reset.is_used) {
      throw new Error('Token already used');
    }

    if (new Date(reset.expires_at) < new Date()) {
      throw new Error('Token expired');
    }

    // Update password
    const passwordHash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, reset.user_id);

    // Mark token as used
    db.prepare('UPDATE password_resets SET is_used = 1 WHERE id = ?').run(reset.id);

    // Revoke all refresh tokens
    db.prepare('UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?').run(reset.user_id);

    return { message: 'Password reset successfully' };
  },

  // Refresh access token
  async refreshAccessToken(refreshToken: string) {
    const db = getDB();

    const token = db.prepare(`
      SELECT rt.*, u.*
      FROM refresh_tokens rt
      JOIN users u ON rt.user_id = u.id
      WHERE rt.token = ?
    `).get(refreshToken) as any;

    if (!token || token.is_revoked || new Date(token.expires_at) < new Date()) {
      throw new Error('Invalid or expired refresh token');
    }

    const user: User = {
      id: token.user_id,
      email: token.email,
      username: token.username,
      password_hash: token.password_hash,
      is_email_verified: Boolean(token.is_email_verified),
      is_active: Boolean(token.is_active),
      role: token.role,
      created_at: token.created_at,
      updated_at: token.updated_at,
      last_login_at: token.last_login_at,
    };

    const accessToken = generateAccessToken(user);

    return { accessToken };
  },

  // Get user by ID
  async getUserById(userId: string) {
    const db = getDB();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;

    if (!user) {
      throw new Error('User not found');
    }

    return this.sanitizeUser(user);
  },

  // Change password
  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const db = getDB();

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;

    if (!user) {
      throw new Error('User not found');
    }

    // Verify old password
    const isValid = await verifyPassword(oldPassword, user.password_hash);
    if (!isValid) {
      throw new Error('Invalid old password');
    }

    // Update password
    const passwordHash = await hashPassword(newPassword);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);

    // Revoke all refresh tokens
    db.prepare('UPDATE refresh_tokens SET is_revoked = 1 WHERE user_id = ?').run(userId);

    return { message: 'Password changed successfully' };
  },

  // Remove sensitive information
  sanitizeUser(user: User) {
    const { password_hash, ...safeUser } = user;
    return {
      ...safeUser,
      isEmailVerified: Boolean(user.is_email_verified),
      isActive: Boolean(user.is_active),
    };
  },
};
