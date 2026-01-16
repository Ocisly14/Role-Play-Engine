import React from 'react';
import { RegisterForm } from '../../components/auth/RegisterForm';

export default function Register() {
  return (
    <div className="auth-page">
      <div className="auth-frame">
        <img src="/asset/frame.png" alt="CoC Frame" className="frame-image" />
        <div className="auth-container">
          <RegisterForm />
        </div>
      </div>
    </div>
  );
}
