import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../contexts/AuthContext";
import { useNavigate } from "react-router-dom";

export function LoginForm() {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await login(email, password, rememberMe);
      navigate("/"); // Navigate to home after successful login
    } catch (err: any) {
      setError(err.response?.data?.error || t('login.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
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
  );
}
