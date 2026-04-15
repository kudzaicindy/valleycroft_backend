# Connecting Frontend to Backend

## 1. Backend (.env)

Set your frontend URL so the API allows requests from it:

- **Local development:**  
  `FRONTEND_URL=http://localhost:3000`  
  (Use your frontend’s port if different, e.g. `5173` for Vite.)

- **Multiple origins (e.g. dev + production):**  
  `FRONTEND_URL=http://localhost:3000,https://your-app.com`

Start the API:

```bash
npm run dev
```

Backend runs at **http://localhost:5000** (or your `PORT`).

---

## 2. Frontend

Use the backend base URL for all API calls.

- **Local:** `http://localhost:5000`
- **Production:** your backend URL (e.g. `https://api.valleyroad.com`)

Example with a shared config:

```javascript
// e.g. src/config.js or .env in frontend
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';
```

**Login (get token):**

```javascript
const res = await fetch(`${API_BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@valleyroad.com', password: 'admin123456' }),
});
const { data } = await res.json();
const token = data.token;
```

**Authenticated requests:**

```javascript
fetch(`${API_BASE}/api/bookings`, {
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
});
```

- Use **credentials** if you send cookies: `fetch(url, { credentials: 'include' })`.
- Backend allows the origin(s) in `FRONTEND_URL` and uses `credentials: true` for CORS.

---

## 3. Seeded users (after running seed)

| Role     | Email                  | Password      |
|----------|------------------------|---------------|
| CEO      | ceo@valleyroad.com     | ceo123456     |
| Admin    | admin@valleyroad.com   | admin123456   |
| Finance  | finance@valleyroad.com | finance123456 |
| Employee | employee@valleyroad.com| employee123456 |

Run the seed once:

```bash
npm run seed:users
```

Then log in from the frontend with any of these accounts. Change passwords after first login (PUT `/api/auth/change-password`).
