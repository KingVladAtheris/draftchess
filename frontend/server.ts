// frontend/server.ts
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketServer, ServerOptions } from 'socket.io';
import { getToken } from "next-auth/jwt";

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer(async (req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const ioOptions: Partial<ServerOptions> = {
    path: '/api/socket.io',
    addTrailingSlash: false,
    cors: { origin: '*' },
    pingInterval: 25000,
    pingTimeout: 20000,
  };

  let wsEngine: any;
  if (process.env.NODE_ENV === 'production') {
    try {
      wsEngine = require('eiows').Server;
      console.log('Using high-performance eiows WebSocket engine');
    } catch (err) {
      console.warn('eiows not available — falling back to default ws engine', err);
    }
  }

  if (wsEngine) {
    ioOptions.wsEngine = wsEngine;
  }

  const io = new SocketServer(httpServer, ioOptions);

  // Middleware: Authenticate socket connections using NextAuth token
  io.use(async (socket, next) => {
    const req = { headers: socket.handshake.headers } as any;
    const token = await getToken({ req, secret: process.env.AUTH_SECRET });
    if (!token?.id) return next(new Error('Invalid session'));
    socket.data.userId = parseInt(token.id as string);
    next();
  });

  io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id} (user: ${socket.data.userId})`);

    // Auto-join per-user queue room for targeted match notifications
    if (socket.data.userId) {
      const userQueueRoom = `queue-user-${socket.data.userId}`;
      socket.join(userQueueRoom);
      console.log(`User ${socket.data.userId} auto-joined ${userQueueRoom}`);
    }

    socket.on('join-queue', () => {
      socket.join('queue');
    });

    socket.on('leave-queue', () => {
      socket.leave('queue');
    });

    // Join game room — track which game each socket is in
    socket.on('join-game', (gameId: number) => {
      const room = `game-${gameId}`;
      socket.join(room);
      // Also join a per-user-per-game room for masked/targeted events
      const userGameRoom = `game-${gameId}-user-${socket.data.userId}`;
      socket.join(userGameRoom);
      console.log(`User ${socket.data.userId} joined ${room} and ${userGameRoom}`);
    });

    socket.on('disconnect', () => {
      console.log(`Client disconnected: ${socket.id}`);
    });
  });

  // Export io globally for API routes
  (global as any).io = io;

  /**
   * emitToGame: Send the same payload to both players in a game room.
   * Used when no masking is needed (active game moves, game end, etc.)
   */
  (global as any).emitToGame = (gameId: number, event: string, payload: any) => {
    io.to(`game-${gameId}`).emit(event, payload);
  };

  /**
   * emitToGameUser: Send a payload to a specific player in a game.
   * Used during prep phase to send each player their own masked FEN.
   */
  (global as any).emitToGameUser = (gameId: number, userId: number, event: string, payload: any) => {
    io.to(`game-${gameId}-user-${userId}`).emit(event, payload);
  };

  httpServer.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
