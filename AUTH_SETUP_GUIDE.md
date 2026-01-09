# Authentication System Setup Guide

## ✅ Current Status

### Backend
- ✅ Auth tables integrated into `CoCDatabase` schema
- ✅ Auth service using better-sqlite3
- ✅ JWT middleware implemented
- ✅ Email service ready
- ✅ API routes mounted at `/api/auth/*`

### Frontend
- ✅ Auth context created
- ✅ Login/Register components ready
- ⚠️ Dependencies need to be installed

---

## 📋 Setup Steps

### 1. Install Frontend Dependencies

```bash
cd client
npm install axios react-router-dom
npm install --save-dev @types/react-router-dom
```

### 2. Configure Environment Variables

Edit `.env` file in project root:

```env
# JWT Configuration - IMPORTANT: Change this in production!
JWT_SECRET="CHANGE-THIS-TO-A-SECURE-RANDOM-STRING"
JWT_EXPIRES_IN="15m"
JWT_REFRESH_EXPIRES_IN="7d"

# Email Service Configuration (for Gmail)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER="your-email@gmail.com"
SMTP_PASS="your-gmail-app-password"  # Use App Password, not account password
EMAIL_FROM="noreply@cocgame.com"

# Application URLs
APP_URL="http://localhost:5173"
API_URL="http://localhost:3000"
```

**Generate a secure JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Get Gmail App Password:**
1. Go to https://myaccount.google.com/security
2. Enable 2-Step Verification
3. Search for "App passwords"
4. Generate a new app password for "Mail"
5. Copy the 16-character password to `SMTP_PASS`

### 3. Update Frontend App.tsx

Replace your `client/src/App.tsx` with this structure:

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';

// Import your views
import Login from './views/auth/Login';
import Register from './views/auth/Register';
import Home from './views/Homes'; // Your existing home component

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Protected routes */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Home />
              </ProtectedRoute>
            }
          />

          {/* Add more protected routes here */}
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
```

### 4. Initialize Database Schema

The auth tables will be automatically created when you start the server for the first time. The `CoCDatabase` constructor calls `initializeSchema()` which creates all tables including the new auth tables.

Just start the server once:

```bash
pnpm chat
```

The database will be automatically updated with the new tables:
- `users`
- `user_sessions`
- `email_verifications`
- `password_resets`
- `refresh_tokens`

And the existing `characters` table will get a new `user_id` column.

### 5. Test the System

#### Backend Test (using curl):

```bash
# Start the server
pnpm chat

# Test registration
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test1234",
    "username": "testuser"
  }'

# Test login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test1234"
  }'
```

#### Frontend Test:

```bash
# Start both backend and frontend
pnpm chat:dev

# Visit in browser:
# - http://localhost:5173/register - Register page
# - http://localhost:5173/login - Login page
# - http://localhost:5173/ - Protected home (should redirect to login)
```

---

## 🎨 Optional: Add Basic Styles

Create `client/src/styles/auth.css`:

```css
.auth-page {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: #f5f5f5;
}

.auth-container {
  background: white;
  padding: 2rem;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 400px;
}

.form-group {
  margin-bottom: 1rem;
}

.form-group label {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 500;
}

.form-group input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
  box-sizing: border-box;
}

.form-group.checkbox {
  display: flex;
  align-items: center;
}

.form-group.checkbox label {
  margin-bottom: 0;
  margin-left: 0.5rem;
}

.error-message {
  color: #dc3545;
  margin: 1rem 0;
  padding: 0.5rem;
  background: #f8d7da;
  border-radius: 4px;
}

.success-message-container {
  text-align: center;
  padding: 2rem;
}

button[type="submit"] {
  width: 100%;
  padding: 0.75rem;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  font-weight: 500;
}

button[type="submit"]:hover {
  background: #0056b3;
}

button[type="submit"]:disabled {
  background: #6c757d;
  cursor: not-allowed;
}

.form-links {
  margin-top: 1rem;
  display: flex;
  justify-content: space-between;
  font-size: 0.9rem;
}

.form-links a {
  color: #007bff;
  text-decoration: none;
}

.form-links a:hover {
  text-decoration: underline;
}
```

Then import it in your auth views:

```tsx
import '../../styles/auth.css';
```

---

## 📁 Database Structure

All data is stored in: `./data/coc_game.db`

New auth tables:
```sql
users                   -- User accounts
user_sessions          -- Active login sessions
email_verifications    -- Email verification tokens
password_resets        -- Password reset tokens
refresh_tokens         -- "Remember me" tokens
```

Updated game tables:
```sql
characters             -- Now has user_id column
sessions              -- Game sessions (existing)
game_turns            -- Game history (existing)
...                   -- Other existing game tables
```

---

## 🔐 Security Notes

1. **JWT_SECRET**: Must be a strong random string in production
2. **SMTP_PASS**: Use Gmail App Password, not your actual password
3. **HTTPS**: Use HTTPS in production (update APP_URL and API_URL)
4. **CORS**: Configure proper CORS settings in production

---

## 🐛 Troubleshooting

### Email not sending?
- Check SMTP credentials in `.env`
- For Gmail, ensure 2-Step Verification is enabled
- Use App Password, not account password
- Check firewall/network settings

### Database errors?
- Ensure `./data/` directory exists
- Check file permissions on `coc_game.db`
- Delete `coc_game.db` to recreate (will lose data!)

### Frontend errors?
- Ensure axios and react-router-dom are installed
- Check that AuthProvider wraps your app
- Verify API base URL is correct

### Token errors?
- Ensure JWT_SECRET is set and consistent
- Check token expiration times
- Clear browser localStorage and cookies

---

## 📊 Quick Start Checklist

- [ ] Install frontend dependencies: `cd client && npm install axios react-router-dom`
- [ ] Update `.env` with JWT_SECRET and email settings
- [ ] Update `client/src/App.tsx` to include auth routes
- [ ] Import auth.css in your components
- [ ] Start server: `pnpm chat`
- [ ] Test registration at http://localhost:3000/api/auth/register
- [ ] Start frontend: `pnpm chat:dev`
- [ ] Visit http://localhost:5173/register

---

## 🎉 You're Ready!

Once configured, you'll have:
- ✅ User registration with email verification
- ✅ Login/logout with JWT tokens
- ✅ Password reset via email
- ✅ Protected routes
- ✅ User-linked game characters and sessions
- ✅ All data in one SQLite database
