import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../services/api";

export function ForgotPasswordForm() {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.post("/auth/forgot-password", { email });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || "Request failed");
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="success-message-container">
        <h2>{t('forgotPassword.checkEmail')}</h2>
        <p>
          {t('forgotPassword.checkEmailMessage')}
        </p>
        <div className="form-links" style={{ marginTop: "16px" }}>
          <a href="/login">{t('forgotPassword.backToLogin')}</a>
        </div>
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
          alt={t('forgotPassword.title')}
          style={{
            width: "80px",
            height: "80px",
            filter: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))",
          }}
        />
      </div>
      <h2>{t('forgotPassword.title')}</h2>
      <p style={{ textAlign: "center", color: "#aaa", marginBottom: "16px" }}>
        {t('forgotPassword.description')}
      </p>
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

        {error && <div className="error-message">{error}</div>}

        <button type="submit" disabled={loading}>
          {loading ? t('forgotPassword.submitting') : t('forgotPassword.submit')}
        </button>

        <div className="form-links">
          <a href="/login">{t('forgotPassword.backToLogin')}</a>
        </div>
      </form>
    </div>
  );
}
