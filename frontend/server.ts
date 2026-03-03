// frontend/server.ts
//
// CHANGES from previous version:
//   - Socket disconnect handler now instantly removes the user from the queue
//     (sets queueStatus='offline') if they were queued but not in a game.
//     No grace period — there is nothing to protect in the queue state.
//   - The game presence grace period (DISCONNECT_GRACE_SECS) is unchanged —
//     that still applies only to active/prep games.

import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketServer, type ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { getToken } from 'next-auth/jwt';
import { prisma } from '@/app/lib/prisma.server';
import { buildCombinedDraftFen, maskOpponentAuxPlacements } from '@/app/lib/fen-utils';
import { forfeitGame } from '@/app/lib/forfeit';

const dev      = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port     = parseInt(process.env.PORT || '3000', 10);

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('[server] REDIS_URL is not set');
  process.exit(1);
}

// Parse the DB index from the URL so keyspace notifications fire on the
// correct database regardless of deployment config. (#9)
const REDIS_DB_INDEX = parseInt(new URL(REDIS_URL).pathname.replace('/', '') || '0', 10);

const DISCONNECT_GRACE_SECS = 30; // only for active/prep games
const PRESENCE_KEY_PREFIX   = 'presence:disconnected:';

// ─── Redis clients ─────────────────────────────────────────────────────────
// Five clients, each with a dedicated role:
//   pubClient         — Socket.IO adapter publisher (exclusive to adapter)
//   subClient         — Socket.IO adapter subscriber (exclusive to adapter)
//   eventsSubClient   — subscribes to draftchess:game-events channel
//   presenceSubClient — subscribes to Redis keyspace expiry notifications
//   cmdClient         — general commands: SET, DEL, PUBLISH (#16)
function makeRedisClient() {
  const client = createClient({ url: REDIS_URL });
  client.on('error',        (err) => console.error('[Redis] error:', err));
  client.on('reconnecting', ()    => console.warn('[Redis] reconnecting...'));
  return client;
}

const pubClient         = makeRedisClient();
const subClient         = makeRedisClient();
const eventsSubClient   = makeRedisClient();
const presenceSubClient = makeRedisClient();
const cmdClient         = makeRedisClient();

const GAME_EVENTS_CHANNEL = 'draftchess:game-events';

const app    = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {

  await Promise.all([
    pubClient.connect(),
    subClient.connect(),
    eventsSubClient.connect(),
    presenceSubClient.connect(),
    cmdClient.connect(),
  ]);
  console.log('[Redis] all clients connected');

  const httpServer = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // ─── Socket.IO ─────────────────────────────────────────────────────────────
  const allowedOrigin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const ioOptions: Partial<ServerOptions> = {
    path:             '/api/socket.io',
    addTrailingSlash: false,
    cors: {
      origin:      allowedOrigin,
      credentials: true,
    },
    pingInterval:   25000,
    pingTimeout:    20000,
    connectTimeout: 10000,
  };

  const io = new SocketServer(httpServer, ioOptions);
  io.adapter(createAdapter(pubClient, subClient));
  console.log('[Socket.IO] Redis adapter attached');

  // ─── Auth middleware ────────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const req   = { headers: socket.handshake.headers } as any;
      const token = await getToken({ req, secret: process.env.AUTH_SECRET });
      if (!token?.id) return next(new Error('Unauthorized'));
      socket.data.userId = parseInt(token.id as string);
      next();
    } catch {
      next(new Error('Unauthorized'));
    }
  });

  // ─── Presence helpers (game disconnect grace period) ───────────────────────
  function presenceKey(userId: number, gameId: number) {
    return `${PRESENCE_KEY_PREFIX}${userId}:${gameId}`;
  }

  async function setDisconnectedPresence(userId: number, gameId: number) {
    await cmdClient.set(presenceKey(userId, gameId), '1', { EX: DISCONNECT_GRACE_SECS });
    console.log(`[Presence] user ${userId} disconnected from game ${gameId}, grace ${DISCONNECT_GRACE_SECS}s`);
  }

  async function clearDisconnectedPresence(userId: number, gameId: number) {
    await cmdClient.del(presenceKey(userId, gameId));
    console.log(`[Presence] user ${userId} reconnected to game ${gameId}, grace period cancelled`);
  }

  // ─── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const userId = socket.data.userId as number;
    console.log(`[Socket.IO] connected: ${socket.id} (user: ${userId})`);

    socket.join(`queue-user-${userId}`);
    socket.on('join-queue',  () => socket.join('queue'));
    socket.on('leave-queue', () => socket.leave('queue'));

    // ── join-game ─────────────────────────────────────────────────────────────
    socket.on('join-game', async (gameId: number) => {
      if (!gameId || typeof gameId !== 'number') return;

      try {
        const game = await prisma.game.findUnique({
          where:  { id: gameId },
          select: { player1Id: true, player2Id: true, status: true },
        });

        if (!game) {
          console.warn(`[Socket.IO] join-game: game ${gameId} not found`);
          return;
        }

        if (game.player1Id !== userId && game.player2Id !== userId) {
          console.warn(`[Socket.IO] join-game: user ${userId} is not participant in game ${gameId}`);
          return;
        }

        socket.join(`game-${gameId}`);
        socket.join(`game-${gameId}-user-${userId}`);
        socket.data.gameId = gameId;

        await clearDisconnectedPresence(userId, gameId);

        if (game.status === 'active' || game.status === 'prep') {
          const opponentId = game.player1Id === userId ? game.player2Id : game.player1Id;
          io.to(`game-${gameId}-user-${opponentId}`).emit('opponent-connected', { userId });
        }

        // ── Snapshot ───────────────────────────────────────────────────────────
        try {
          const MOVE_TIME_LIMIT = 30000;
          const snapshot = await prisma.game.findUnique({
            where:  { id: gameId },
            select: {
              fen: true, status: true, prepStartedAt: true,
              readyPlayer1: true, readyPlayer2: true,
              auxPointsPlayer1: true, auxPointsPlayer2: true,
              player1Id: true, player2Id: true, whitePlayerId: true,
              draft1: { select: { fen: true } },
              draft2: { select: { fen: true } },
              lastMoveAt: true, moveNumber: true,
              player1Timebank: true, player2Timebank: true,
              winnerId: true, endReason: true,
              player1EloAfter: true, player2EloAfter: true, eloChange: true,
            },
          });

          if (snapshot) {
            const isWhite   = snapshot.whitePlayerId === userId;
            const rawFen    = snapshot.fen ?? '';

            let maskedFen = rawFen;
            if (snapshot.status === 'prep') {
              if (snapshot.draft1?.fen && snapshot.draft2?.fen) {
                const originalFen = buildCombinedDraftFen(snapshot.draft1.fen, snapshot.draft2.fen);
                maskedFen = maskOpponentAuxPlacements(rawFen, originalFen, isWhite);
              } else {
                console.warn(`[Socket.IO] snapshot: draft missing for game ${gameId} during prep`);
              }
            }

            let timeRemainingOnMove = MOVE_TIME_LIMIT;
            if (snapshot.status === 'active' && snapshot.lastMoveAt) {
              const turn    = rawFen.split(' ')[1];
              const myTurn  = (turn === 'w' && isWhite) || (turn === 'b' && !isWhite);
              const elapsed = Date.now() - new Date(snapshot.lastMoveAt).getTime();
              if (myTurn) timeRemainingOnMove = Math.max(0, MOVE_TIME_LIMIT - elapsed);
            }

            socket.emit('game-snapshot', {
              fen:              maskedFen,
              status:           snapshot.status,
              prepStartedAt:    snapshot.prepStartedAt,
              readyPlayer1:     snapshot.readyPlayer1,
              readyPlayer2:     snapshot.readyPlayer2,
              auxPointsPlayer1: snapshot.auxPointsPlayer1,
              auxPointsPlayer2: snapshot.auxPointsPlayer2,
              moveNumber:       snapshot.moveNumber,
              player1Timebank:  snapshot.player1Timebank,
              player2Timebank:  snapshot.player2Timebank,
              lastMoveAt:       snapshot.lastMoveAt,
              timeRemainingOnMove,
              winnerId:         snapshot.winnerId,
              endReason:        snapshot.endReason,
              player1EloAfter:  snapshot.player1EloAfter,
              player2EloAfter:  snapshot.player2EloAfter,
              eloChange:        snapshot.eloChange,
            });
          }
        } catch (snapErr) {
          console.error(`[Socket.IO] snapshot error for game ${gameId}:`, snapErr);
        }

        console.log(`[Socket.IO] user ${userId} joined game-${gameId}`);
      } catch (err) {
        console.error(`[Socket.IO] join-game error for user ${userId}, game ${gameId}:`, err);
      }
    });

    // ── disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', async (reason) => {
      console.log(`[Socket.IO] disconnected: ${socket.id} (user: ${userId}, reason: ${reason})`);

      try {
        // Single DB read to find out what state this user was in.
        // We check both queue and active/prep game in one query.
        const user = await prisma.user.findUnique({
          where:  { id: userId },
          select: { queueStatus: true },
        });

        if (!user) return;

        // ── Queued: remove instantly, no grace period ────────────────────────
        // The socket is the heartbeat for queue membership. If it drops,
        // the user is out. There is no game state to protect.
        if (user.queueStatus === 'queued') {
          await prisma.user.update({
            where: { id: userId },
            data: {
              queueStatus:   'offline',
              queuedAt:      null,
              queuedDraftId: null,
            },
          });
          console.log(`[Queue] user ${userId} removed from queue on disconnect`);
          return; // not in a game, nothing else to do
        }

        // ── In a game: start the 30s grace period ────────────────────────────
        // Only query for the active game if queueStatus indicates they're in one.
        // This skips the findFirst entirely for users on the lobby/drafts pages. (#21)
        if (user.queueStatus !== 'in_game') return;

        const knownGameId = socket.data.gameId as number | undefined;
        if (!knownGameId) {
          // Fallback: socket.data.gameId not set (server restart mid-session)
          // — query DB as source of truth
          const game = await prisma.game.findFirst({
            where: {
              status: { in: ['active', 'prep'] },
              OR: [{ player1Id: userId }, { player2Id: userId }],
            },
            select: { id: true, player1Id: true, player2Id: true },
          });
          if (!game) return;

          const opponentId = game.player1Id === userId ? game.player2Id : game.player1Id;
          await setDisconnectedPresence(userId, game.id);
          io.to(`game-${game.id}-user-${opponentId}`).emit('opponent-disconnected', {
            userId,
            gracePeriodSecs: DISCONNECT_GRACE_SECS,
          });
          return;
        }

        // Fast path: we know the gameId from socket data
        const game = await prisma.game.findUnique({
          where:  { id: knownGameId },
          select: { id: true, status: true, player1Id: true, player2Id: true },
        });

        if (!game || (game.status !== 'active' && game.status !== 'prep')) return;

        const opponentId = game.player1Id === userId ? game.player2Id : game.player1Id;
        await setDisconnectedPresence(userId, knownGameId);
        io.to(`game-${knownGameId}-user-${opponentId}`).emit('opponent-disconnected', {
          userId,
          gracePeriodSecs: DISCONNECT_GRACE_SECS,
        });

      } catch (err) {
        console.error(`[Socket.IO] disconnect handler error for user ${userId}:`, err);
      }
    });
  });

  // ─── Emit helpers ──────────────────────────────────────────────────────────
  const emitToGame = (gameId: number, event: string, payload: any) => {
    io.to(`game-${gameId}`).emit(event, payload);
  };

  const emitToGameUser = (gameId: number, userId: number, event: string, payload: any) => {
    io.to(`game-${gameId}-user-${userId}`).emit(event, payload);
  };

  const emitToQueueUser = (userId: number, event: string, payload: any) => {
    io.to(`queue-user-${userId}`).emit(event, payload);
  };

  (global as any).emitToGame      = emitToGame;
  (global as any).emitToGameUser  = emitToGameUser;
  (global as any).emitToQueueUser = emitToQueueUser;
  (global as any).io              = io;
  (global as any).redisPub        = cmdClient;

  // ─── Game events subscriber ────────────────────────────────────────────────
  await eventsSubClient.subscribe(GAME_EVENTS_CHANNEL, (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'game') {
        io.to(`game-${msg.gameId}`).emit(msg.event, msg.payload);
      } else if (msg.type === 'game-user') {
        io.to(`game-${msg.gameId}-user-${msg.userId}`).emit(msg.event, msg.payload);
      } else if (msg.type === 'queue-user') {
        io.to(`queue-user-${msg.userId}`).emit(msg.event, msg.payload);
      } else {
        console.warn('[Events] unknown message type:', msg.type);
      }
    } catch (err) {
      console.error('[Events] failed to parse message:', raw, err);
    }
  });
  console.log(`[Events] subscribed to ${GAME_EVENTS_CHANNEL}`);

  // ─── Presence expiry subscriber ────────────────────────────────────────────
  const keyspaceChannel = `__keyevent@${REDIS_DB_INDEX}__:expired`;
  await presenceSubClient.subscribe(keyspaceChannel, async (expiredKey) => {
    if (!expiredKey.startsWith(PRESENCE_KEY_PREFIX)) return;

    const parts  = expiredKey.slice(PRESENCE_KEY_PREFIX.length).split(':');
    const userId = parseInt(parts[0]);
    const gameId = parseInt(parts[1]);

    if (isNaN(userId) || isNaN(gameId)) {
      console.warn('[Presence] could not parse expired key:', expiredKey);
      return;
    }

    console.log(`[Presence] grace period expired for user ${userId} in game ${gameId} — forfeiting`);
    await forfeitGame(gameId, userId, emitToGame);
  });
  console.log(`[Presence] subscribed to ${keyspaceChannel}`);

  // ─── Start ─────────────────────────────────────────────────────────────────
  httpServer.listen(port, () => {
    console.log(`[Server] ready on http://${hostname}:${port}`);
  });

  // ─── Graceful shutdown ─────────────────────────────────────────────────────
  async function shutdown(signal: string) {
    console.log(`[Server] ${signal} — shutting down`);
    httpServer.close(async () => {
      await io.close();
      await pubClient.quit();
      await subClient.quit();
      await eventsSubClient.quit();
      await presenceSubClient.quit();
      await cmdClient.quit();
      console.log('[Server] clean exit');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
});