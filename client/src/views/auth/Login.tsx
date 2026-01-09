import React from 'react';
import { LoginForm } from '../../components/auth/LoginForm';

export default function Login() {
  return (
    <div className="auth-page">
      <div className="auth-frame">
        <img src="/src/asset/frame.png" alt="CoC Frame" className="frame-image" />
        <div className="auth-container">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
