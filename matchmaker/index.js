// matchmaker/index.js
// CHANGES vs previous version:
//   - notifyMatch() now publishes to Redis channel instead of HTTP POST.
//   - finalizeGame(): currentForUserId removed (schema Step 1).
//   - MIN_ELO floor applied in finalizeGame() to mirror fen-utils change.
//   - Reconciliation worker added (Step 6) — see end of file.
//   - whitePlayerId bug fixed in timeout worker and scheduleTimeout.
//   - Env validation added.
//   - Structured logging via pino replacing all console.* calls.

const { PrismaClient }   = require('@prisma/client');
const { Pool }            = require('pg');
const { PrismaPg }        = require('@prisma/adapter-pg');
const { createClient: createRedisClient } = require('redis');
const { Queue, Worker }   = require('bullmq');
const http                = require('http');

require('./lib/env');
const { logger } = require('./lib/logger');

if (!process.env.DATABASE_URL) { logger.error('DATABASE_URL not set'); process.exit(1); }
if (!process.env.REDIS_URL)    { logger.error('REDIS_URL not set');    process.exit(1); }

const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma  = new PrismaClient({ adapter });

function parseRedisUrl(url) {
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     parseInt(u.port || '6379', 10),
    password: u.password || undefined,
  };
}

const redisOpts = parseRedisUrl(process.env.REDIS_URL);

const redisPublisher = createRedisClient({ url: process.env.REDIS_URL });
redisPublisher.on('error', (err) => logger.error('[Redis] pub error:', err));

const GAME_EVENTS_CHANNEL  = 'draftchess:game-events';
const MIN_ELO              = 100;

// ─── Mode config (mirrors src/app/lib/game-modes.ts) ──────────────────────
const MODE_CONFIG = {
  standard: { draftBudget: 33, auxPoints: 6  },
  pauper:   { draftBudget: 18, auxPoints: 3  },
  royal:    { draftBudget: 48, auxPoints: 12 },
};
const ELO_FIELD = {
  standard: 'eloStandard', pauper: 'eloPauper', royal: 'eloRoyal',
};
const GAMES_PLAYED_FIELD = {
  standard: 'gamesPlayedStandard', pauper: 'gamesPlayedPauper', royal: 'gamesPlayedRoyal',
};
const WINS_FIELD   = { standard: 'winsStandard',   pauper: 'winsPauper',   royal: 'winsRoyal'   };
const LOSSES_FIELD = { standard: 'lossesStandard', pauper: 'lossesPauper', royal: 'lossesRoyal' };
const DRAWS_FIELD  = { standard: 'drawsStandard',  pauper: 'drawsPauper',  royal: 'drawsRoyal'  };

// ─── Publish helpers ───────────────────────────────────────────────────────
async function publishEvent(type, payload) {
  try {
    await redisPublisher.publish(GAME_EVENTS_CHANNEL, JSON.stringify(payload));
  } catch (err) {
    logger.error(`[Redis] publish failed:`, err.message);
  }
}

async function publishGameUpdate(gameId, eventPayload) {
  await publishEvent('game', {
    type: 'game', gameId, event: 'game-update', payload: eventPayload,
  });
}

// ─── CHANGE: notifyMatch via Redis pub/sub ────────────────────────────────
// Previously this was an HTTP POST to /api/notify/match.
// Now we publish directly to the same Redis channel the socket server
// already subscribes to. The socket server's subscriber handles 'matched'
// events using the 'queue-user' type, which emits to queue-user-{userId} rooms.
// This means:
//   1. No HTTP dependency between matchmaker and Next.js.
//   2. Works with multiple Next.js instances (Redis fan-out handles delivery).
//   3. If a Next.js instance restarts mid-match, the client's reconnect
//      logic polls /api/queue/status and picks up the gameId from the DB.
async function notifyMatch(gameId, userIds) {
  for (const userId of userIds) {
    await publishEvent('queue-user', {
      type: 'queue-user', userId, event: 'matched', payload: { gameId },
    });
  }
  logger.info(`[Match] notified users ${userIds.join(', ')} of game ${gameId} via Redis`);
}

// ─── ELO helpers ───────────────────────────────────────────────────────────
function calculateEloChange(winnerElo, loserElo, winnerGames, isDraw = false) {
  const k        = winnerGames < 30 ? 32 : winnerGames < 100 ? 24 : 16;
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const rawWin   = Math.round(k * ((isDraw ? 0.5 : 1)   - expected));
  const rawLoss  = Math.round(k * ((isDraw ? 0.5 : 0)   - (1 - expected)));
  // Apply floor: loser cannot drop below MIN_ELO
  return {
    winnerChange: rawWin,
    loserChange:  Math.max(rawLoss, MIN_ELO - loserElo),
  };
}

async function finalizeGame(gameId, winnerId, player1Id, player2Id,
                             p1EloBefore, p2EloBefore, p1Games, p2Games, endReason, mode = 'standard', isFriendGame = false) {

  // Friend games: mark finished and clear queue state, but skip ELO / stat updates.
  if (isFriendGame) {
    let finalized = false;
    try {
      await prisma.$transaction(async (tx) => {
        const guard = await tx.game.updateMany({
          where: { id: gameId, status: 'active' },
          data:  { status: 'finished' },
        });
        if (guard.count === 0) return;
        await tx.game.update({
          where: { id: gameId },
          data:  { winnerId: winnerId ?? undefined, endReason },
        });
        const queueReset = { queueStatus: 'offline', queuedAt: null, queuedDraftId: null, queuedMode: null };
        await tx.user.update({ where: { id: player1Id }, data: queueReset });
        await tx.user.update({ where: { id: player2Id }, data: queueReset });
        finalized = true;
      });
    } catch (err) {
      logger.error(`[finalizeGame] game ${gameId} (friend) transaction error:`, err.message);
      throw err;
    }
    return finalized ? { newP1Elo: p1EloBefore, newP2Elo: p2EloBefore, eloChange: 0 } : null;
  }

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

  const newP1Elo  = Math.max(MIN_ELO, p1EloBefore + p1Change);
  const newP2Elo  = Math.max(MIN_ELO, p2EloBefore + p2Change);
  const eloChange = Math.abs(p1Change);

  let finalized = false;

  try {
    await prisma.$transaction(async (tx) => {
      const guard = await tx.game.updateMany({
        where: { id: gameId, status: 'active' },
        data:  { status: 'finished' },
      });
      if (guard.count === 0) return;

      await tx.game.update({
        where: { id: gameId },
        data: {
          winnerId:        winnerId ?? undefined,
          player1EloAfter: newP1Elo,
          player2EloAfter: newP2Elo,
          eloChange,
          endReason,
          // currentForUserId removed (Step 1)
        },
      });

      const eloF    = ELO_FIELD[mode]          || 'eloStandard';
      const gamesF  = GAMES_PLAYED_FIELD[mode] || 'gamesPlayedStandard';
      const winsF   = WINS_FIELD[mode]         || 'winsStandard';
      const lossesF = LOSSES_FIELD[mode]       || 'lossesStandard';
      const drawsF  = DRAWS_FIELD[mode]        || 'drawsStandard';
      const queueReset = { queueStatus: 'offline', queuedAt: null, queuedDraftId: null, queuedMode: null };

      await tx.user.update({
        where: { id: player1Id },
        data:  {
          [eloF]:   newP1Elo,
          [gamesF]: { increment: 1 },
          ...(!isDraw && winnerId === player1Id ? { [winsF]:   { increment: 1 } } : {}),
          ...(!isDraw && winnerId !== player1Id ? { [lossesF]: { increment: 1 } } : {}),
          ...(isDraw                            ? { [drawsF]:  { increment: 1 } } : {}),
          ...queueReset,
        },
      });

      await tx.user.update({
        where: { id: player2Id },
        data:  {
          [eloF]:   newP2Elo,
          [gamesF]: { increment: 1 },
          ...(!isDraw && winnerId === player2Id ? { [winsF]:   { increment: 1 } } : {}),
          ...(!isDraw && winnerId !== player2Id ? { [lossesF]: { increment: 1 } } : {}),
          ...(isDraw                            ? { [drawsF]:  { increment: 1 } } : {}),
          ...queueReset,
        },
      });

      finalized = true;
    });
  } catch (err) {
    logger.error(`[finalizeGame] game ${gameId} transaction error:`, err.message);
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
    lowercaseRow(b[7]), lowercaseRow(b[6]),
    '8', '8', '8', '8',
    w[6], w[7],
  ].join('/') + ' w - - 0 1';
}

// ─── ELO pairing ───────────────────────────────────────────────────────────
function maxEloDiff(queuedAtMs) {
  const secsWaiting = (Date.now() - queuedAtMs) / 1000;
  return 200 + Math.floor(secsWaiting / 30) * 50;
}
function findBestMatch(target, candidates) {
  if (candidates.length === 0) return null;
  // Only match players queued for the same mode
  const sameMode = candidates.filter(p => p.queuedMode === target.queuedMode);
  if (sameMode.length === 0) {
    logger.info(`[Match] no opponents in same mode (${target.queuedMode}) for ${target.username}`);
    return null;
  }
  const limit  = maxEloDiff(new Date(target.queuedAt).getTime());
  const modeEloField = ELO_FIELD[target.queuedMode] || 'eloStandard';
  const targetElo    = target[modeEloField] ?? 1200;
  const sorted = sameMode
    .map(p => ({ ...p, diff: Math.abs((p[modeEloField] ?? 1200) - targetElo) }))
    .sort((a, b) => a.diff - b.diff);
  const best = sorted[0];
  if (best.diff > limit) {
    logger.info(`[Match] no suitable opponent for ${target.username} (mode=${target.queuedMode}, diff=${best.diff}, limit=${limit})`);
    return null;
  }
  return best;
}

// ─── Queues ────────────────────────────────────────────────────────────────
const defaultJobOpts = { removeOnComplete: 100, removeOnFail: 200 };
const matchQueue        = new Queue('match-queue',        { connection: redisOpts, defaultJobOptions: defaultJobOpts });
const prepQueue         = new Queue('prep-queue',         { connection: redisOpts, defaultJobOptions: defaultJobOpts });
const timeoutQueue      = new Queue('timeout-queue',      { connection: redisOpts, defaultJobOptions: defaultJobOpts });
const reconcileQueue    = new Queue('reconcile-queue',    { connection: redisOpts, defaultJobOptions: defaultJobOpts });

// scheduleTimeout — delay = move limit + active player's timebank.
// fenTurn: 'w' or 'b'. whiteIsP1: whether whitePlayerId === player1Id.
// Both are needed to correctly identify which timebank is draining.
async function scheduleTimeout(gameId, player1Timebank, player2Timebank, lastMoveAt, fenTurn = 'w', whiteIsP1 = true) {
  const isP1Turn      = fenTurn === 'w' ? whiteIsP1 : !whiteIsP1;
  const activeTimebank = isP1Turn ? player1Timebank : player2Timebank;
  const delay          = 30000 + Math.max(0, activeTimebank);
  try {
    const existing = await timeoutQueue.getJob(`timeout-${gameId}`);
    if (existing) await existing.remove();
  } catch (err) {
    logger.warn(`[Queue] could not remove previous timeout job for game ${gameId}:`, err.message);
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
    select:  { id: true, username: true, queuedDraftId: true, queuedMode: true, queuedAt: true, eloStandard: true, eloPauper: true, eloRoyal: true },
  });

  if (queuedPlayers.length < 2) return;

  const player1 = queuedPlayers[0];
  const player2 = findBestMatch(player1, queuedPlayers.slice(1));
  if (!player2) return;

  const mode        = player1.queuedMode || 'standard';
  const modeEloField = ELO_FIELD[mode] || 'eloStandard';
  const p1Elo        = player1[modeEloField] ?? 1200;
  const p2Elo        = player2[modeEloField] ?? 1200;
  const auxPoints    = (MODE_CONFIG[mode] || MODE_CONFIG.standard).auxPoints;
  logger.info(`[Match] pairing ${player1.username} (${p1Elo}) vs ${player2.username} (${p2Elo}) mode=${mode}`);

  const [draft1, draft2] = await Promise.all([
    prisma.draft.findUnique({ where: { id: player1.queuedDraftId }, select: { fen: true } }),
    prisma.draft.findUnique({ where: { id: player2.queuedDraftId }, select: { fen: true } }),
  ]);

  if (!draft1 || !draft2) {
    logger.error('[Match] draft not found, clearing players');
    await prisma.user.updateMany({
      where: { id: { in: [player1.id, player2.id] } },
      data:  { queueStatus: 'offline', queuedAt: null, queuedDraftId: null },
    });
    return;
  }

  const isPlayer1White = Math.random() > 0.5;
  const gameFen = combineFens(
    isPlayer1White ? draft1.fen : draft2.fen,
    isPlayer1White ? draft2.fen : draft1.fen,
  );

  const now  = new Date();
  const game = await prisma.game.create({
    data: {
      player1Id:        player1.id,
      player2Id:        player2.id,
      whitePlayerId:    isPlayer1White ? player1.id : player2.id,
      draft1Id:         isPlayer1White ? player1.queuedDraftId : player2.queuedDraftId,
      draft2Id:         isPlayer1White ? player2.queuedDraftId : player1.queuedDraftId,
      fen:              gameFen,
      status:           'prep',
      mode,
      prepStartedAt:    now,
      readyPlayer1:     false,
      readyPlayer2:     false,
      auxPointsPlayer1: auxPoints,
      auxPointsPlayer2: auxPoints,
      player1EloBefore: p1Elo,
      player2EloBefore: p2Elo,
    },
  });

  await prisma.user.updateMany({
    where: { id: { in: [player1.id, player2.id] } },
    data:  { queueStatus: 'in_game', queuedAt: null, queuedDraftId: null },
  });

  // CHANGE: notify via Redis pub/sub, not HTTP
  await notifyMatch(game.id, [player1.id, player2.id]);

  await prepQueue.add(
    'prep-start',
    { gameId: game.id },
    { delay: 62000, jobId: `prep-${game.id}` },
  );

  logger.info(`[Match] game ${game.id} created`);
}, { connection: redisOpts, concurrency: 1 });

// ─── Prep worker ───────────────────────────────────────────────────────────
const prepWorker = new Worker('prep-queue', async (job) => {
  const { gameId } = job.data;

  const g = await prisma.game.findUnique({
    where:  { id: gameId },
    select: {
      id: true, status: true, fen: true, prepStartedAt: true,
      player1Id: true, whitePlayerId: true,
      draft1: { select: { fen: true } },
      draft2: { select: { fen: true } },
    },
  });

  if (!g || g.status !== 'prep') {
    logger.info(`[Prep] game ${gameId} already started or not found, skipping`);
    return;
  }

  const activeFen = (g.fen && g.fen.length > 0)
    ? g.fen
    : (g.draft1?.fen && g.draft2?.fen ? combineFens(g.draft1.fen, g.draft2.fen) : null);

  if (!activeFen) {
    logger.error(`[Prep] game ${gameId} has no valid FEN`);
    return;
  }

  const now   = new Date();
  const guard = await prisma.game.updateMany({
    where: { id: gameId, status: 'prep' },
    data:  { status: 'active', fen: activeFen, lastMoveAt: now, moveNumber: 0, player1Timebank: 60000, player2Timebank: 60000 },
  });

  if (guard.count === 0) {
    logger.info(`[Prep] game ${gameId} already started by ready route, skipping`);
    return;
  }

  await publishGameUpdate(gameId, {
    status: 'active', fen: activeFen, lastMoveAt: now.toISOString(),
    player1Timebank: 60000, player2Timebank: 60000, moveNumber: 0,
    readyPlayer1: true, readyPlayer2: true,
  });

  await scheduleTimeout(gameId, 60000, 60000, now, 'w', g.whitePlayerId === g.player1Id);
  logger.info(`[Prep] game ${gameId} auto-started`);

}, { connection: redisOpts, concurrency: 5 });

// ─── Timeout worker ────────────────────────────────────────────────────────
const timeoutWorker = new Worker('timeout-queue', async (job) => {
  const { gameId, scheduledAt } = job.data;

  const game = await prisma.game.findUnique({
    where:  { id: gameId },
    select: {
      id: true, status: true, fen: true, mode: true, isFriendGame: true,
      player1Id: true, player2Id: true, whitePlayerId: true,
      lastMoveAt: true, player1Timebank: true, player2Timebank: true,
      player1EloBefore: true, player2EloBefore: true,
      player1: { select: { gamesPlayedStandard: true, gamesPlayedPauper: true, gamesPlayedRoyal: true, username: true } },
      player2: { select: { gamesPlayedStandard: true, gamesPlayedPauper: true, gamesPlayedRoyal: true, username: true } },
    },
  });

  if (!game || game.status !== 'active') {
    logger.info(`[Timeout] game ${gameId} not active, skipping`);
    return;
  }

  if (game.lastMoveAt && new Date(game.lastMoveAt).toISOString() !== scheduledAt) {
    logger.info(`[Timeout] game ${gameId} stale job, skipping`);
    return;
  }

  const now     = Date.now();
  const elapsed = now - new Date(game.lastMoveAt).getTime();
  const turn    = game.fen.split(' ')[1]; // 'w' or 'b'

  // Map FEN turn → which player slot (p1/p2) is active.
  // white could be player1 or player2 — whitePlayerId is the source of truth.
  const whiteIsP1 = game.whitePlayerId === game.player1Id;
  const isP1Turn  = turn === 'w' ? whiteIsP1 : !whiteIsP1;

  const timebank  = isP1Turn ? game.player1Timebank : game.player2Timebank;
  const remaining = timebank - Math.max(0, elapsed - 30000);

  if (remaining > 0) {
    await timeoutQueue.add(
      'check-timeout',
      { gameId, scheduledAt },
      { delay: remaining, jobId: `timeout-${gameId}` },
    );
    return;
  }

  const winnerId = isP1Turn ? game.player2Id : game.player1Id;

  const gameMode    = game.mode || 'standard';
  const gamesField  = GAMES_PLAYED_FIELD[gameMode] || 'gamesPlayedStandard';
  const result = await finalizeGame(
    gameId, winnerId,
    game.player1Id, game.player2Id,
    game.player1EloBefore ?? 1200, game.player2EloBefore ?? 1200,
    game.player1[gamesField] ?? 0, game.player2[gamesField] ?? 0,
    'timeout', gameMode, game.isFriendGame ?? false
  );

  if (!result) {
    logger.info(`[Timeout] game ${gameId} already finished`);
    return;
  }

  await publishGameUpdate(gameId, {
    status: 'finished', winnerId, endReason: 'timeout',
    player1EloAfter: result.newP1Elo,
    player2EloAfter: result.newP2Elo,
    eloChange:       result.eloChange,
  });

}, { connection: redisOpts, concurrency: 10 });

// ─── Reconciliation worker (Step 6) ───────────────────────────────────────
// Runs every 5 minutes. Finds active games that have been silent longer than
// their total possible time (30s move + full timebank) and force-finishes them.
// This is the safety net for jobs that were lost from Redis without being run.
const reconcileWorker = new Worker('reconcile-queue', async (_job) => {
  const MOVE_TIME_MS    = 30_000;
  const MAX_TIMEBANK_MS = 60_000;
  // A game silent for longer than this MUST have timed out
  const staleCutoff = new Date(Date.now() - (MOVE_TIME_MS + MAX_TIMEBANK_MS + 5_000));

  const staleGames = await prisma.game.findMany({
    where: {
      status:    'active',
      lastMoveAt: { lt: staleCutoff },
    },
    select: {
      id: true, fen: true, lastMoveAt: true, mode: true, isFriendGame: true,
      player1Id: true, player2Id: true, whitePlayerId: true,
      player1Timebank: true, player2Timebank: true,
      player1EloBefore: true, player2EloBefore: true,
      player1: { select: { gamesPlayedStandard: true, gamesPlayedPauper: true, gamesPlayedRoyal: true } },
      player2: { select: { gamesPlayedStandard: true, gamesPlayedPauper: true, gamesPlayedRoyal: true } },
    },
  });

  if (staleGames.length === 0) return;
  logger.info(`[Reconcile] found ${staleGames.length} stale active game(s)`);

  for (const game of staleGames) {
    try {
      // Check if a timeout job already exists for this game (might be delayed)
      const existing = await timeoutQueue.getJob(`timeout-${game.id}`);
      if (existing) {
        logger.info(`[Reconcile] game ${game.id} has a pending timeout job, skipping`);
        continue;
      }

      // Map FEN turn → active player using whitePlayerId as source of truth
      const fenTurn   = (game.fen && game.fen.length > 0) ? game.fen.split(' ')[1] : 'w';
      const whiteIsP1 = game.whitePlayerId === game.player1Id;
      const isP1Turn  = fenTurn === 'w' ? whiteIsP1 : !whiteIsP1;
      const winnerId  = isP1Turn ? game.player2Id : game.player1Id;

      logger.info(`[Reconcile] force-finishing game ${game.id} (winner: ${winnerId})`);

      const rMode      = game.mode || 'standard';
      const rGamesField = GAMES_PLAYED_FIELD[rMode] || 'gamesPlayedStandard';
      const result = await finalizeGame(
        game.id, winnerId,
        game.player1Id, game.player2Id,
        game.player1EloBefore ?? 1200, game.player2EloBefore ?? 1200,
        game.player1[rGamesField] ?? 0, game.player2[rGamesField] ?? 0,
        'timeout', rMode, game.isFriendGame ?? false
      );

      if (result) {
        await publishGameUpdate(game.id, {
          status: 'finished', winnerId, endReason: 'timeout',
          player1EloAfter: result.newP1Elo,
          player2EloAfter: result.newP2Elo,
          eloChange:       result.eloChange,
        });
      }
    } catch (err) {
      logger.error(`[Reconcile] failed to process game ${game.id}:`, err.message);
    }
  }
}, { connection: redisOpts, concurrency: 1 });

// ─── Worker error handlers ─────────────────────────────────────────────────
matchWorker.on('failed', (job, err) => {
  logger.error(`[match-worker] job ${job?.id} failed:`, err.message);
  if (job?.name === 'try-match') {
    matchQueue.add('try-match', {}, { delay: 5000 })
      .catch(e => logger.error('[match-worker] re-queue failed:', e.message));
  }
});
prepWorker.on('failed',      (job, err) => logger.error(`[prep-worker] ${job?.id} failed:`, err.message));
timeoutWorker.on('failed',   (job, err) => logger.error(`[timeout-worker] ${job?.id} failed:`, err.message));
reconcileWorker.on('failed', (job, err) => logger.error(`[reconcile-worker] ${job?.id} failed:`, err.message));

for (const [name, w] of [
  ['match', matchWorker], ['prep', prepWorker],
  ['timeout', timeoutWorker], ['reconcile', reconcileWorker],
]) {
  w.on('error', (err) => logger.error(`[${name}-worker] error:`, err.message));
}

// ─── Health server ─────────────────────────────────────────────────────────
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '3001', 10);
let isHealthy = false;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(isHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: isHealthy ? 'ok' : 'starting', uptime: Math.floor(process.uptime()) }));
  } else {
    res.writeHead(404); res.end();
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────
async function main() {
  await redisPublisher.connect();
  logger.info('[Redis] publisher connected');
  logger.info('[Matchmaker] workers started (match, prep, timeout, reconcile)');

  // Seed try-match if players are waiting
  const queuedCount = await prisma.user.count({ where: { queueStatus: 'queued' } });
  if (queuedCount >= 2) {
    await matchQueue.add('try-match', {}, { delay: 500 });
    logger.info(`[Boot] seeded try-match (${queuedCount} queued players)`);
  }

  // Reschedule timeout jobs for active games
  const activeGames = await prisma.game.findMany({
    where:  { status: 'active' },
    select: { id: true, fen: true, lastMoveAt: true, player1Id: true, whitePlayerId: true, player1Timebank: true, player2Timebank: true },
  });
  for (const g of activeGames) {
    if (!g.lastMoveAt) continue;
    const existing = await timeoutQueue.getJob(`timeout-${g.id}`);
    if (!existing) {
      const turn      = (g.fen && g.fen.length > 0) ? g.fen.split(' ')[1] : 'w';
      const whiteIsP1 = g.whitePlayerId === g.player1Id;
      await scheduleTimeout(g.id, g.player1Timebank, g.player2Timebank, g.lastMoveAt, turn, whiteIsP1);
      logger.info(`[Boot] rescheduled timeout for game ${g.id}`);
    }
  }

  // Reschedule prep jobs
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
      logger.info(`[Boot] rescheduled prep-start for game ${g.id}`);
    }
  }

  // Schedule first reconciliation run, then repeat every 5 minutes
  await reconcileQueue.add('reconcile', {}, { jobId: 'reconcile-singleton', repeat: { every: 5 * 60 * 1000 } });
  logger.info('[Boot] reconciliation job scheduled (every 5 min)');

  healthServer.listen(HEALTH_PORT, () => logger.info(`[Health] listening on port ${HEALTH_PORT}`));
  isHealthy = true;
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────
async function shutdown(signal) {
  logger.info(`[Matchmaker] ${signal} — shutting down`);
  isHealthy = false;
  await Promise.all([
    matchWorker.close(), prepWorker.close(),
    timeoutWorker.close(), reconcileWorker.close(),
  ]);
  await Promise.all([
    matchQueue.close(), prepQueue.close(),
    timeoutQueue.close(), reconcileQueue.close(),
    redisPublisher.quit(),
  ]);
  healthServer.close(() => { logger.info('[Matchmaker] clean exit'); process.exit(0); });
  setTimeout(() => process.exit(1), 9000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
main().catch(err => { logger.error('[Matchmaker] fatal:', err); process.exit(1); });
