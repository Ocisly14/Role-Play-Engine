import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../contexts/AuthContext";
import { api } from "../../services/api";
import { useNavigate } from "react-router-dom";

const RESEND_COOLDOWN_SECONDS = 60;

export function RegisterForm() {
  const { t } = useTranslation('auth');
  const [step, setStep] = useState<"form" | "verify">("form");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendMessage, setResendMessage] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { register } = useAuth();
  const navigate = useNavigate();

  // Start or reset the countdown timer
  const startCooldown = () => {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(cooldownRef.current!);
          cooldownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Clean up interval on unmount
  useEffect(() => {
    return () => {
      if (cooldownRef.current) clearInterval(cooldownRef.current);
    };
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError(t('register.errors.passwordMismatch'));
      return;
    }

    if (password.length < 8) {
      setError(t('register.errors.passwordTooShort'));
      return;
    }

    setLoading(true);

    try {
      await register(email, password, username || undefined, referralCode);
      setStep("verify");
      startCooldown();
    } catch (err: any) {
      setError(err.response?.data?.error || t('register.errors.registrationFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setResendMessage("");
    setLoading(true);

    try {
      await api.post("/auth/verify-code", { email, code: verificationCode });
      setSuccess(true);
      setTimeout(() => navigate("/login"), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || t('register.verify.invalid'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    setResendMessage("");
    setLoading(true);

    try {
      await api.post("/auth/resend-verification", { email });
      setVerificationCode("");
      setResendMessage(t('register.verify.resend'));
      startCooldown();
    } catch (err: any) {
      setError(err.response?.data?.error || t('register.verify.invalid'));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="success-message-container">
        <h2>{t('register.verify.success')}</h2>
        <p>{t('register.verify.successMessage')}</p>
        <p>{t('common:loading.pleaseWait')}</p>
      </div>
    );
  }

  if (step === "verify") {
    return (
      <div className="register-form-container">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            marginBottom: "8px",
          }}
        >
          <img
            src="/asset/icon.png"
            alt={t('register.title')}
            style={{
              width: "80px",
              height: "80px",
              filter: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))",
            }}
          />
        </div>
        <h2>{t('register.verify.title')}</h2>
        <p style={{ textAlign: "center", color: "#aaa", marginBottom: "8px" }}>
          {t('register.verify.description', { email })}
        </p>
        <form onSubmit={handleVerify}>
          <div className="form-group">
            <label htmlFor="verificationCode">{t('register.verify.code')}</label>
            <input
              id="verificationCode"
              type="text"
              inputMode="numeric"
              value={verificationCode}
              onChange={(e) =>
                setVerificationCode(
                  e.target.value.replace(/\D/g, "").slice(0, 5)
                )
              }
              required
              disabled={loading}
              maxLength={5}
              pattern="\d{5}"
              placeholder={t('register.verify.codePlaceholder')}
              autoComplete="one-time-code"
              autoFocus
            />
          </div>

          {error && <div className="error-message">{error}</div>}
          {resendMessage && (
            <div
              style={{
                color: "#6c757d",
                fontSize: "14px",
                textAlign: "center",
                marginBottom: "8px",
              }}
            >
              {resendMessage}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || verificationCode.length < 5}
          >
            {loading ? t('register.verify.submitting') : t('register.verify.submit')}
          </button>

          <div className="form-links">
            {resendCooldown > 0 ? (
              <span style={{ color: "#666" }}>
                {t('register.verify.resendCooldown', { seconds: resendCooldown })}
              </span>
            ) : (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  handleResend();
                }}
              >
                {t('register.verify.resend')}
              </a>
            )}
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="register-form-container">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "16px",
          marginBottom: "8px",
        }}
      >
        <img
          src="/asset/icon.png"
          alt={t('register.title')}
          style={{
            width: "80px",
            height: "80px",
            filter: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))",
          }}
        />
      </div>
      <h2>{t('register.title')}</h2>
      <form onSubmit={handleRegister}>
        <div className="form-group">
          <label htmlFor="email">{t('register.email')}</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
          />
        </div>

        <div className="form-group">
          <label htmlFor="username">{t('register.username')}</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            minLength={3}
          />
        </div>

        <div className="form-group">
          <label htmlFor="password">{t('register.password')}</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            minLength={8}
          />
          <small>
            {t('register.passwordHint')}
          </small>
        </div>

        <div className="form-group">
          <label htmlFor="confirmPassword">{t('register.confirmPassword')}</label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            disabled={loading}
          />
        </div>

        <div className="form-group">
          <label htmlFor="referralCode">{t('register.referralCode')}</label>
          <input
            id="referralCode"
            type="text"
            value={referralCode}
            onChange={(e) =>
              setReferralCode(
                e.target.value
                  .replace(/[^A-Z0-9]/gi, "")
                  .toUpperCase()
                  .slice(0, 5)
              )
            }
            required
            disabled={loading}
            maxLength={5}
            pattern="[A-Z0-9]{5}"
            placeholder={t('register.verify.codePlaceholder')}
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <button type="submit" disabled={loading}>
          {loading ? t('register.submitting') : t('register.submit')}
        </button>

        <div className="form-links">
          <a href="/login">{t('register.haveAccount')}</a>
        </div>
      </form>
    </div>
  );
}
