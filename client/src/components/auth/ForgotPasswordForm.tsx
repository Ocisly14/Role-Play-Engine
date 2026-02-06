import React, { useState } from "react";
import { api } from "../../services/api";

export function ForgotPasswordForm() {
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
        <h2>Check Your Email</h2>
        <p>
          If an account with this email exists, we've sent a password reset
          link.
        </p>
        <div className="form-links" style={{ marginTop: "16px" }}>
          <a href="/login">Back to Login</a>
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
          alt="Call of Cthulhu"
          style={{
            width: "80px",
            height: "80px",
            filter: "drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))",
          }}
        />
      </div>
      <h2>Forgot Password</h2>
      <p style={{ textAlign: "center", color: "#aaa", marginBottom: "16px" }}>
        Enter your email and we'll send you a link to reset your password.
      </p>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="email">Email</label>
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
          {loading ? "Sending..." : "Send Reset Link"}
        </button>

        <div className="form-links">
          <a href="/login">Back to Login</a>
        </div>
      </form>
    </div>
  );
}
