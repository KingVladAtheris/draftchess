// matchmaker/index.js
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
const GAME_EVENTS_CHANNEL = 'draftchess:game-events';

// Redis client for publishing game events directly to the frontend server.
// This replaces the HTTP notify relay — no round-trip, no dependency on the
// frontend's HTTP server being up at the exact moment of publish.
let redisPublisher = null;

async function initRedis() {
  if (!process.env.REDIS_URL) {
    console.warn('[Matchmaker] REDIS_URL not set — falling back to HTTP notify');
    return;
  }
  redisPublisher = createRedisClient({ url: process.env.REDIS_URL });
  redisPublisher.on('error', (err) => console.error('[Redis] error:', err));
  redisPublisher.on('reconnecting', () => console.warn('[Redis] reconnecting...'));
  await redisPublisher.connect();
  console.log('[Redis] publisher connected');
}

console.log('Matchmaker initialized');

function lowercaseRow(row) {
  return row.split('').map(c => isNaN(parseInt(c)) ? c.toLowerCase() : c).join('');
}

async function combineFens(whiteFen, blackFen) {
  const whiteRows = whiteFen.split(' ')[0].split('/');
  const blackRows = blackFen.split(' ')[0].split('/');
  const gameRows = [
    lowercaseRow(blackRows[7]),  // rank 8
    lowercaseRow(blackRows[6]),  // rank 7
    '8', '8', '8', '8',         // ranks 6-3
    whiteRows[6],                // rank 2
    whiteRows[7],                // rank 1
  ];
  return gameRows.join('/') + ' w - - 0 1';
}

function findBestMatch(targetPlayer, availablePlayers) {
  if (availablePlayers.length === 0) return null;

  const sorted = availablePlayers
    .map(p => ({ ...p, eloDiff: Math.abs(p.elo - targetPlayer.elo) }))
    .sort((a, b) => a.eloDiff - b.eloDiff);

  const MAX_ELO_DIFF = 200;
  const inRange = sorted.filter(p => p.eloDiff <= MAX_ELO_DIFF);

  if (inRange.length > 0) {
    console.log(`Match within ${MAX_ELO_DIFF} ELO (diff: ${inRange[0].eloDiff})`);
    return inRange[0];
  }

  console.log(`No close match — pairing closest (diff: ${sorted[0].eloDiff})`);
  return sorted[0];
}

async function notifyMatch(gameId, userIds) {
  try {
    const res = await fetch(`${APP_URL}/api/notify/match`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NOTIFY_SECRET}`,
      },
      body: JSON.stringify({ gameId, userIds }),
    });
    if (!res.ok) {
      console.error(`notifyMatch failed: ${await res.text()}`);
    } else {
      console.log(`Notified players of match for game ${gameId}`);
    }
  } catch (err) {
    console.error('notifyMatch fetch error:', err.message);
  }
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

async function runMatchmaker() {
  console.log('Matchmaker loop starting');

  while (true) {
    console.log(`[${new Date().toISOString()}] Checking queue...`);

    try {
      // ─── Match queued players ───────────────────────────────────────────
      const count = await prisma.user.count({ where: { queueStatus: 'queued' } });
      console.log(`Queued players: ${count}`);

      if (count >= 2) {
        const queuedPlayers = await prisma.user.findMany({
          where: { queueStatus: 'queued' },
          orderBy: { queuedAt: 'asc' },
          select: {
            id: true,
            username: true,
            queuedDraftId: true,
            elo: true,
            queuedAt: true,
          },
        });

        const player1 = queuedPlayers[0];
        const player2 = findBestMatch(player1, queuedPlayers.slice(1));

        if (player2) {
          console.log(`Pairing ${player1.username} (ELO: ${player1.elo}) vs ${player2.username} (ELO: ${player2.elo})`);

          const draft1 = await prisma.draft.findUnique({
            where: { id: player1.queuedDraftId },
            select: { fen: true },
          });
          const draft2 = await prisma.draft.findUnique({
            where: { id: player2.queuedDraftId },
            select: { fen: true },
          });

          if (!draft1 || !draft2) {
            console.error('Draft not found for one or both players');
            await prisma.user.updateMany({
              where: { id: { in: [player1.id, player2.id] } },
              data: { queueStatus: 'offline', queuedAt: null, queuedDraftId: null },
            });
          } else {
            // Randomly assign colors. draft1/draft2 MUST always be white's/black's
            // draft respectively -- buildCombinedDraftFen and all masking code rely on
            // draft1 = white draft, draft2 = black draft.
            const isPlayer1White = Math.random() > 0.5;

            const whiteDraftId  = isPlayer1White ? player1.queuedDraftId : player2.queuedDraftId;
            const blackDraftId  = isPlayer1White ? player2.queuedDraftId : player1.queuedDraftId;
            const whiteDraftFen = isPlayer1White ? draft1.fen : draft2.fen;
            const blackDraftFen = isPlayer1White ? draft2.fen : draft1.fen;

            const gameFen = await combineFens(whiteDraftFen, blackDraftFen);

            const now = new Date();

            const game = await prisma.game.create({
              data: {
                player1Id: player1.id,
                player2Id: player2.id,
                // draft1 = white's draft, draft2 = black's draft -- always
                draft1Id: whiteDraftId,
                draft2Id: blackDraftId,
                fen: gameFen,
                status: 'prep',
                prepStartedAt: now,
                readyPlayer1: false,
                readyPlayer2: false,
                auxPointsPlayer1: 6,
                auxPointsPlayer2: 6,
                // whitePlayerId: the actual user playing white — never changes
                whitePlayerId: isPlayer1White ? player1.id : player2.id,
                currentForUserId: player1.id,
                player1EloBefore: player1.elo,
                player2EloBefore: player2.elo,
                // lastMoveAt is intentionally null during prep —
                // it will be set when the game goes active
              },
            });

            console.log(`Game created: ${game.id} (P1 ${isPlayer1White ? 'white' : 'black'})`);

            await notifyMatch(game.id, [player1.id, player2.id]);

            await prisma.user.updateMany({
              where: { id: { in: [player1.id, player2.id] } },
              data: { queueStatus: 'in_game', queuedAt: null, queuedDraftId: null },
            });
          }
        }
      }

      // ─── Auto-start prep games that have timed out ──────────────────────
      const prepGames = await prisma.game.findMany({
        where: { status: 'prep' },
        select: {
          id: true,
          prepStartedAt: true,
          readyPlayer1: true,
          readyPlayer2: true,
          fen: true,
          draft1: { select: { fen: true } },
          draft2: { select: { fen: true } },
        },
      });

      for (const g of prepGames) {
        const elapsed = (Date.now() - new Date(g.prepStartedAt).getTime()) / 1000;
        const shouldStart = (g.readyPlayer1 && g.readyPlayer2) || elapsed > 60;

        if (!shouldStart) continue;

        // Use current game FEN to preserve any aux placements made before timeout
        // If no fen is set for some reason, fall back to a rebuild
        const activeFen = g.fen ?? (() => {
          if (g.draft1?.fen && g.draft2?.fen) {
            const whiteRows = g.draft1.fen.split(' ')[0].split('/');
            const blackRows = g.draft2.fen.split(' ')[0].split('/');
            return [
              lowercaseRow(blackRows[7]),
              lowercaseRow(blackRows[6]),
              '8', '8', '8', '8',
              whiteRows[6],
              whiteRows[7],
            ].join('/') + ' w - - 0 1';
          }
          return null;
        })();

        if (!activeFen) {
          console.error(`Game ${g.id}: cannot start, no valid FEN available`);
          continue;
        }

        const now = new Date();

        // Guard: only update if still prep
        const guard = await prisma.game.updateMany({
          where: { id: g.id, status: 'prep' },
          data: {
            status: 'active',
            fen: activeFen,
            lastMoveAt: now,  // ← Critical: set when game goes active so timer starts
            moveNumber: 0,
            player1Timebank: 60000,
            player2Timebank: 60000,
          },
        });

        if (guard.count === 0) {
          console.log(`Game ${g.id}: already started, skipping auto-start`);
          continue;
        }

        console.log(`Game ${g.id} auto-started (elapsed: ${Math.round(elapsed)}s)`);

        // Notify both players that the game is now active
        await notifyGameUpdate(g.id, {
          status: 'active',
          fen: activeFen,
          lastMoveAt: now.toISOString(),
          player1Timebank: 60000,
          player2Timebank: 60000,
          moveNumber: 0,
          readyPlayer1: true,
          readyPlayer2: true,
        });
      }

    } catch (err) {
      console.error('Matchmaker error:', err);
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

initRedis()
  .then(() => runMatchmaker())
  .catch(err => {
    console.error('Fatal matchmaker crash:', err);
    process.exit(1);
  });