import { Router } from 'express';
import { body } from 'express-validator';
import { authController } from './controller.js';
import { authenticate } from './middleware.js';
import { validateRequest } from '../utils/validators.js';

const router = Router();

// Register
router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('username').optional().trim().isLength({ min: 3 }),
    validateRequest,
  ],
  authController.register
);

// Login
router.post(
  '/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
    validateRequest,
  ],
  authController.login
);

// Logout
router.post('/logout', authenticate, authController.logout);

// Refresh Token
router.post('/refresh', authController.refreshToken);

// Get Current User
router.get('/me', authenticate, authController.getCurrentUser);

// Send Verification Email
router.post('/send-verification', authenticate, authController.sendVerification);

// Verify Email
router.get('/verify-email', authController.verifyEmail);

// Forgot Password
router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail(), validateRequest],
  authController.forgotPassword
);

// Reset Password
router.post(
  '/reset-password',
  [
    body('token').notEmpty(),
    body('newPassword').isLength({ min: 8 }),
    validateRequest,
  ],
  authController.resetPassword
);

// Change Password
router.post(
  '/change-password',
  authenticate,
  [
    body('oldPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 }),
    validateRequest,
  ],
  authController.changePassword
);

export default router;
