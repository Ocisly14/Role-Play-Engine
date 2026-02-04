import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../services/api';
import { useNavigate } from 'react-router-dom';

const RESEND_COOLDOWN_SECONDS = 60;

export function RegisterForm() {
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [referralCode, setReferralCode] = useState('');
  const [verificationCode, setVerificationCode] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resendMessage, setResendMessage] = useState('');
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
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }

    setLoading(true);

    try {
      await register(email, password, username || undefined, referralCode);
      setStep('verify');
      startCooldown();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResendMessage('');
    setLoading(true);

    try {
      await api.post('/auth/verify-code', { email, code: verificationCode });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError('');
    setResendMessage('');
    setLoading(true);

    try {
      await api.post('/auth/resend-verification', { email });
      setVerificationCode('');
      setResendMessage('A new verification code has been sent.');
      startCooldown();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to resend code');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="success-message-container">
        <h2>Email Verified!</h2>
        <p>Your account has been activated successfully.</p>
        <p>Redirecting to login page...</p>
      </div>
    );
  }

  if (step === 'verify') {
    return (
      <div className="register-form-container">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '8px' }}>
          <img src="/asset/icon.png" alt="Call of Cthulhu" style={{ width: '80px', height: '80px', filter: 'drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))' }} />
        </div>
        <h2>Verify Your Email</h2>
        <p style={{ textAlign: 'center', color: '#aaa', marginBottom: '8px' }}>
          We sent a 5-digit verification code to <strong>{email}</strong>
        </p>
        <form onSubmit={handleVerify}>
          <div className="form-group">
            <label htmlFor="verificationCode">Verification Code *</label>
            <input
              id="verificationCode"
              type="text"
              inputMode="numeric"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              required
              disabled={loading}
              maxLength={5}
              pattern="\d{5}"
              placeholder="Enter 5-digit code"
              autoComplete="one-time-code"
              autoFocus
            />
          </div>

          {error && <div className="error-message">{error}</div>}
          {resendMessage && <div style={{ color: '#6c757d', fontSize: '14px', textAlign: 'center', marginBottom: '8px' }}>{resendMessage}</div>}

          <button type="submit" disabled={loading || verificationCode.length < 5}>
            {loading ? 'Verifying...' : 'Verify'}
          </button>

          <div className="form-links">
            {resendCooldown > 0 ? (
              <span style={{ color: '#666' }}>
                Resend code in {resendCooldown}s
              </span>
            ) : (
              <a href="#" onClick={(e) => { e.preventDefault(); handleResend(); }}>
                Didn't receive the code? Resend
              </a>
            )}
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="register-form-container">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '8px' }}>
        <img src="/asset/icon.png" alt="Call of Cthulhu" style={{ width: '80px', height: '80px', filter: 'drop-shadow(2px 2px 4px rgba(0, 0, 0, 0.3))' }} />
      </div>
      <h2>Create Account</h2>
      <form onSubmit={handleRegister}>
        <div className="form-group">
          <label htmlFor="email">Email *</label>
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
          <label htmlFor="username">Username (optional)</label>
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
          <label htmlFor="password">Password *</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            minLength={8}
          />
          <small>At least 8 characters with uppercase, lowercase, and numbers</small>
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

        <div className="form-group">
          <label htmlFor="referralCode">Referral Code *</label>
          <input
            id="referralCode"
            type="text"
            value={referralCode}
            onChange={(e) => setReferralCode(e.target.value.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5))}
            required
            disabled={loading}
            maxLength={5}
            pattern="[A-Z0-9]{5}"
            placeholder="Enter 5-character code"
          />
        </div>

        {error && <div className="error-message">{error}</div>}

        <button type="submit" disabled={loading}>
          {loading ? 'Registering...' : 'Register'}
        </button>

        <div className="form-links">
          <a href="/login">Already have an account? Login</a>
        </div>
      </form>
    </div>
  );
}
