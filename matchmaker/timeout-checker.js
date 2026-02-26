// matchmaker/timeout-checker.js
// Checks for timed-out games every 5 seconds.
// When a timeout is detected, updates the DB and notifies players
// via the main app's /api/notify/game-update HTTP endpoint
// (which relays through the main server's Socket.IO instance).

const { PrismaClient } = require('@prisma/client');
const { createClient: createRedisClient } = require('redis');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set!');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const APP_URL = process.env.APP_URL || 'http://host.docker.internal:3000';
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
const MOVE_TIME_LIMIT = 30000; // ms
const GAME_EVENTS_CHANNEL = 'draftchess:game-events';

let redisPublisher = null;

async function initRedis() {
  if (!process.env.REDIS_URL) {
    console.warn('[TimeoutChecker] REDIS_URL not set — falling back to HTTP notify');
    return;
  }
  redisPublisher = createRedisClient({ url: process.env.REDIS_URL });
  redisPublisher.on('error', (err) => console.error('[Redis] error:', err));
  redisPublisher.on('reconnecting', () => console.warn('[Redis] reconnecting...'));
  await redisPublisher.connect();
  console.log('[Redis] publisher connected');
}

console.log('Timeout checker initialized');

function calculateEloChange(winnerElo, loserElo, winnerGames) {
  const kFactor = winnerGames < 30 ? 32 : winnerGames < 100 ? 24 : 16;
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 - expectedWinner;
  const winnerChange = Math.round(kFactor * (1 - expectedWinner));
  const loserChange = Math.round(kFactor * (0 - expectedLoser));
  return { winnerChange, loserChange };
}

async function notifyGameUpdate(gameId, payload) {
  if (redisPublisher) {
    try {
      await redisPublisher.publish(GAME_EVENTS_CHANNEL, JSON.stringify({
        type: 'game',
        gameId,
        event: 'game-update',
        payload,
      }));
    } catch (err) {
      console.error(`[Redis] publish failed for game ${gameId}:`, err.message);
    }
  } else {
    // Fallback: HTTP notify (used if Redis is unavailable)
    try {
      const res = await fetch(`${APP_URL}/api/notify/game-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${NOTIFY_SECRET}`,
        },
        body: JSON.stringify({ gameId, payload }),
      });
      if (!res.ok) {
        console.error(`notifyGameUpdate HTTP fallback failed for game ${gameId}: ${await res.text()}`);
      }
    } catch (err) {
      console.error(`notifyGameUpdate HTTP fallback error for game ${gameId}:`, err.message);
    }
  }
}

async function checkTimeouts() {
  try {
    const activeGames = await prisma.game.findMany({
      where: { status: 'active' },
      select: {
        id: true,
        fen: true,
        player1Id: true,
        player2Id: true,
        lastMoveAt: true,
        player1Timebank: true,
        player2Timebank: true,
        player1EloBefore: true,
        player2EloBefore: true,
        player1: { select: { gamesPlayed: true, username: true } },
        player2: { select: { gamesPlayed: true, username: true } },
      },
    });

    if (activeGames.length === 0) return;

    const now = new Date();

    for (const game of activeGames) {
      if (!game.lastMoveAt || !game.fen) continue;

      const elapsedMs = now.getTime() - new Date(game.lastMoveAt).getTime();
      if (elapsedMs <= MOVE_TIME_LIMIT) continue;

      // Determine whose turn it is from FEN
      const turn = game.fen.split(' ')[1]; // "w" or "b"
      const isPlayer1Turn = turn === 'w';
      const currentPlayerTimebank = isPlayer1Turn ? game.player1Timebank : game.player2Timebank;
      const timebankUsed = elapsedMs - MOVE_TIME_LIMIT;
      const remainingTimebank = currentPlayerTimebank - timebankUsed;

      if (remainingTimebank > 0) continue;

      // Player has timed out
      const timedOutPlayerId = isPlayer1Turn ? game.player1Id : game.player2Id;
      const winnerId = isPlayer1Turn ? game.player2Id : game.player1Id;
      const timedOutUsername = isPlayer1Turn ? game.player1.username : game.player2.username;
      const winnerUsername = isPlayer1Turn ? game.player2.username : game.player1.username;

      // ─── DB-level guard: only update if still active ─────────────────────
      const guard = await prisma.game.updateMany({
        where: { id: game.id, status: 'active' },
        data: { status: 'finished' },
      });

      if (guard.count === 0) {
        // Already processed (race with move/route.ts)
        console.log(`Game ${game.id}: timeout already handled, skipping`);
        continue;
      }

      // Calculate ELO
      const player1Elo = game.player1EloBefore ?? 1200;
      const player2Elo = game.player2EloBefore ?? 1200;

      let player1EloChange, player2EloChange;
      if (winnerId === game.player1Id) {
        const r = calculateEloChange(player1Elo, player2Elo, game.player1.gamesPlayed);
        player1EloChange = r.winnerChange;
        player2EloChange = r.loserChange;
      } else {
        const r = calculateEloChange(player2Elo, player1Elo, game.player2.gamesPlayed);
        player2EloChange = r.winnerChange;
        player1EloChange = r.loserChange;
      }

      const newPlayer1Elo = player1Elo + player1EloChange;
      const newPlayer2Elo = player2Elo + player2EloChange;
      const eloChange = Math.abs(player1EloChange);

      await prisma.game.update({
        where: { id: game.id },
        data: {
          winnerId,
          endReason: 'timeout',
          player1EloAfter: newPlayer1Elo,
          player2EloAfter: newPlayer2Elo,
          eloChange,
        },
      });

      await prisma.user.update({
        where: { id: game.player1Id },
        data: {
          elo: newPlayer1Elo,
          gamesPlayed: { increment: 1 },
          wins:   winnerId === game.player1Id ? { increment: 1 } : undefined,
          losses: winnerId !== game.player1Id ? { increment: 1 } : undefined,
        },
      });

      await prisma.user.update({
        where: { id: game.player2Id },
        data: {
          elo: newPlayer2Elo,
          gamesPlayed: { increment: 1 },
          wins:   winnerId === game.player2Id ? { increment: 1 } : undefined,
          losses: winnerId !== game.player2Id ? { increment: 1 } : undefined,
        },
      });

      // Notify players via HTTP → Socket.IO relay
      await notifyGameUpdate(game.id, {
        status: 'finished',
        winnerId,
        endReason: 'timeout',
        player1EloAfter: newPlayer1Elo,
        player2EloAfter: newPlayer2Elo,
        eloChange,
      });

      console.log(
        `Game ${game.id} TIMEOUT: ${timedOutUsername} ran out of time, ` +
        `${winnerUsername} wins. ELO: P1 ${player1Elo}→${newPlayer1Elo}, P2 ${player2Elo}→${newPlayer2Elo}`
      );
    }
  } catch (err) {
    console.error('Timeout checker error:', err);
  }
}

async function run() {
  console.log('Timeout checker running (every 5s)');
  while (true) {
    await checkTimeouts();
    await new Promise(r => setTimeout(r, 5000));
  }
}

initRedis()
  .then(() => run())
  .catch(err => {
    console.error('Fatal crash:', err);
    process.exit(1);
  });