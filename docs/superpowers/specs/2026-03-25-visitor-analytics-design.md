# Visitor Analytics Design

## Overview

Add visitor browsing statistics to the existing Analytics modal as a new tab. Track page views and browsing duration via frontend heartbeat, store in database, display hourly visitor line chart, per-IP average duration, and today's summary.

## Data Model

New Prisma table `VisitorSession`:

```prisma
model VisitorSession {
  id              String   @id @default(uuid())
  sessionId       String   @unique
  ip              String
  userAgent       String?
  startedAt       DateTime @default(now())
  lastHeartbeatAt DateTime @default(now())

  @@index([ip])
  @@index([startedAt])
}
```

- `sessionId`: frontend-generated UUID, unique per browser tab/session
- `ip`: extracted from request headers (`x-forwarded-for` or `req.ip`)
- Duration = `lastHeartbeatAt - startedAt`, computed at query time

## Frontend Tracking

### `useVisitorTracking` hook

Location: `client/src/hooks/useVisitorTracking.ts`

Behavior:
1. On mount: generate a UUID `sessionId`, call `POST /api/analytics/visitor/session`
2. Listen for user activity events: `click`, `scroll`, `keydown`, `mousemove`
3. On any activity, set `isActive = true`
4. Every 30 seconds, check `isActive`:
   - If true: call `POST /api/analytics/visitor/heartbeat` with `sessionId`, reset `isActive = false`
   - If false: do nothing (user is idle, stop counting)
5. On unmount: cleanup listeners and interval

### Integration point

Place `useVisitorTracking()` in `App.tsx` (top level), so it tracks all visitors including unauthenticated ones.

## API Endpoints

Location: `client/server/analytics/` (extend existing analytics module)

### POST `/api/analytics/visitor/session`

- Auth: None (track anonymous visitors)
- Body: `{ sessionId: string }`
- Action: Create `VisitorSession` record with IP from request
- Response: `{ success: true }`

### POST `/api/analytics/visitor/heartbeat`

- Auth: None
- Body: `{ sessionId: string }`
- Action: Update `lastHeartbeatAt` for the given sessionId
- Response: `{ success: true }`

### GET `/api/analytics/visitor/stats`

- Auth: ADMIN only
- Query params: `date` (optional, defaults to today, format YYYY-MM-DD)
- Response:
```json
{
  "success": true,
  "data": {
    "today": {
      "totalVisits": 42,
      "avgDurationSeconds": 185
    },
    "hourly": [
      { "hour": 0, "count": 3 },
      { "hour": 1, "count": 1 },
      ...
    ],
    "byIp": [
      { "ip": "192.168.1.1", "visitCount": 5, "avgDurationSeconds": 240 },
      ...
    ]
  }
}
```

`hourly`: group sessions by the hour of `startedAt` for the given date, count distinct sessions.

`byIp`: group by IP for the given date, count sessions and average duration.

`today`: total session count and average duration for the given date.

## Frontend UI

### Analytics modal changes

Location: `client/src/components/Analytics.tsx`

Add tab navigation at the top of the modal:
- Tab 1: "Usage Stats" (existing content)
- Tab 2: "Visitor Stats" (new)

### Visitor Stats tab content

1. **Today summary cards** (top row):
   - Total visits today
   - Average browsing duration today (formatted as mm:ss)

2. **Hourly visitor line chart** (Recharts LineChart):
   - X-axis: hours 0-23
   - Y-axis: visitor count
   - Single line showing visits per hour for selected date

3. **Per-IP table** (below chart):
   - Columns: IP, Visit Count, Avg Duration
   - Sorted by avg duration descending
   - Scrollable if many rows

### i18n

Add keys to `client/src/i18n/locales/en/home.json` and `zh/home.json`:
- `analytics.tabs.usage`, `analytics.tabs.visitors`
- `analytics.visitors.totalVisits`, `analytics.visitors.avgDuration`
- `analytics.visitors.hourlyChart`, `analytics.visitors.ipTable`
- `analytics.visitors.ip`, `analytics.visitors.visitCount`
- `analytics.visitors.noData`

## Security Considerations

- Session creation and heartbeat endpoints are unauthenticated but rate-limited by design (one heartbeat per 30s per session)
- Stats endpoint is ADMIN-only
- No PII stored beyond IP address and user agent
- sessionId is opaque UUID, not tied to user accounts
