// src/app/lib/queues.ts
// BullMQ queue instances used by Next.js API routes to schedule and cancel
// timeout jobs. Workers run in the matchmaker container — these are just
// queue clients (no workers here).

import { Queue } from "bullmq";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not set");
}

// Parse redis://:password@host:port → ioredis connection options.
// BullMQ uses ioredis which takes host/port/password, not a URL string.
function parseRedisUrl(url: string) {
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     parseInt(u.port || "6379", 10),
    password: u.password || undefined,
  };
}

const redisOpts = parseRedisUrl(process.env.REDIS_URL);

// Keep queue instances as module-level singletons so they are not
// re-created on every API route call (Next.js reuses module instances
// across requests in the same process).
let _timeoutQueue: Queue | null = null;
let _matchQueue:   Queue | null = null;

export function getTimeoutQueue(): Queue {
  if (!_timeoutQueue) {
    _timeoutQueue = new Queue("timeout-queue", {
      connection:         redisOpts,
      defaultJobOptions:  { removeOnComplete: 100, removeOnFail: 200 },
    });
  }
  return _timeoutQueue;
}

export function getMatchQueue(): Queue {
  if (!_matchQueue) {
    _matchQueue = new Queue("match-queue", {
      connection:        redisOpts,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 200 },
    });
  }
  return _matchQueue;
}

/**
 * Schedule (or replace) the timeout job for a game.
 * Job ID is `timeout-${gameId}` — BullMQ will replace an existing delayed
 * job with the same ID, so calling this after every move automatically
 * cancels the previous timer.
 *
 * delay = MOVE_TIME_LIMIT + active player's timebank
 */
export async function scheduleTimeoutJob(
  gameId:          number,
  player1Timebank: number,
  player2Timebank: number,
  lastMoveAt:      Date,
  fenTurn:         string   // "w" or "b"
): Promise<void> {
  const MOVE_TIME_LIMIT = 30_000;
  const activeTimebank  = fenTurn === "w" ? player1Timebank : player2Timebank;
  const delay           = MOVE_TIME_LIMIT + Math.max(0, activeTimebank);

  const q = getTimeoutQueue();

  // Remove the existing job for this game before adding the new one.
  // BullMQ's jobId deduplication only prevents duplicates in the waiting
  // state — a delayed job must be explicitly removed first.
  try {
    const existing = await q.getJob(`timeout-${gameId}`);
    if (existing) await existing.remove();
  } catch {
    // Job may have already been processed — safe to ignore
  }

  await q.add(
    "check-timeout",
    { gameId, scheduledAt: lastMoveAt.toISOString() },
    { delay, jobId: `timeout-${gameId}` },
  );
}

/**
 * Cancel the timeout job for a game (used on resign, checkmate, draw, etc.)
 */
export async function cancelTimeoutJob(gameId: number): Promise<void> {
  try {
    const q   = getTimeoutQueue();
    const job = await q.getJob(`timeout-${gameId}`);
    if (job) await job.remove();
  } catch {
    // Safe to ignore — job may already be gone
  }
}

let _prepQueue: Queue | null = null;

export function getPrepQueue(): Queue {
  if (!_prepQueue) {
    _prepQueue = new Queue("prep-queue", {
      connection:        redisOpts,
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 200 },
    });
  }
  return _prepQueue;
}

/**
 * Cancel the prep auto-start job when both players ready up early.
 */
export async function cancelPrepJob(gameId: number): Promise<void> {
  try {
    const q   = getPrepQueue();
    const job = await q.getJob(`prep-${gameId}`);
    if (job) await job.remove();
  } catch {
    // Safe to ignore
  }
}
