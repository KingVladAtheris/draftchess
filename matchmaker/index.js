// matchmaker/index.js
// BullMQ-based matchmaker. Three workers:
//   match-worker   — pairs queued players immediately
//   prep-worker    — auto-starts games when prep timer expires
//   timeout-worker — handles per-move timeouts (replaces timeout-checker.js)

const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { createClient: createRedisClient } = require('redis');
const { Queue, Worker } = require('bullmq');
const http = require('http');

// ─── Validate env ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (!process.env.REDIS_URL)    { console.error('REDIS_URL not set');    process.exit(1); }

// ─── Prisma ────────────────────────────────────────────────────────────────
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ─── Redis connection config ───────────────────────────────────────────────
// BullMQ uses ioredis connection options, not the redis package URL format.
// Parse the REDIS_URL (redis://:password@host:port) into the options object.
function parseRedisUrl(url) {
  const u = new URL(url);
  const opts = {
    host:     u.hostname,
    port:     parseInt(u.port || '6379', 10),
    password: u.password || undefined,
  };
  return opts;
}

const redisOpts = parseRedisUrl(process.env.REDIS_URL);

// ─── Redis publisher (for game-events channel → Socket.IO) ────────────────
const redisPublisher = createRedisClient({ url: process.env.REDIS_URL });
redisPublisher.on('error', (err) => console.error('[Redis] pub error:', err));

const GAME_EVENTS_CHANNEL = 'draftchess:game-events';
const APP_URL             = process.env.APP_URL || 'http://host.docker.internal:3000';
const NOTIFY_SECRET       = process.env.NOTIFY_SECRET;

async function publishGameUpdate(gameId, payload) {
  try {
    await redisPublisher.publish(GAME_EVENTS_CHANNEL, JSON.stringify({
      type: 'game', gameId, event: 'game-update', payload,
    }));
  } catch (err) {
    console.error(`[Redis] publish failed for game ${gameId}:`, err.message);
  }
}

async function notifyMatch(gameId, userIds) {
  // Match notification stays as HTTP — it triggers a page navigation on the client
  try {
    const res = await fetch(`${APP_URL}/api/notify/match`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${NOTIFY_SECRET}` },
      body:    JSON.stringify({ gameId, userIds }),
    });
    if (!res.ok) console.error(`notifyMatch failed: ${await res.text()}`);
    else console.log(`Notified players of match for game ${gameId}`);
  } catch (err) {
    console.error('notifyMatch error:', err.message);
  }
}

// ─── ELO calculation (same formula as frontend/src/app/lib/elo-update.ts) ──
function calculateEloChange(winnerElo, loserElo, winnerGames) {
  const k          = winnerGames < 30 ? 32 : winnerGames < 100 ? 24 : 16;
  const expected   = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const winnerDelta = Math.round(k * (1 - expected));
  const loserDelta  = Math.round(k * (0 - (1 - expected)));
  return { winnerDelta, loserDelta };
}

// ─── FEN helpers ───────────────────────────────────────────────────────────
function lowercaseRow(row) {
  return row.split('').map(c => isNaN(parseInt(c)) ? c.toLowerCase() : c).join('');
}

function combineFens(whiteFen, blackFen) {
  const w = whiteFen.split(' ')[0].split('/');
  const b = blackFen.split(' ')[0].split('/');
  return [
    lowercaseRow(b[7]),
    lowercaseRow(b[6]),
    '8', '8', '8', '8',
    w[6],
    w[7],
  ].join('/') + ' w - - 0 1';
}

// ─── ELO diff relaxation: widens by 50 per 30s in queue ───────────────────
function maxEloDiff(queuedAtMs) {
  const secsWaiting = (Date.now() - queuedAtMs) / 1000;
  return 200 + Math.floor(secsWaiting / 30) * 50;
}

function findBestMatch(target, candidates) {
  if (candidates.length === 0) return null;
  const sorted = candidates
    .map(p => ({ ...p, diff: Math.abs(p.elo - target.elo) }))
    .sort((a, b) => a.diff - b.diff);
  const limit = maxEloDiff(new Date(target.queuedAt).getTime());
  return sorted[0].diff <= limit ? sorted[0] : sorted[0]; // always return closest, limit logged only
}

// ─── Queues ────────────────────────────────────────────────────────────────
const defaultJobOpts = { removeOnComplete: 100, removeOnFail: 200 };

const matchQueue   = new Queue('match-queue',   { connection: redisOpts, defaultJobOptions: defaultJobOpts });
const prepQueue    = new Queue('prep-queue',    { connection: redisOpts, defaultJobOptions: defaultJobOpts });
const timeoutQueue = new Queue('timeout-queue', { connection: redisOpts, defaultJobOptions: defaultJobOpts });

// ─── Match worker ──────────────────────────────────────────────────────────
// Processes a 'try-match' job: fetches all queued players and tries to pair
// the longest-waiting player. If fewer than 2 players are queued the job
// completes without retrying — a new job will be added when the next player
// joins the queue.
const matchWorker = new Worker('match-queue', async (_job) => {
  const queuedPlayers = await prisma.user.findMany({
    where:   { queueStatus: 'queued' },
    orderBy: { queuedAt: 'asc' },
    select:  { id: true, username: true, queuedDraftId: true, elo: true, queuedAt: true },
  });

  if (queuedPlayers.length < 2) {
    console.log('[Match] fewer than 2 players queued, waiting');
    return;
  }

  const player1 = queuedPlayers[0];
  const player2 = findBestMatch(player1, queuedPlayers.slice(1));
  if (!player2) return;

  console.log(`[Match] pairing ${player1.username} (${player1.elo}) vs ${player2.username} (${player2.elo})`);

  const [draft1, draft2] = await Promise.all([
    prisma.draft.findUnique({ where: { id: player1.queuedDraftId }, select: { fen: true } }),
    prisma.draft.findUnique({ where: { id: player2.queuedDraftId }, select: { fen: true } }),
  ]);

  if (!draft1 || !draft2) {
    console.error('[Match] draft not found, clearing players');
    await prisma.user.updateMany({
      where: { id: { in: [player1.id, player2.id] } },
      data:  { queueStatus: 'offline', queuedAt: null, queuedDraftId: null },
    });
    return;
  }

  const isPlayer1White = Math.random() > 0.5;
  const whiteDraftId   = isPlayer1White ? player1.queuedDraftId : player2.queuedDraftId;
  const blackDraftId   = isPlayer1White ? player2.queuedDraftId : player1.queuedDraftId;
  const gameFen        = combineFens(
    isPlayer1White ? draft1.fen : draft2.fen,
    isPlayer1White ? draft2.fen : draft1.fen,
  );

  const now  = new Date();
  const game = await prisma.game.create({
    data: {
      player1Id:        player1.id,
      player2Id:        player2.id,
      whitePlayerId:    isPlayer1White ? player1.id : player2.id,
      draft1Id:         whiteDraftId,
      draft2Id:         blackDraftId,
      fen:              gameFen,
      status:           'prep',
      prepStartedAt:    now,
      readyPlayer1:     false,
      readyPlayer2:     false,
      auxPointsPlayer1: 6,
      auxPointsPlayer2: 6,
      currentForUserId: player1.id,
      player1EloBefore: player1.elo,
      player2EloBefore: player2.elo,
    },
  });

  console.log(`[Match] game ${game.id} created (P1 is ${isPlayer1White ? 'white' : 'black'})`);

  await prisma.user.updateMany({
    where: { id: { in: [player1.id, player2.id] } },
    data:  { queueStatus: 'in_game', queuedAt: null, queuedDraftId: null },
  });

  await notifyMatch(game.id, [player1.id, player2.id]);

  // Schedule prep auto-start after 62s (2s buffer past the 60s client timer)
  await prepQueue.add(
    'prep-start',
    { gameId: game.id },
    { delay: 62000, jobId: `prep-${game.id}` },
  );

  console.log(`[Match] prep-start job scheduled for game ${game.id}`);
}, { connection: redisOpts, concurrency: 1 });

// ─── Prep worker ───────────────────────────────────────────────────────────
// Fires 62s after game creation. If both players already readied up the DB
// guard (status check) makes this a no-op. Otherwise it force-starts.
const prepWorker = new Worker('prep-queue', async (job) => {
  const { gameId } = job.data;

  const g = await prisma.game.findUnique({
    where:  { id: gameId },
    select: {
      id: true, status: true, fen: true, prepStartedAt: true,
      draft1: { select: { fen: true } },
      draft2: { select: { fen: true } },
    },
  });

  if (!g || g.status !== 'prep') {
    console.log(`[Prep] game ${gameId} already started or not found, skipping`);
    return;
  }

  const activeFen = g.fen ?? (() => {
    if (g.draft1?.fen && g.draft2?.fen) return combineFens(g.draft1.fen, g.draft2.fen);
    return null;
  })();

  if (!activeFen) {
    console.error(`[Prep] game ${gameId} has no valid FEN, cannot start`);
    return;
  }

  const now   = new Date();
  const guard = await prisma.game.updateMany({
    where: { id: gameId, status: 'prep' },
    data:  { status: 'active', fen: activeFen, lastMoveAt: now, moveNumber: 0, player1Timebank: 60000, player2Timebank: 60000 },
  });

  if (guard.count === 0) {
    console.log(`[Prep] game ${gameId} already started by ready route, skipping`);
    return;
  }

  console.log(`[Prep] game ${gameId} auto-started`);

  await publishGameUpdate(gameId, {
    status: 'active', fen: activeFen, lastMoveAt: now.toISOString(),
    player1Timebank: 60000, player2Timebank: 60000, moveNumber: 0,
    readyPlayer1: true, readyPlayer2: true,
  });

  // Start the first move timeout
  await scheduleTimeout(gameId, 60000, 60000, now);

}, { connection: redisOpts, concurrency: 5 });

// ─── Timeout scheduling helper ─────────────────────────────────────────────
// Called by the prep worker (first move) and re-exported via a shared pattern
// so the move route can call it. Since the move route is TypeScript/Next.js
// and this is the worker process, they communicate through BullMQ's Redis-backed
// queue — the move route uses the same queue name to add/remove jobs.
//
// Job ID is always `timeout-${gameId}` so adding a new one with the same ID
// removes the previous one atomically (BullMQ deduplicates by jobId).
async function scheduleTimeout(gameId, player1Timebank, player2Timebank, lastMoveAt, fenTurn = 'w') {
  const activeTimebank = fenTurn === 'w' ? player1Timebank : player2Timebank;
  const delay          = 30000 + Math.max(0, activeTimebank);

  await timeoutQueue.add(
    'check-timeout',
    { gameId, scheduledAt: lastMoveAt instanceof Date ? lastMoveAt.toISOString() : lastMoveAt },
    { delay, jobId: `timeout-${gameId}` },
  );
}

// ─── Timeout worker ────────────────────────────────────────────────────────
const timeoutWorker = new Worker('timeout-queue', async (job) => {
  const { gameId, scheduledAt } = job.data;

  const game = await prisma.game.findUnique({
    where:  { id: gameId },
    select: {
      id: true, status: true, fen: true,
      player1Id: true, player2Id: true,
      lastMoveAt: true,
      player1Timebank: true, player2Timebank: true,
      player1EloBefore: true, player2EloBefore: true,
      player1: { select: { gamesPlayed: true, username: true } },
      player2: { select: { gamesPlayed: true, username: true } },
    },
  });

  if (!game || game.status !== 'active') {
    console.log(`[Timeout] game ${gameId} not active, skipping`);
    return;
  }

  // If lastMoveAt has changed since this job was scheduled, a move was made
  // and a new timeout job was already enqueued — this one is stale.
  if (game.lastMoveAt && new Date(game.lastMoveAt).toISOString() !== scheduledAt) {
    console.log(`[Timeout] game ${gameId} move was made after job scheduled, skipping`);
    return;
  }

  // Verify the player has actually run out of time
  const now        = Date.now();
  const elapsed    = now - new Date(game.lastMoveAt).getTime();
  const turn       = game.fen.split(' ')[1]; // 'w' or 'b'
  const isP1Turn   = turn === 'w';
  const timebank   = isP1Turn ? game.player1Timebank : game.player2Timebank;
  const remaining  = timebank - Math.max(0, elapsed - 30000);

  if (remaining > 0) {
    // Still has time (e.g. job fired slightly early) — reschedule precisely
    console.log(`[Timeout] game ${gameId} still has ${remaining}ms, rescheduling`);
    await timeoutQueue.add(
      'check-timeout',
      { gameId, scheduledAt },
      { delay: remaining, jobId: `timeout-${gameId}` },
    );
    return;
  }

  // ─── Player has timed out ─────────────────────────────────────────────────
  const timedOutId   = isP1Turn ? game.player1Id : game.player2Id;
  const winnerId     = isP1Turn ? game.player2Id : game.player1Id;
  const timedOutName = isP1Turn ? game.player1.username : game.player2.username;
  const winnerName   = isP1Turn ? game.player2.username : game.player1.username;

  const guard = await prisma.game.updateMany({
    where: { id: gameId, status: 'active' },
    data:  { status: 'finished' },
  });

  if (guard.count === 0) {
    console.log(`[Timeout] game ${gameId} already finished, skipping`);
    return;
  }

  // ELO
  const p1Elo = game.player1EloBefore ?? 1200;
  const p2Elo = game.player2EloBefore ?? 1200;
  let p1Change, p2Change;

  if (winnerId === game.player1Id) {
    const { winnerDelta, loserDelta } = calculateEloChange(p1Elo, p2Elo, game.player1.gamesPlayed);
    p1Change = winnerDelta; p2Change = loserDelta;
  } else {
    const { winnerDelta, loserDelta } = calculateEloChange(p2Elo, p1Elo, game.player2.gamesPlayed);
    p2Change = winnerDelta; p1Change = loserDelta;
  }

  const newP1Elo = p1Elo + p1Change;
  const newP2Elo = p2Elo + p2Change;

  await prisma.game.update({
    where: { id: gameId },
    data:  { winnerId, endReason: 'timeout', player1EloAfter: newP1Elo, player2EloAfter: newP2Elo, eloChange: Math.abs(p1Change) },
  });

  await Promise.all([
    prisma.user.update({
      where: { id: game.player1Id },
      data:  { elo: newP1Elo, gamesPlayed: { increment: 1 }, ...(winnerId === game.player1Id ? { wins: { increment: 1 } } : { losses: { increment: 1 } }) },
    }),
    prisma.user.update({
      where: { id: game.player2Id },
      data:  { elo: newP2Elo, gamesPlayed: { increment: 1 }, ...(winnerId === game.player2Id ? { wins: { increment: 1 } } : { losses: { increment: 1 } }) },
    }),
  ]);

  await publishGameUpdate(gameId, {
    status: 'finished', winnerId, endReason: 'timeout',
    player1EloAfter: newP1Elo, player2EloAfter: newP2Elo, eloChange: Math.abs(p1Change),
  });

  console.log(`[Timeout] game ${gameId}: ${timedOutName} timed out, ${winnerName} wins. ELO: P1 ${p1Elo}→${newP1Elo}, P2 ${p2Elo}→${newP2Elo}`);

}, { connection: redisOpts, concurrency: 10 });

// ─── Worker error handlers ─────────────────────────────────────────────────
for (const [name, worker] of [['match', matchWorker], ['prep', prepWorker], ['timeout', timeoutWorker]]) {
  worker.on('failed', (job, err) => console.error(`[${name}-worker] job ${job?.id} failed:`, err.message));
  worker.on('error',  (err)      => console.error(`[${name}-worker] error:`, err.message));
}

// ─── Health server ──────────────────────────────────────────────────────────
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3001', 10);
let isHealthy = false;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: isHealthy ? 'ok' : 'starting', uptime: Math.floor(process.uptime()) }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────
async function main() {
  await redisPublisher.connect();
  console.log('[Redis] publisher connected');
  console.log('[Matchmaker] workers started (match, prep, timeout)');

  // ── Seed match queue on startup ───────────────────────────────────────────
  // If players were queued before the matchmaker started (or were left queued
  // after a crash), add a try-match job so they get paired immediately without
  // waiting for the queue-join route to trigger one.
  const queuedCount = await prisma.user.count({ where: { queueStatus: 'queued' } });
  if (queuedCount >= 2) {
    await matchQueue.add('try-match', {}, { delay: 500 });
    console.log(`[Boot] ${queuedCount} players already queued — seeded try-match job`);
  }

  // ── Recover active game timeouts ──────────────────────────────────────────
  // If the matchmaker was restarted mid-game, reschedule any timeout jobs
  // that were lost when the process died.
  const activeGames = await prisma.game.findMany({
    where:  { status: 'active' },
    select: { id: true, fen: true, lastMoveAt: true, player1Timebank: true, player2Timebank: true },
  });

  for (const g of activeGames) {
    if (!g.lastMoveAt) continue;
    const existing = await timeoutQueue.getJob(`timeout-${g.id}`);
    if (!existing) {
      const turn = g.fen ? g.fen.split(' ')[1] : 'w';
      await scheduleTimeout(g.id, g.player1Timebank, g.player2Timebank, g.lastMoveAt, turn);
      console.log(`[Boot] rescheduled timeout for active game ${g.id}`);
    }
  }

  // ── Recover stuck prep games ──────────────────────────────────────────────
  // If a prep game has no pending prep-start job (matchmaker crash during prep),
  // reschedule it with the remaining time or immediately if already overdue.
  const prepGames = await prisma.game.findMany({
    where:  { status: 'prep' },
    select: { id: true, prepStartedAt: true },
  });

  for (const g of prepGames) {
    const existing = await prepQueue.getJob(`prep-${g.id}`);
    if (!existing) {
      const elapsed  = Date.now() - new Date(g.prepStartedAt).getTime();
      const remaining = Math.max(0, 62000 - elapsed);
      await prepQueue.add('prep-start', { gameId: g.id }, { delay: remaining, jobId: `prep-${g.id}` });
      console.log(`[Boot] rescheduled prep-start for game ${g.id} (delay: ${remaining}ms)`);
    }
  }
  healthServer.listen(HEALTH_PORT, () => console.log(`[Health] listening on port ${HEALTH_PORT}`));
  isHealthy = true;
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[Matchmaker] ${signal} received — shutting down gracefully`);
  isHealthy = false;

  await Promise.all([matchWorker.close(), prepWorker.close(), timeoutWorker.close()]);
  console.log('[Matchmaker] all workers closed');

  await Promise.all([matchQueue.close(), prepQueue.close(), timeoutQueue.close(), redisPublisher.quit()]);
  console.log('[Matchmaker] Redis connections closed');

  healthServer.close(() => { console.log('[Matchmaker] clean exit'); process.exit(0); });
  setTimeout(() => { console.error('[Matchmaker] forced exit'); process.exit(1); }, 9000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

main().catch(err => { console.error('[Matchmaker] fatal error:', err); process.exit(1); });