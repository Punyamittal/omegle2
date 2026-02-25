import { env } from '../config/env';

const windowMs = env.wsRateLimitWindowMs;
const max = env.wsRateLimitMax;

const store = new Map<string, { count: number; resetAt: number }>();

export function checkWsRateLimit(identifier: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = store.get(identifier);

  if (!entry) {
    store.set(identifier, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  if (now >= entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + windowMs;
    return { allowed: true };
  }

  if (entry.count >= max) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }

  entry.count++;
  return { allowed: true };
}

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store.entries()) {
    if (now >= val.resetAt) store.delete(key);
  }
}, 60000);
