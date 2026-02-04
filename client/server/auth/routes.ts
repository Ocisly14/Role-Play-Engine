import { Router } from "express";
import { body } from "express-validator";
import { validateRequest } from "../utils/validators.js";
import { authController } from "./controller.js";
import { authenticate } from "./middleware.js";

const router = Router();

// Register
router.post(
  "/register",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 8 }),
    body("username").optional().trim().isLength({ min: 3 }),
    body("referralCode")
      .notEmpty()
      .trim()
      .isLength({ min: 5, max: 5 })
      .matches(/^[A-Z0-9]{5}$/i)
      .withMessage("Referral code must be 5 alphanumeric characters"),
    validateRequest,
  ],
  authController.register
);

// Login
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").notEmpty(),
    validateRequest,
  ],
  authController.login
);

// Logout
router.post("/logout", authenticate, authController.logout);

// Refresh Token
router.post("/refresh", authController.refreshToken);

// Get Current User
router.get("/me", authenticate, authController.getCurrentUser);

// Send Verification Email (requires auth, for already-logged-in users)
router.post(
  "/send-verification",
  authenticate,
  authController.sendVerification
);

// Verify email with code (public, used during registration flow)
router.post(
  "/verify-code",
  [
    body("email").isEmail().normalizeEmail(),
    body("code").notEmpty().trim().isLength({ min: 5, max: 5 }).matches(/^\d{5}$/),
    validateRequest,
  ],
  authController.verifyCode
);

// Resend verification code (public)
router.post(
  "/resend-verification",
  [body("email").isEmail().normalizeEmail(), validateRequest],
  authController.resendVerification
);

// Forgot Password
router.post(
  "/forgot-password",
  [body("email").isEmail().normalizeEmail(), validateRequest],
  authController.forgotPassword
);

// Reset Password
router.post(
  "/reset-password",
  [
    body("token").notEmpty(),
    body("newPassword").isLength({ min: 8 }),
    validateRequest,
  ],
  authController.resetPassword
);

// Change Password
router.post(
  "/change-password",
  authenticate,
  [
    body("oldPassword").notEmpty(),
    body("newPassword").isLength({ min: 8 }),
    validateRequest,
  ],
  authController.changePassword
);

// Referral usage: GET /referral-usage?code=XXX (single) or GET /referral-usage (all)
router.get("/referral-usage", authenticate, authController.getReferralUsage);

export default router;
