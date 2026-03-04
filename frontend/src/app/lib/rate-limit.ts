// src/app/lib/rate-limit.ts
//
// Redis-backed rate limiting using rate-limiter-flexible.
// All limiters share the existing Redis connection — no new infrastructure.
//
// Usage in an API route:
//
//   import { authLimiter, moveLimiter, consume } from '@/app/lib/rate-limit';
//
//   const limited = await consume(moveLimiter, request);
//   if (limited) return limited; // returns a 429 NextResponse
//
// Install: npm install rate-limiter-flexible ioredis
// (ioredis is already a transitive dep via BullMQ — just needs to be explicit)

import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import Redis from 'ioredis';
import { NextRequest, NextResponse } from 'next/server';

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL is not set');
}

// Parse REDIS_URL for ioredis (same helper pattern as queues.ts)
function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     parseInt(u.port || '6379', 10),
    password: u.password || undefined,
  };
}

// Single ioredis client shared across all limiters.
// Module-level singleton — not recreated per request.
let _redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!_redisClient) {
    const opts = parseRedisUrl(process.env.REDIS_URL!);
    _redisClient = new Redis(opts);
    _redisClient.on('error', (err) => console.error('[RateLimit] Redis error:', err));
  }
  return _redisClient;
}

// ─── Limiter definitions ────────────────────────────────────────────────────
//
// Each limiter is a module-level singleton.
// keyPrefix must be unique per limiter to avoid key collisions in Redis.

// Signup: 5 attempts per IP per 15 minutes
// Prevents bulk account creation.
export const signupLimiter = new RateLimiterRedis({
  storeClient: getRedisClient(),
  keyPrefix:   'rl:signup',
  points:      5,
  duration:    15 * 60,
});

// Login: 10 attempts per IP per 15 minutes
// Prevents credential stuffing without being too aggressive for real users.
export const loginLimiter = new RateLimiterRedis({
  storeClient: getRedisClient(),
  keyPrefix:   'rl:login',
  points:      10,
  duration:    15 * 60,
});

// Queue join: 10 attempts per user per minute
// A user legitimately joins/leaves a few times; 10 is generous.
export const queueLimiter = new RateLimiterRedis({
  storeClient: getRedisClient(),
  keyPrefix:   'rl:queue',
  points:      10,
  duration:    60,
});

// Move submission: 60 moves per user per minute (1/sec average)
// Chess moves are fast but 60/min is still 2x a bullet game pace.
export const moveLimiter = new RateLimiterRedis({
  storeClient: getRedisClient(),
  keyPrefix:   'rl:move',
  points:      60,
  duration:    60,
});

// Place (aux piece during prep): 20 per user per minute
// Prep phase is 60s max and players only have 6 points, so 20 is very generous.
export const placeLimiter = new RateLimiterRedis({
  storeClient: getRedisClient(),
  keyPrefix:   'rl:place',
  points:      20,
  duration:    60,
});

// Draft save: 30 per user per minute
// Autosave-style usage needs headroom; 30 is comfortable.
export const draftLimiter = new RateLimiterRedis({
  storeClient: getRedisClient(),
  keyPrefix:   'rl:draft',
  points:      30,
  duration:    60,
});

// General API: 120 per user per minute (catch-all for status/profile/leaderboard)
export const generalLimiter = new RateLimiterRedis({
  storeClient: getRedisClient(),
  keyPrefix:   'rl:general',
  points:      120,
  duration:    60,
});

// ─── consume() helper ───────────────────────────────────────────────────────
//
// Call at the top of any route handler. Returns a 429 NextResponse if the
// limit is exceeded, or null if the request is allowed.
//
// Key strategy:
//   - Auth routes: keyed by IP (user not yet known)
//   - Game/queue routes: keyed by userId (from session) — fairer than IP
//     since users behind NAT share an IP but have separate accounts.
//
// Usage:
//   const limited = await consume(moveLimiter, request, userId.toString());
//   if (limited) return limited;

export async function consume(
  limiter: RateLimiterRedis,
  request: NextRequest,
  key?: string,
): Promise<NextResponse | null> {
  // Fall back to IP if no key provided (auth routes)
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  const limitKey = key ?? ip;

  try {
    await limiter.consume(limitKey);
    return null; // allowed
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      const retryAfter = Math.ceil(err.msBeforeNext / 1000);
      return NextResponse.json(
        { error: 'Too many requests', retryAfter },
        {
          status: 429,
          headers: {
            'Retry-After':       retryAfter.toString(),
            'X-RateLimit-Reset': new Date(Date.now() + err.msBeforeNext).toISOString(),
          },
        }
      );
    }
    // Redis error — fail open (don't block users if Redis is temporarily down)
    console.error('[RateLimit] consume error:', err);
    return null;
  }
}