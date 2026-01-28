/// <reference path="../types/express.d.ts" />
import type { Request, Response } from 'express';
import { authService } from './service.js';

export const authController = {
  // Register
  async register(req: Request, res: Response) {
    try {
      const result = await authService.register(req.body);
      res.status(201).json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  // Login
  async login(req: Request, res: Response) {
    try {
      const result = await authService.login(req.body);

      // Set HTTP-only Cookie for refresh token
      if (result.refreshToken) {
        res.cookie('refreshToken', result.refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });
      }

      res.json(result);
    } catch (error: any) {
      res.status(401).json({ error: error.message });
    }
  },

  // Logout
  async logout(req: Request, res: Response) {
    try {
      // Clear cookie
      res.clearCookie('refreshToken');
      res.json({ message: 'Logged out successfully' });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },

  // Refresh Token
  async refreshToken(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body;
      const result = await authService.refreshAccessToken(refreshToken);
      res.json(result);
    } catch (error: any) {
      res.status(401).json({ error: error.message });
    }
  },

  // Get Current User
  async getCurrentUser(req: Request, res: Response) {
    try {
      const userId = req.user!.userId;
      const user = await authService.getUserById(userId);
      res.json({ user });
    } catch (error: any) {
      res.status(404).json({ error: error.message });
    }
  },

  // Send Verification Email
  async sendVerification(req: Request, res: Response) {
    try {
      const userId = req.user!.userId;
      const result = await authService.sendEmailVerification(userId);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  // Verify Email
  async verifyEmail(req: Request, res: Response) {
    try {
      const { token } = req.query;
      const result = await authService.verifyEmail(token as string);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  // Forgot Password
  async forgotPassword(req: Request, res: Response) {
    try {
      const { email } = req.body;
      const result = await authService.requestPasswordReset(email);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  // Reset Password
  async resetPassword(req: Request, res: Response) {
    try {
      const { token, newPassword } = req.body;
      const result = await authService.resetPassword(token, newPassword);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },

  // Change Password
  async changePassword(req: Request, res: Response) {
    try {
      const userId = req.user!.userId;
      const { oldPassword, newPassword } = req.body;
      const result = await authService.changePassword(userId, oldPassword, newPassword);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  },
};
