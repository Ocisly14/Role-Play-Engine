import React, { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../../services/api';

export function ResetPasswordForm() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const navigate = useNavigate();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    setLoading(true);

    try {
      await api.post('/auth/reset-password', { token, newPassword });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Reset failed');
    } finally {
      setLoading(false);
    }
  };

  // No token in URL — link is invalid or missing
  if (!token) {
    return (
      <div className="register-form-container">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '8px' }}>
          <img src="/asset/icon.png" alt="Call of Cthulhu" style={{ width: '80px', height: '80px', filter: 'drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))' }} />
        </div>
        <h2>Invalid Link</h2>
        <p style={{ textAlign: 'center', color: '#aaa', marginBottom: '16px' }}>
          This reset link is invalid or has expired.
        </p>
        <div className="form-links">
          <a href="/forgot-password">Request a new reset link</a>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="success-message-container">
        <h2>Password Reset!</h2>
        <p>Your password has been reset successfully.</p>
        <p>Redirecting to login...</p>
      </div>
    );
  }

  return (
    <div className="register-form-container">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '8px' }}>
        <img src="/asset/icon.png" alt="Call of Cthulhu" style={{ width: '80px', height: '80px', filter: 'drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))' }} />
      </div>
      <h2>Reset Password</h2>
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="newPassword">New Password *</label>
          <input
            id="newPassword"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            disabled={loading}
            minLength={8}
          />
          <small>At least 8 characters</small>
        </div>

        <div className="form-group">
          <label htmlFor="confirmPassword">Confirm Password *</label>
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
          {loading ? 'Resetting...' : 'Reset Password'}
        </button>
      </form>
    </div>
  );
}
