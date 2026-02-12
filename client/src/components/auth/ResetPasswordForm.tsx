import React, { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api } from "../../services/api";

export function ResetPasswordForm() {
  const { t } = useTranslation('auth');
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError(t('register.errors.passwordMismatch'));
      return;
    }

    if (newPassword.length < 8) {
      setError(t('register.errors.passwordTooShort'));
      return;
    }

    setLoading(true);

    try {
      await api.post("/auth/reset-password", { token, newPassword });
      setSuccess(true);
      setTimeout(() => navigate("/login"), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || "Reset failed");
    } finally {
      setLoading(false);
    }
  };

  // No token in URL — link is invalid or missing
  if (!token) {
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
            alt={t('resetPassword.title')}
            style={{
              width: "80px",
              height: "80px",
              filter: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))",
            }}
          />
        </div>
        <h2>{t('resetPassword.invalidLink')}</h2>
        <p style={{ textAlign: "center", color: "#aaa", marginBottom: "16px" }}>
          {t('resetPassword.invalidLinkMessage')}
        </p>
        <div className="form-links">
          <a href="/forgot-password">{t('resetPassword.requestNew')}</a>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="success-message-container">
        <h2>{t('resetPassword.success')}</h2>
        <p>{t('resetPassword.successMessage')}</p>
        <p>{t('resetPassword.redirecting')}</p>
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
          alt={t('resetPassword.title')}
          style={{
            width: "80px",
            height: "80px",
            filter: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))",
          }}
        />
      </div>
      <h2>{t('resetPassword.title')}</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="newPassword">{t('resetPassword.newPassword')}</label>
          <input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            disabled={loading}
            minLength={8}
          />
          <small>{t('resetPassword.passwordHint')}</small>
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

        {error && <div className="error-message">{error}</div>}

        <button type="submit" disabled={loading}>
          {loading ? t('resetPassword.submitting') : t('resetPassword.submit')}
        </button>
      </form>
    </div>
  );
}
