import React from 'react';
import { LoginForm } from '../../components/auth/LoginForm';
import { FrameImage } from '../../components/FrameImage';
import { useBackgroundImage } from '../../hooks/useBackgroundImage';

export default function Login() {
  // Set background image supporting multiple formats (png, jpeg, jpg)
  useBackgroundImage('background', true);

  return (
    <div className="auth-page">
      <div className="auth-frame">
        <FrameImage />
        <div className="auth-container">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
