# Deploy UniTalks on Render – Step-by-Step Guide

## Prerequisites

- [ ] GitHub account
- [ ] UniTalks repo pushed to GitHub
- [ ] Render account (sign up at [render.com](https://render.com))

---

## Part 1: Prepare the Repository

### Step 1.1: Add build script (if not using render.yaml)

Ensure your **root** `package.json` has a deploy script, or Render will use the build commands below.

### Step 1.2: Set REACT_APP_API_URL for production

The frontend needs the backend URL at build time. We'll set this in Render's environment (Step 3.5). For now, the server serves the frontend from the same origin, so `REACT_APP_API_URL` can be empty or the same URL (the frontend will use `window.location.origin` as fallback when same-origin).

---

## Part 2: Create Render Web Service

### Step 2.1: Log in to Render

1. Go to [dashboard.render.com](https://dashboard.render.com)
2. Sign in with GitHub

### Step 2.2: New Web Service

1. Click **New +** → **Web Service**
2. Connect your GitHub account if prompted
3. Select the **UniTalks repository**
4. Click **Connect**

### Step 2.3: Configure the service

| Field | Value |
|-------|-------|
| **Name** | `unitalks` (or any name) |
| **Region** | Oregon (US West) or closest to users |
| **Branch** | `main` (or your default branch) |
| **Root Directory** | *(leave blank – use repo root)* |
| **Runtime** | `Node` |

### Step 2.4: Build & Start commands

**Build Command:**
```bash
npm install && npm run build && cd server && npm install && npm run build
```

**Start Command:**
```bash
cd server && node dist/index.js
```

### Step 2.5: Instance type

- **Free**: 512MB RAM, sleeps after 15 min idle
- **Starter ($7/mo)**: 512MB, always on, better for WebSockets

---

## Part 3: Environment Variables

In the **Environment** section, add:

| Key | Value | Notes |
|-----|-------|-------|
| `NODE_ENV` | `production` | Required |
| `PORT` | `10000` | Render sets this; use 10000 |
| `JWT_SECRET` | *(generate a strong random string)* | e.g. 32+ chars |
| `CORS_ORIGIN` | `https://your-service.onrender.com` | Replace with your Render URL |
| `USE_REDIS` | `false` | No Redis for single instance |
| `REACT_APP_API_URL` | *(leave empty)* | Same origin = not needed |

**Generate JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 3.1: After first deploy – update CORS

1. Deploy once
2. Copy the URL (e.g. `https://unitalks-xxxx.onrender.com`)
3. In **Environment**, set `CORS_ORIGIN` = `https://unitalks-xxxx.onrender.com`
4. **Save Changes** – Render will redeploy

---

## Part 4: Deploy

### Step 4.1: Create Web Service

1. Click **Create Web Service**
2. Render will clone the repo and run the build
3. Wait 5–10 minutes for the first build

### Step 4.2: Check build logs

- Open **Logs**
- Build should show: `npm install` → `npm run build` (React) → `cd server && npm run build` (backend)
- Start should show: `node dist/index.js`

### Step 4.3: Verify deployment

1. Open the service URL (e.g. `https://unitalks-xxxx.onrender.com`)
2. You should see the UniTalks homepage
3. Click **Start Chat** → go to video
4. Click **Start Chat** → you should be matched (or see waiting state)

---

## Part 5: Scale to 3 Instances (Optional)

### Step 5.1: Open service settings

1. Go to your service
2. Click **Settings**

### Step 5.2: Scaling

1. Find **Scaling** or **Instances**
2. Set **Instance count** to `3`
3. Save

Render will run 3 instances behind its load balancer. Each instance uses in-memory state; users on the same instance can match (sticky sessions via Render).

---

## Part 6: Custom Domain (Optional)

### Step 6.1: Add custom domain

1. **Settings** → **Custom Domains**
2. Add your domain (e.g. `unitalks.yourdomain.com`)
3. Render will show DNS records

### Step 6.2: Configure DNS

At your domain registrar, add:

| Type | Name | Value |
|------|------|-------|
| CNAME | `unitalks` (or `@`) | `your-service.onrender.com` |

### Step 6.3: Update CORS

Set `CORS_ORIGIN` to `https://unitalks.yourdomain.com`

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Build fails | Check logs; ensure `npm run build` works locally |
| Blank page | Verify `REACT_APP_API_URL` or same-origin; check browser console |
| WebSocket fails | Use `wss://` (Render provides HTTPS); check CORS |
| 502 Bad Gateway | Check `/health`; ensure PORT=10000 |
| Sleep on free tier | Upgrade to paid or use a cron to ping every 5 min |

---

## Quick Reference

**Build command:**
```bash
npm install && npm run build && cd server && npm install && npm run build
```

**Start command:**
```bash
cd server && node dist/index.js
```

**Required env vars:**
- `NODE_ENV=production`
- `PORT=10000`
- `JWT_SECRET=<your-secret>`
- `CORS_ORIGIN=https://your-app.onrender.com`
