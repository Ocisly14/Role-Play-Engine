import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../contexts/AuthContext";
import { useNavigate } from "react-router-dom";
import { api } from "../../services/api";

const RESEND_COOLDOWN_SECONDS = 60;

export function LoginForm() {
  const { t } = useTranslation('auth');
  const [step, setStep] = useState<"login" | "verify">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendMessage, setResendMessage] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const [showCommunityModal, setShowCommunityModal] = useState(false);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLoginSuccess = () => {
    setShowCommunityModal(true);
  };

  const handleCloseCommunityModal = () => {
    setShowCommunityModal(false);
    navigate("/");
  };

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await login(email, password, rememberMe);
      handleLoginSuccess();
    } catch (err: any) {
      // Check if error is EMAIL_NOT_VERIFIED
      if (err.response?.status === 403 && err.response?.data?.code === "EMAIL_NOT_VERIFIED") {
        setStep("verify");
        startCooldown();
        setError("");
      } else {
        setError(err.response?.data?.error || t('login.error'));
      }
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
      // Verify the code first
      await api.post("/auth/verify-code", { email, code: verificationCode });

      // After verification succeeds, login with the saved credentials
      await login(email, password, rememberMe);

      handleLoginSuccess();
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

  // Show verification step if email not verified
  if (step === "verify") {
    return (
      <>
        <div className="login-form-container">
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
              alt={t('register.verify.title')}
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
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setStep("login");
                  setVerificationCode("");
                  setError("");
                }}
              >
                {t('common:actions.back')}
              </a>
            </div>
          </form>
        </div>
        {showCommunityModal && (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
            <div className="w-[92%] max-w-[560px] rounded-3xl p-8 border border-white/50 bg-white/85 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/65 supports-[backdrop-filter]:backdrop-blur-lg">
              <h3 className="text-2xl font-semibold mb-3 text-slate-900">
                {t('communityInvite.title')}
              </h3>
              <p className="text-lg leading-relaxed text-slate-700 whitespace-pre-line mb-4">
                {t('communityInvite.description')}
              </p>
              <div className="space-y-2 mb-6 text-lg leading-relaxed text-slate-800">
                <p>
                  <strong>{t('communityInvite.qqLabel')}</strong> 1084747456
                </p>
                <p>
                  <strong>{t('communityInvite.discordLabel')}</strong>{" "}
                  <a
                    href="https://discord.gg/ZwArUWx5"
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-700 underline"
                  >
                    https://discord.gg/ZwArUWx5
                  </a>
                </p>
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={handleCloseCommunityModal}>
                  {t('communityInvite.continue')}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className="login-form-container">
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
            alt={t('login.title')}
            style={{
              width: "80px",
              height: "80px",
              filter: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))",
            }}
          />
        </div>
        <h2>{t('login.title')}</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">{t('login.email')}</label>
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
            <label htmlFor="password">{t('login.password')}</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
            />
          </div>

          <div className="form-group checkbox">
            <label>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={loading}
              />
              {t('login.rememberMe')}
            </label>
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" disabled={loading}>
            {loading ? t('login.submitting') : t('login.submit')}
          </button>

          <div className="form-links">
            <a href="/forgot-password">{t('login.forgotPassword')}</a>
            <a href="/register">{t('login.createAccount')}</a>
          </div>
        </form>
      </div>
      {showCommunityModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm supports-[backdrop-filter]:bg-black/30 supports-[backdrop-filter]:backdrop-blur-sm flex items-center justify-center p-5">
          <div className="w-[92%] max-w-[560px] rounded-3xl p-8 border border-white/50 bg-white/85 shadow-[0_30px_80px_rgba(15,23,42,0.25)] supports-[backdrop-filter]:bg-white/65 supports-[backdrop-filter]:backdrop-blur-lg">
            <h3 className="text-2xl font-semibold mb-3 text-slate-900">
              {t('communityInvite.title')}
            </h3>
            <p className="text-lg leading-relaxed text-slate-700 whitespace-pre-line mb-4">
              {t('communityInvite.description')}
            </p>
            <div className="space-y-2 mb-6 text-lg leading-relaxed text-slate-800">
              <p>
                <strong>{t('communityInvite.qqLabel')}</strong> 1084747456
              </p>
              <p>
                <strong>{t('communityInvite.discordLabel')}</strong>{" "}
                <a
                  href="https://discord.gg/ZwArUWx5"
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-700 underline"
                >
                  https://discord.gg/ZwArUWx5
                </a>
              </p>
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={handleCloseCommunityModal}>
                {t('communityInvite.continue')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
