import crypto from "crypto";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { emailService } from "../email/service.js";
import { generateAccessToken, generateRefreshToken } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";

// Get database instance from CoCDatabase singleton
import { CoCDatabase } from "../../../src/coc_multiagents_system/agents/memory/database/schema.js";

// Create a singleton instance
let dbInstance: CoCDatabase | null = null;

function getDB(): Database.Database {
  if (!dbInstance) {
    dbInstance = new CoCDatabase();
  }
  return dbInstance.getDatabase();
}

const parsedIdleMinutes = Number(
  process.env.SESSION_IDLE_TIMEOUT_MINUTES || 60
);
const IDLE_TIMEOUT_MINUTES =
  Number.isFinite(parsedIdleMinutes) && parsedIdleMinutes > 0
    ? parsedIdleMinutes
    : 60;
const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60 * 1000;

function getIdleExpiresAt(): string {
  return new Date(Date.now() + IDLE_TIMEOUT_MS).toISOString();
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
    referralCode: string;
  }) {
    const db = getDB();

    // Validate referral code (case-insensitive)
    const referralCodeUpper = data.referralCode.toUpperCase();
    const referral = db
      .prepare("SELECT * FROM referral_codes WHERE UPPER(code) = ?")
      .get(referralCodeUpper) as any;

    if (!referral) {
      throw new Error("Invalid referral code");
    }

    // Check usage limit (max_uses = null means unlimited)
    if (referral.max_uses != null) {
      const usage = db
        .prepare(
          "SELECT COUNT(*) as count FROM referral_code_uses WHERE referral_code_id = ?"
        )
        .get(referral.id) as { count: number };
      if (usage.count >= referral.max_uses) {
        throw new Error("Referral code has reached its usage limit");
      }
    }

    // Check if email already exists
    const existing = db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(data.email);

    if (existing) {
      throw new Error("Email already registered");
    }

    const userId = randomUUID();
    const passwordHash = await hashPassword(data.password);

    // Create user
    db.prepare(`
      INSERT INTO users (id, email, username, password_hash, is_email_verified, is_active, role)
      VALUES (?, ?, ?, ?, 0, 1, 'USER')
    `).run(userId, data.email, data.username || null, passwordHash);

    // Record referral code use (permanent codes; track email per use)
    db.prepare(`
      INSERT INTO referral_code_uses (id, referral_code_id, email_id, used_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(randomUUID(), referral.id, data.email);

    const user = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(userId) as User;

    // Send verification email
    await this.sendEmailVerification(data.email);

    return {
      user: this.sanitizeUser(user),
      message:
        "Registration successful. A verification code has been sent to your email.",
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
    const user = db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(data.email) as User | undefined;

    if (!user) {
      throw new Error("Invalid email or password");
    }

    // Verify password
    const isValidPassword = await verifyPassword(
      data.password,
      user.password_hash
    );

    if (!isValidPassword) {
      throw new Error("Invalid email or password");
    }

    // Check account status
    if (!user.is_active) {
      throw new Error("Account is disabled");
    }

    if (!user.is_email_verified) {
      throw new Error("Email not verified. Please verify your email first.");
    }

    // Update last login time
    db.prepare(
      "UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(user.id);

    // Generate tokens
    const accessToken = generateAccessToken(user);
    let refreshToken: string | undefined;

    if (data.rememberMe) {
      refreshToken = generateRefreshToken(user);

      // Save refresh token
      const tokenId = randomUUID();
      const expiresAt = getIdleExpiresAt();

      db.prepare(`
        INSERT INTO refresh_tokens (id, email_id, token, expires_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenId, user.email, refreshToken, expiresAt);
    }

    return {
      user: this.sanitizeUser(user),
      accessToken,
      refreshToken,
    };
  },

  // Send email verification code
  async sendEmailVerification(email: string) {
    const db = getDB();

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | User
      | undefined;

    if (!user) {
      throw new Error("User not found");
    }

    if (user.is_email_verified) {
      throw new Error("Email already verified");
    }

    // Enforce 60-second cooldown between sends
    const recent = db
      .prepare(
        "SELECT created_at FROM email_verifications WHERE email_id = ? AND is_used = 0 ORDER BY created_at DESC LIMIT 1"
      )
      .get(user.email) as { created_at: string } | undefined;

    if (recent && Date.now() - new Date(recent.created_at).getTime() < 60 * 1000) {
      throw new Error("Please wait before requesting a new code");
    }

    // Generate 5-digit verification code
    const code = crypto.randomInt(10000, 100000).toString();
    const verificationId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

    // Save to database
    db.prepare(`
      INSERT INTO email_verifications (id, email_id, token, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(verificationId, user.email, code, expiresAt);

    // Send email with code
    await emailService.sendVerificationEmail(user.email, code);

    return { message: "Verification code sent" };
  },

  // Verify email with 5-digit code
  async verifyEmailCode(email: string, code: string) {
    const db = getDB();

    const verification = db
      .prepare(`
      SELECT * FROM email_verifications
      WHERE email_id = ? AND token = ? AND is_used = 0
    `)
      .get(email, code) as any;

    if (!verification) {
      throw new Error("Invalid verification code");
    }

    if (new Date(verification.expires_at) < new Date()) {
      throw new Error("Verification code has expired");
    }

    // Mark email as verified
    db.prepare("UPDATE users SET is_email_verified = 1 WHERE email = ?").run(
      email
    );

    // Mark code as used
    db.prepare("UPDATE email_verifications SET is_used = 1 WHERE id = ?").run(
      verification.id
    );

    return { message: "Email verified successfully" };
  },

  // Resend verification code (public-safe: never reveals whether email exists)
  async resendEmailVerification(email: string) {
    const db = getDB();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | User
      | undefined;

    if (!user || user.is_email_verified) {
      // Generic message to prevent email enumeration
      return { message: "Verification code sent" };
    }

    await this.sendEmailVerification(email);
    return { message: "Verification code sent" };
  },

  // Request password reset
  async requestPasswordReset(email: string) {
    const db = getDB();

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | User
      | undefined;

    if (!user) {
      // Don't reveal if user exists
      return { message: "If the email exists, a reset link has been sent" };
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString("hex");
    const resetId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // Save to database
    db.prepare(`
      INSERT INTO password_resets (id, email_id, token, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(resetId, user.email, token, expiresAt);

    // Send email
    await emailService.sendPasswordResetEmail(user.email, token);

    return { message: "If the email exists, a reset link has been sent" };
  },

  // Reset password
  async resetPassword(token: string, newPassword: string) {
    const db = getDB();

    const reset = db
      .prepare("SELECT * FROM password_resets WHERE token = ?")
      .get(token) as any;

    if (!reset) {
      throw new Error("Invalid reset token");
    }

    if (reset.is_used) {
      throw new Error("Token already used");
    }

    if (new Date(reset.expires_at) < new Date()) {
      throw new Error("Token expired");
    }

    // Update password
    const passwordHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(
      passwordHash,
      reset.email_id
    );

    // Mark token as used
    db.prepare("UPDATE password_resets SET is_used = 1 WHERE id = ?").run(
      reset.id
    );

    // Revoke all refresh tokens
    db.prepare(
      "UPDATE refresh_tokens SET is_revoked = 1 WHERE email_id = ?"
    ).run(reset.email_id);

    return { message: "Password reset successfully" };
  },

  // Refresh access token
  async refreshAccessToken(refreshToken: string) {
    const db = getDB();

    const token = db
      .prepare(`
      SELECT rt.id AS token_id, rt.is_revoked, rt.expires_at,
             u.id AS uid, u.email, u.username, u.password_hash,
             u.is_email_verified, u.is_active, u.role,
             u.created_at, u.updated_at, u.last_login_at
      FROM refresh_tokens rt
      JOIN users u ON rt.email_id = u.email
      WHERE rt.token = ?
    `)
      .get(refreshToken) as any;

    if (!token || token.is_revoked || new Date(token.expires_at) < new Date()) {
      throw new Error("Invalid or expired refresh token");
    }

    db.prepare("UPDATE refresh_tokens SET expires_at = ? WHERE id = ?").run(
      getIdleExpiresAt(),
      token.token_id
    );

    const user: User = {
      id: token.uid,
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

  touchRefreshToken(refreshToken: string, email: string) {
    const db = getDB();

    const token = db
      .prepare(`
      SELECT id, expires_at, is_revoked
      FROM refresh_tokens
      WHERE token = ? AND email_id = ?
    `)
      .get(refreshToken, email) as any;

    if (!token || token.is_revoked || new Date(token.expires_at) < new Date()) {
      return false;
    }

    db.prepare("UPDATE refresh_tokens SET expires_at = ? WHERE id = ?").run(
      getIdleExpiresAt(),
      token.id
    );

    return true;
  },

  // Get user by ID
  async getUserById(userId: string) {
    const db = getDB();

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as
      | User
      | undefined;

    if (!user) {
      throw new Error("User not found");
    }

    return this.sanitizeUser(user);
  },

  // Change password
  async changePassword(
    email: string,
    oldPassword: string,
    newPassword: string
  ) {
    const db = getDB();

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
      | User
      | undefined;

    if (!user) {
      throw new Error("User not found");
    }

    // Verify old password
    const isValid = await verifyPassword(oldPassword, user.password_hash);
    if (!isValid) {
      throw new Error("Invalid old password");
    }

    // Update password
    const passwordHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(
      passwordHash,
      email
    );

    // Revoke all refresh tokens
    db.prepare(
      "UPDATE refresh_tokens SET is_revoked = 1 WHERE email_id = ?"
    ).run(email);

    return { message: "Password changed successfully" };
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

  /** Get emails that used a specific referral code (case-insensitive). */
  getReferralCodeUsage(code: string): {
    code: string;
    emails: string[];
    count: number;
  } {
    const db = getDB();
    const upper = code.toUpperCase();
    const ref = db
      .prepare("SELECT id FROM referral_codes WHERE UPPER(code) = ?")
      .get(upper) as { id: string } | undefined;
    if (!ref) {
      return { code: upper, emails: [], count: 0 };
    }
    const rows = db
      .prepare(
        "SELECT email_id AS email FROM referral_code_uses WHERE referral_code_id = ? ORDER BY used_at ASC"
      )
      .all(ref.id) as { email: string }[];
    const emails = rows.map((r) => r.email);
    return { code: upper, emails, count: emails.length };
  },

  /** List all referral codes with their usage (emails per code). */
  listAllReferralCodeUsage(): Array<{
    code: string;
    emails: string[];
    count: number;
  }> {
    const db = getDB();
    const codes = db
      .prepare("SELECT id, code FROM referral_codes ORDER BY code")
      .all() as { id: string; code: string }[];
    const out: Array<{ code: string; emails: string[]; count: number }> = [];
    const getEmails = db.prepare(
      "SELECT email_id AS email FROM referral_code_uses WHERE referral_code_id = ? ORDER BY used_at ASC"
    );
    for (const c of codes) {
      const rows = getEmails.all(c.id) as { email: string }[];
      const emails = rows.map((r) => r.email);
      out.push({ code: c.code, emails, count: emails.length });
    }
    return out;
  },
};
