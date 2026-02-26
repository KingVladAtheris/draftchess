// frontend/server.ts
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketServer, type ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { getToken } from 'next-auth/jwt';

const dev      = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port     = parseInt(process.env.PORT || '3000', 10);

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('[server] REDIS_URL is not set');
  process.exit(1);
}

// ─── Redis clients ─────────────────────────────────────────────────────────
// Three separate clients are required:
//
//   pubClient      — publishes Socket.IO adapter messages
//   subClient      — subscribed exclusively by the Socket.IO adapter
//   eventsSubClient — subscribed to the draftchess:game-events channel so the
//                    matchmaker/timeout-checker can trigger socket emits
//                    without an HTTP round-trip
//
// A Redis client in subscribe mode cannot issue any other commands, which is
// why each role needs its own connection.
function makeRedisClient() {
  const client = createClient({ url: REDIS_URL });
  client.on('error',        (err) => console.error('[Redis] error:', err));
  client.on('reconnecting', ()    => console.warn('[Redis] reconnecting...'));
  return client;
}

const pubClient       = makeRedisClient();
const subClient       = makeRedisClient();
const eventsSubClient = makeRedisClient();

// Channel name used by all publishers (matchmaker, timeout-checker)
export const GAME_EVENTS_CHANNEL = 'draftchess:game-events';

// ─── Next.js ───────────────────────────────────────────────────────────────
const app    = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {

  await Promise.all([
    pubClient.connect(),
    subClient.connect(),
    eventsSubClient.connect(),
  ]);
  console.log('[Redis] all clients connected');

  const httpServer = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  // ─── Socket.IO ────────────────────────────────────────────────────────────
  const ioOptions: Partial<ServerOptions> = {
    path:             '/api/socket.io',
    addTrailingSlash: false,
    cors:             { origin: '*' },
    pingInterval:     25000,
    pingTimeout:      20000,
    connectTimeout:   10000,
  };

  const io = new SocketServer(httpServer, ioOptions);

  // Cross-instance broadcast — every io.to(room).emit() is routed through
  // Redis so all server instances deliver it to their connected sockets.
  io.adapter(createAdapter(pubClient, subClient));
  console.log('[Socket.IO] Redis adapter attached');

  // ─── Auth middleware ──────────────────────────────────────────────────────
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

  // ─── Connection handler ───────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const userId = socket.data.userId as number;
    console.log(`[Socket.IO] connected: ${socket.id} (user: ${userId})`);

    socket.join(`queue-user-${userId}`);

    socket.on('join-queue', () => socket.join('queue'));
    socket.on('leave-queue', () => socket.leave('queue'));

    socket.on('join-game', (gameId: number) => {
      if (!gameId || typeof gameId !== 'number') return;
      // Step 4 will add a participant auth check here
      socket.join(`game-${gameId}`);
      socket.join(`game-${gameId}-user-${userId}`);
      console.log(`[Socket.IO] user ${userId} joined game-${gameId}`);
    });

    socket.on('disconnect', (reason) => {
      // Step 4 will add presence/abandonment detection here
      console.log(`[Socket.IO] disconnected: ${socket.id} (user: ${userId}, reason: ${reason})`);
    });
  });

  // ─── Emit helpers (called by Next.js API route handlers) ─────────────────
  /** Broadcast to both players in a game room */
  (global as any).emitToGame = (gameId: number, event: string, payload: any) => {
    io.to(`game-${gameId}`).emit(event, payload);
  };

  /** Send to one specific player in a game */
  (global as any).emitToGameUser = (gameId: number, userId: number, event: string, payload: any) => {
    io.to(`game-${gameId}-user-${userId}`).emit(event, payload);
  };

  /** Push a match-found notification to a queued user */
  (global as any).emitToQueueUser = (userId: number, event: string, payload: any) => {
    io.to(`queue-user-${userId}`).emit(event, payload);
  };

  (global as any).io       = io;
  (global as any).redisPub = pubClient;

  // ─── Game events subscriber ───────────────────────────────────────────────
  // The matchmaker and timeout-checker publish messages to GAME_EVENTS_CHANNEL
  // instead of making HTTP requests. This subscriber receives them and calls
  // the emit helpers above — the same code path as API routes use.
  //
  // Message envelope:
  //   { type: 'game',      gameId, event, payload }           → emitToGame
  //   { type: 'game-user', gameId, userId, event, payload }   → emitToGameUser
  //   { type: 'queue-user', userId, event, payload }          → emitToQueueUser
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

  // ─── Start ────────────────────────────────────────────────────────────────
  httpServer.listen(port, () => {
    console.log(`[Server] ready on http://${hostname}:${port}`);
  });

  // ─── Graceful shutdown ────────────────────────────────────────────────────
  async function shutdown(signal: string) {
    console.log(`[Server] ${signal} — shutting down`);
    httpServer.close(async () => {
      await io.close();
      await pubClient.quit();
      await subClient.quit();
      await eventsSubClient.quit();
      console.log('[Server] clean exit');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
});