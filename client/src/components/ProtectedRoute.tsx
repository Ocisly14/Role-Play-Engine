import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireEmailVerified?: boolean;
  requiredRoles?: string[];
}

export function ProtectedRoute({
  children,
  requireEmailVerified = false,
  requiredRoles = []
}: ProtectedRouteProps) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div>Loading...</div>;
  }

  if (!user) {
    // Not logged in, redirect to login page
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requireEmailVerified && !user.isEmailVerified) {
    // Email verification required but not verified
    return <Navigate to="/verify-email-notice" replace />;
  }

  if (requiredRoles.length > 0 && !requiredRoles.includes(user.role)) {
    // Insufficient permissions
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
}
