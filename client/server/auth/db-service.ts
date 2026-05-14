import crypto from "crypto";
import { randomUUID } from "crypto";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { emailService } from "../email/service.js";
import { generateAccessToken, generateRefreshToken } from "./jwt.js";
import { hashPassword, verifyPassword } from "./password.js";

const parsedIdleMinutes = Number(
  process.env.SESSION_IDLE_TIMEOUT_MINUTES || 60
);
const IDLE_TIMEOUT_MINUTES =
  Number.isFinite(parsedIdleMinutes) && parsedIdleMinutes > 0
    ? parsedIdleMinutes
    : 60;
const IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MINUTES * 60 * 1000;

function getIdleExpiresAt(): Date {
  return new Date(Date.now() + IDLE_TIMEOUT_MS);
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
    const prisma = getPrismaClient();

    // Validate referral code (case-insensitive)
    const referralCodeUpper = data.referralCode.toUpperCase();
    const referral = await prisma.referralCode.findFirst({
      where: { code: { equals: referralCodeUpper, mode: "insensitive" } },
      include: { uses: true },
    });

    if (!referral) {
      throw new Error("Invalid referral code");
    }

    // Check usage limit (max_uses = null means unlimited)
    if (referral.maxUses != null && referral.uses.length >= referral.maxUses) {
      throw new Error("Referral code has reached its usage limit");
    }

    // Check if email already exists
    const existing = await prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    });

    if (existing) {
      throw new Error("Email already registered");
    }

    // Check if email domain is in disposable email blacklist
    const emailDomain = data.email.split("@")[1]?.toLowerCase();
    if (emailDomain) {
      const blacklisted = await prisma.disposableEmailDomain.findUnique({
        where: { domain: emailDomain },
      });

      if (blacklisted) {
        throw new Error(
          "Disposable email addresses are not allowed. Please use a permanent email address."
        );
      }
    }

    const userId = randomUUID();
    const passwordHash = await hashPassword(data.password);

    // Determine user role based on ADMIN_EMAIL environment variable
    const adminEmails = (process.env.ADMIN_EMAIL || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0);
    const userRole = adminEmails.includes(data.email.toLowerCase())
      ? "ADMIN"
      : "USER";

    // Create user and record referral code use in a transaction
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          id: userId,
          email: data.email,
          username: data.username || null,
          passwordHash,
          isEmailVerified: false,
          isActive: true,
          role: userRole,
        },
      });

      // Record referral code use
      await tx.referralCodeUse.create({
        data: {
          id: randomUUID(),
          referralCodeId: referral.id,
          userId: newUser.id,
        },
      });

      return newUser;
    });

    // Send verification email
    await this.sendEmailVerification(data.email);

    return {
      user: this.sanitizeUser(this.formatUser(user)),
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
    const prisma = getPrismaClient();

    // Find user
    const user = await prisma.user.findUnique({
      where: { email: data.email },
    });

    if (!user) {
      throw new Error("Invalid email or password");
    }

    // Verify password
    const isValidPassword = await verifyPassword(
      data.password,
      user.passwordHash
    );

    if (!isValidPassword) {
      throw new Error("Invalid email or password");
    }

    // Check account status
    if (!user.isActive) {
      throw new Error("Account is disabled");
    }

    // If email not verified, send verification code and return special status
    if (!user.isEmailVerified) {
      await this.sendEmailVerification(data.email);

      // Throw special error with email_not_verified type
      const error: any = new Error(
        "Email not verified. A verification code has been sent to your email."
      );
      error.code = "EMAIL_NOT_VERIFIED";
      error.email = data.email;
      throw error;
    }

    // Update last login time
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate tokens
    const formattedUser = this.formatUser(user);
    const accessToken = generateAccessToken(formattedUser);
    let refreshToken: string | undefined;

    if (data.rememberMe) {
      refreshToken = generateRefreshToken(formattedUser);

      // Save refresh token
      const tokenId = randomUUID();
      const expiresAt = getIdleExpiresAt();

      await prisma.refreshToken.create({
        data: {
          id: tokenId,
          userId: user.id,
          token: refreshToken,
          expiresAt,
        },
      });
    }

    return {
      user: this.sanitizeUser(formattedUser),
      accessToken,
      refreshToken,
    };
  },

  // Send email verification code (for existing users)
  async sendEmailVerification(email: string) {
    const prisma = getPrismaClient();

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new Error("User not found");
    }

    if (user.isEmailVerified) {
      throw new Error("Email already verified");
    }

    // Enforce 60-second cooldown between sends
    const recent = await prisma.emailVerification.findFirst({
      where: {
        userId: user.id,
        verified: false,
      },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    if (recent && Date.now() - recent.createdAt.getTime() < 60 * 1000) {
      throw new Error("Please wait before requesting a new code");
    }

    // Generate 5-digit verification code
    const code = crypto.randomInt(10000, 100000).toString();
    const verificationId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save to database
    await prisma.emailVerification.create({
      data: {
        id: verificationId,
        userId: user.id,
        code,
        expiresAt,
      },
    });

    // Send email with code
    await emailService.sendVerificationEmail(user.email, code);

    return { message: "Verification code sent" };
  },

  // Verify email with 5-digit code
  async verifyEmailCode(email: string, code: string) {
    const prisma = getPrismaClient();

    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        emailVerifications: {
          where: {
            code,
            verified: false,
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!user || user.emailVerifications.length === 0) {
      throw new Error("Invalid verification code");
    }

    const verification = user.emailVerifications[0];

    if (verification.expiresAt < new Date()) {
      throw new Error("Verification code has expired");
    }

    // Mark email as verified and code as used in transaction
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: { isEmailVerified: true },
      }),
      prisma.emailVerification.update({
        where: { id: verification.id },
        data: { verified: true },
      }),
    ]);

    return { message: "Email verified successfully" };
  },

  // Resend verification code (public-safe: never reveals whether email exists)
  async resendEmailVerification(email: string) {
    const prisma = getPrismaClient();
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user || user.isEmailVerified) {
      // Generic message to prevent email enumeration
      return { message: "Verification code sent" };
    }

    await this.sendEmailVerification(email);
    return { message: "Verification code sent" };
  },

  // Request password reset
  async requestPasswordReset(email: string) {
    const prisma = getPrismaClient();

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Don't reveal if user exists
      return { message: "If the email exists, a reset link has been sent" };
    }

    // Generate reset token
    const token = crypto.randomBytes(32).toString("hex");
    const resetId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Save to database
    await prisma.passwordReset.create({
      data: {
        id: resetId,
        userId: user.id,
        token,
        expiresAt,
      },
    });

    // Send email
    await emailService.sendPasswordResetEmail(user.email, token);

    return { message: "If the email exists, a reset link has been sent" };
  },

  // Reset password
  async resetPassword(token: string, newPassword: string) {
    const prisma = getPrismaClient();

    const reset = await prisma.passwordReset.findUnique({
      where: { token },
    });

    if (!reset) {
      throw new Error("Invalid reset token");
    }

    if (reset.used) {
      throw new Error("Token already used");
    }

    if (reset.expiresAt < new Date()) {
      throw new Error("Token expired");
    }

    // Update password, mark token as used, and revoke all refresh tokens
    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: reset.userId },
        data: { passwordHash },
      }),
      prisma.passwordReset.update({
        where: { id: reset.id },
        data: {
          used: true,
          usedAt: new Date(),
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: reset.userId },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { message: "Password reset successfully" };
  },

  // Refresh access token
  async refreshAccessToken(refreshToken: string) {
    const prisma = getPrismaClient();

    const token = await prisma.refreshToken.findUnique({
      where: { token: refreshToken },
      include: { user: true },
    });

    if (!token || token.revokedAt || token.expiresAt < new Date()) {
      throw new Error("Invalid or expired refresh token");
    }

    // Update token expiration
    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { expiresAt: getIdleExpiresAt() },
    });

    const formattedUser = this.formatUser(token.user);
    const accessToken = generateAccessToken(formattedUser);

    return { accessToken };
  },

  async touchRefreshToken(refreshToken: string, userId: string) {
    const prisma = getPrismaClient();

    const token = await prisma.refreshToken.findFirst({
      where: {
        token: refreshToken,
        userId,
      },
    });

    if (!token || token.revokedAt || token.expiresAt < new Date()) {
      return false;
    }

    await prisma.refreshToken.update({
      where: { id: token.id },
      data: { expiresAt: getIdleExpiresAt() },
    });

    return true;
  },

  // Get user by ID
  async getUserById(userId: string) {
    const prisma = getPrismaClient();

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    return this.sanitizeUser(this.formatUser(user));
  },

  // Change password
  async changePassword(
    email: string,
    oldPassword: string,
    newPassword: string
  ) {
    const prisma = getPrismaClient();

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Verify old password
    const isValid = await verifyPassword(oldPassword, user.passwordHash);
    if (!isValid) {
      throw new Error("Invalid old password");
    }

    // Update password and revoke all refresh tokens
    const passwordHash = await hashPassword(newPassword);

    await prisma.$transaction([
      prisma.user.update({
        where: { email },
        data: { passwordHash },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id },
        data: { revokedAt: new Date() },
      }),
    ]);

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

  // Format Prisma user to match old schema format
  formatUser(user: any): User {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      password_hash: user.passwordHash,
      is_email_verified: user.isEmailVerified,
      is_active: user.isActive,
      role: user.role,
      created_at: user.createdAt.toISOString(),
      updated_at: user.updatedAt.toISOString(),
      last_login_at: user.lastLoginAt?.toISOString() || null,
    };
  },

  /** Get emails that used a specific referral code (case-insensitive). */
  async getReferralCodeUsage(code: string): Promise<{
    code: string;
    emails: string[];
    count: number;
  }> {
    const prisma = getPrismaClient();
    const upper = code.toUpperCase();

    const referralCode = await prisma.referralCode.findFirst({
      where: { code: { equals: upper, mode: "insensitive" } },
      include: {
        uses: {
          include: { user: { select: { email: true } } },
          orderBy: { usedAt: "asc" },
        },
      },
    });

    if (!referralCode) {
      return { code: upper, emails: [], count: 0 };
    }

    const emails = referralCode.uses.map((use) => use.user.email);
    return { code: upper, emails, count: emails.length };
  },

  /** List all referral codes with their usage (emails per code). */
  async listAllReferralCodeUsage(): Promise<
    Array<{
      code: string;
      emails: string[];
      count: number;
    }>
  > {
    const prisma = getPrismaClient();

    const codes = await prisma.referralCode.findMany({
      include: {
        uses: {
          include: { user: { select: { email: true } } },
          orderBy: { usedAt: "asc" },
        },
      },
      orderBy: { code: "asc" },
    });

    return codes.map((c) => ({
      code: c.code,
      emails: c.uses.map((use) => use.user.email),
      count: c.uses.length,
    }));
  },
};
