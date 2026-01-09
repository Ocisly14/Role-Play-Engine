import React from 'react';
import { LoginForm } from '../../components/auth/LoginForm';

export default function Login() {
  return (
    <div className="auth-page">
      <div className="auth-container">
        <LoginForm />
      </div>
    </div>
  );
}
