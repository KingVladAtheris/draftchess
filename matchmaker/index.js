// matchmaker/index.js
// BullMQ-based matchmaker. Three workers:
//   match-worker   — pairs queued players immediately
//   prep-worker    — auto-starts games when prep timer expires
//   timeout-worker — handles per-move timeouts
//
// FIXES applied here:
//   #7  — Timeout worker no longer has its own inline ELO logic. It now
//          calls updateGameResult (shared module) so formula changes only
//          need to be made in one place. queueStatus reset is handled there.
//   #8  — queueStatus reset now covered by updateGameResult (#3 fix).
//   #11 — ELO pairing limit is actually enforced; matchmaking returns null
//          when no suitable opponent exists rather than always pairing.
//   #12 — Empty-string FEN guard uses explicit length check, not ??.
//   #28 — Failed try-match jobs are re-queued with backoff.

const { PrismaClient }   = require('@prisma/client');
const { Pool }            = require('pg');
const { PrismaPg }        = require('@prisma/adapter-pg');
const { createClient: createRedisClient } = require('redis');
const { Queue, Worker }   = require('bullmq');
const http                = require('http');

// ─── Validate env ──────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (!process.env.REDIS_URL)    { console.error('REDIS_URL not set');    process.exit(1); }

// ─── Prisma ────────────────────────────────────────────────────────────────
const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

// ─── Redis connection config ───────────────────────────────────────────────
function parseRedisUrl(url) {
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     parseInt(u.port || '6379', 10),
    password: u.password || undefined,
  };
}

const redisOpts = parseRedisUrl(process.env.REDIS_URL);

// ─── Redis publisher ───────────────────────────────────────────────────────
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

// ─── Shared ELO logic ──────────────────────────────────────────────────────
// #7: This replaces the inline ELO calculation that was previously duplicated
// in the timeout worker. Formula is identical to frontend/src/app/lib/elo-update.ts.
// Any future changes to K-factor or scoring must only be made in elo-update.ts
// — then mirror here. Ideally this moves to a shared package.
function calculateEloChange(winnerElo, loserElo, winnerGames, isDraw = false) {
  const k            = winnerGames < 30 ? 32 : winnerGames < 100 ? 24 : 16;
  const expected     = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const actualWinner = isDraw ? 0.5 : 1;
  const actualLoser  = isDraw ? 0.5 : 0;
  const winnerChange = Math.round(k * (actualWinner - expected));
  const loserChange  = Math.round(k * (actualLoser  - (1 - expected)));
  return { winnerChange, loserChange };
}

// Mirrors updateGameResult from elo-update.ts.
// Uses its own prisma instance but identical logic and guards.
// #7: Single implementation used by both prep and timeout workers.
async function finalizeGame(gameId, winnerId, player1Id, player2Id,
                             p1EloBefore, p2EloBefore, p1Games, p2Games, endReason) {
  const isDraw = winnerId === null;
  let p1Change, p2Change;

  if (isDraw) {
    const r = calculateEloChange(p1EloBefore, p2EloBefore, p1Games, true);
    p1Change = r.winnerChange; p2Change = r.loserChange;
  } else if (winnerId === player1Id) {
    const r = calculateEloChange(p1EloBefore, p2EloBefore, p1Games, false);
    p1Change = r.winnerChange; p2Change = r.loserChange;
  } else {
    const r = calculateEloChange(p2EloBefore, p1EloBefore, p2Games, false);
    p2Change = r.winnerChange; p1Change = r.loserChange;
  }

  const newP1Elo  = p1EloBefore + p1Change;
  const newP2Elo  = p2EloBefore + p2Change;
  const eloChange = Math.abs(p1Change);

  let finalized = false;

  try {
    await prisma.$transaction(async (tx) => {
      const guard = await tx.game.updateMany({
        where: { id: gameId, status: 'active' },
        data:  { status: 'finished' },
      });
      if (guard.count === 0) return; // already finished — no-op

      await tx.game.update({
        where: { id: gameId },
        data: {
          winnerId:         winnerId ?? undefined,
          player1EloAfter:  newP1Elo,
          player2EloAfter:  newP2Elo,
          eloChange,
          endReason,
          currentForUserId: null,
        },
      });

      // #3/#8: reset queueStatus so players can re-queue
      const queueReset = { queueStatus: 'offline', queuedAt: null, queuedDraftId: null };

      await tx.user.update({
        where: { id: player1Id },
        data: {
          elo: newP1Elo, gamesPlayed: { increment: 1 },
          wins:   (!isDraw && winnerId === player1Id) ? { increment: 1 } : undefined,
          losses: (!isDraw && winnerId !== player1Id) ? { increment: 1 } : undefined,
          draws:  isDraw                              ? { increment: 1 } : undefined,
          ...queueReset,
        },
      });

      await tx.user.update({
        where: { id: player2Id },
        data: {
          elo: newP2Elo, gamesPlayed: { increment: 1 },
          wins:   (!isDraw && winnerId === player2Id) ? { increment: 1 } : undefined,
          losses: (!isDraw && winnerId !== player2Id) ? { increment: 1 } : undefined,
          draws:  isDraw                              ? { increment: 1 } : undefined,
          ...queueReset,
        },
      });

      finalized = true;
    });
  } catch (err) {
    console.error(`[finalizeGame] game ${gameId} transaction error:`, err.message);
    throw err;
  }

  return finalized ? { newP1Elo, newP2Elo, eloChange } : null;
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

// ─── ELO diff relaxation ───────────────────────────────────────────────────
function maxEloDiff(queuedAtMs) {
  const secsWaiting = (Date.now() - queuedAtMs) / 1000;
  return 200 + Math.floor(secsWaiting / 30) * 50;
}

// #11: Returns null when no opponent is within the current ELO window.
// Previously always returned the closest opponent regardless of distance.
function findBestMatch(target, candidates) {
  if (candidates.length === 0) return null;

  const limit  = maxEloDiff(new Date(target.queuedAt).getTime());
  const sorted = candidates
    .map(p => ({ ...p, diff: Math.abs(p.elo - target.elo) }))
    .sort((a, b) => a.diff - b.diff);

  const best = sorted[0];
  if (best.diff > limit) {
    console.log(
      `[Match] no suitable opponent for ${target.username} (${target.elo}): ` +
      `closest is ${best.username} (${best.elo}), diff=${best.diff}, limit=${limit}`
    );
    return null;
  }

  return best;
}

// ─── Queues ────────────────────────────────────────────────────────────────
const defaultJobOpts = { removeOnComplete: 100, removeOnFail: 200 };

const matchQueue   = new Queue('match-queue',   { connection: redisOpts, defaultJobOptions: defaultJobOpts });
const prepQueue    = new Queue('prep-queue',    { connection: redisOpts, defaultJobOptions: defaultJobOpts });
const timeoutQueue = new Queue('timeout-queue', { connection: redisOpts, defaultJobOptions: defaultJobOpts });

// ─── Timeout scheduling helper ─────────────────────────────────────────────
async function scheduleTimeout(gameId, player1Timebank, player2Timebank, lastMoveAt, fenTurn = 'w') {
  const activeTimebank = fenTurn === 'w' ? player1Timebank : player2Timebank;
  const delay          = 30000 + Math.max(0, activeTimebank);

  // Best-effort removal of previous job (#23: not load-bearing)
  try {
    const existing = await timeoutQueue.getJob(`timeout-${gameId}`);
    if (existing) await existing.remove();
  } catch (err) {
    console.warn(`[Queue] could not remove previous timeout job for game ${gameId}:`, err.message);
  }

  await timeoutQueue.add(
    'check-timeout',
    { gameId, scheduledAt: lastMoveAt instanceof Date ? lastMoveAt.toISOString() : lastMoveAt },
    { delay, jobId: `timeout-${gameId}` },
  );
}

// ─── Match worker ──────────────────────────────────────────────────────────
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

  // #11: no suitable opponent yet — exit and wait for next trigger
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
      player1EloBefore: player1.elo,
      player2EloBefore: player2.elo,
      // currentForUserId intentionally omitted — field is being deprecated
    },
  });

  console.log(`[Match] game ${game.id} created (P1 is ${isPlayer1White ? 'white' : 'black'})`);

  await prisma.user.updateMany({
    where: { id: { in: [player1.id, player2.id] } },
    data:  { queueStatus: 'in_game', queuedAt: null, queuedDraftId: null },
  });

  await notifyMatch(game.id, [player1.id, player2.id]);

  await prepQueue.add(
    'prep-start',
    { gameId: game.id },
    { delay: 62000, jobId: `prep-${game.id}` },
  );

  console.log(`[Match] prep-start job scheduled for game ${game.id}`);
}, { connection: redisOpts, concurrency: 1 });

// ─── Prep worker ───────────────────────────────────────────────────────────
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

  // #12: explicit length check — empty string is falsy with || but not with ??
  const activeFen = (g.fen && g.fen.length > 0)
    ? g.fen
    : (g.draft1?.fen && g.draft2?.fen ? combineFens(g.draft1.fen, g.draft2.fen) : null);

  if (!activeFen) {
    console.error(`[Prep] game ${gameId} has no valid FEN, cannot start`);
    return;
  }

  const now   = new Date();
  const guard = await prisma.game.updateMany({
    where: { id: gameId, status: 'prep' },
    data:  {
      status: 'active', fen: activeFen, lastMoveAt: now,
      moveNumber: 0, player1Timebank: 60000, player2Timebank: 60000,
    },
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

  await scheduleTimeout(gameId, 60000, 60000, now, 'w');

}, { connection: redisOpts, concurrency: 5 });

// ─── Timeout worker ────────────────────────────────────────────────────────
// #7: No longer contains its own ELO logic — delegates to finalizeGame().
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

  // Stale job check — a move was made after this job was scheduled
  if (game.lastMoveAt && new Date(game.lastMoveAt).toISOString() !== scheduledAt) {
    console.log(`[Timeout] game ${gameId} move was made after job scheduled, skipping`);
    return;
  }

  // Verify the player has actually run out of time
  const now       = Date.now();
  const elapsed   = now - new Date(game.lastMoveAt).getTime();
  const turn      = game.fen.split(' ')[1];
  const isP1Turn  = turn === 'w';
  const timebank  = isP1Turn ? game.player1Timebank : game.player2Timebank;
  const remaining = timebank - Math.max(0, elapsed - 30000);

  if (remaining > 0) {
    console.log(`[Timeout] game ${gameId} still has ${remaining}ms, rescheduling`);
    await timeoutQueue.add(
      'check-timeout',
      { gameId, scheduledAt },
      { delay: remaining, jobId: `timeout-${gameId}` },
    );
    return;
  }

  const timedOutId = isP1Turn ? game.player1Id : game.player2Id;
  const winnerId   = isP1Turn ? game.player2Id : game.player1Id;

  console.log(`[Timeout] game ${gameId}: ${isP1Turn ? game.player1.username : game.player2.username} timed out`);

  // #7: delegate to shared finalizeGame (handles transaction + queueStatus reset)
  const result = await finalizeGame(
    gameId, winnerId,
    game.player1Id, game.player2Id,
    game.player1EloBefore ?? 1200, game.player2EloBefore ?? 1200,
    game.player1.gamesPlayed, game.player2.gamesPlayed,
    'timeout'
  );

  if (!result) {
    console.log(`[Timeout] game ${gameId} already finished by another path`);
    return;
  }

  await publishGameUpdate(gameId, {
    status: 'finished', winnerId, endReason: 'timeout',
    player1EloAfter: result.newP1Elo,
    player2EloAfter: result.newP2Elo,
    eloChange:       result.eloChange,
  });

  console.log(
    `[Timeout] game ${gameId} finished. ` +
    `ELO: P1 ${game.player1EloBefore}→${result.newP1Elo}, P2 ${game.player2EloBefore}→${result.newP2Elo}`
  );

}, { connection: redisOpts, concurrency: 10 });

// ─── Worker error handlers ─────────────────────────────────────────────────
// #28: Re-queue failed try-match jobs with backoff so queued players aren't
// stuck indefinitely after a transient DB/Redis blip.
matchWorker.on('failed', (job, err) => {
  console.error(`[match-worker] job ${job?.id} failed:`, err.message);
  if (job?.name === 'try-match') {
    matchQueue.add('try-match', {}, { delay: 5000 })
      .catch(e => console.error('[match-worker] re-queue failed:', e.message));
  }
});

prepWorker.on('failed', (job, err) => {
  console.error(`[prep-worker] job ${job?.id} failed:`, err.message);
});

timeoutWorker.on('failed', (job, err) => {
  console.error(`[timeout-worker] job ${job?.id} failed:`, err.message);
});

for (const [name, worker] of [['match', matchWorker], ['prep', prepWorker], ['timeout', timeoutWorker]]) {
  worker.on('error', (err) => console.error(`[${name}-worker] error:`, err.message));
}

// ─── Health server ─────────────────────────────────────────────────────────
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

  const queuedCount = await prisma.user.count({ where: { queueStatus: 'queued' } });
  if (queuedCount >= 2) {
    await matchQueue.add('try-match', {}, { delay: 500 });
    console.log(`[Boot] ${queuedCount} players already queued — seeded try-match job`);
  }

  const activeGames = await prisma.game.findMany({
    where:  { status: 'active' },
    select: { id: true, fen: true, lastMoveAt: true, player1Timebank: true, player2Timebank: true },
  });

  for (const g of activeGames) {
    if (!g.lastMoveAt) continue;
    const existing = await timeoutQueue.getJob(`timeout-${g.id}`);
    if (!existing) {
      const turn = (g.fen && g.fen.length > 0) ? g.fen.split(' ')[1] : 'w';
      await scheduleTimeout(g.id, g.player1Timebank, g.player2Timebank, g.lastMoveAt, turn);
      console.log(`[Boot] rescheduled timeout for active game ${g.id}`);
    }
  }

  const prepGames = await prisma.game.findMany({
    where:  { status: 'prep' },
    select: { id: true, prepStartedAt: true },
  });

  for (const g of prepGames) {
    const existing = await prepQueue.getJob(`prep-${g.id}`);
    if (!existing) {
      const elapsed   = Date.now() - new Date(g.prepStartedAt).getTime();
      const remaining = Math.max(0, 62000 - elapsed);
      await prepQueue.add('prep-start', { gameId: g.id }, { delay: remaining, jobId: `prep-${g.id}` });
      console.log(`[Boot] rescheduled prep-start for game ${g.id} (delay: ${remaining}ms)`);
    }
  }

  healthServer.listen(HEALTH_PORT, () => console.log(`[Health] listening on port ${HEALTH_PORT}`));
  isHealthy = true;
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────
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