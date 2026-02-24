// frontend/src/lib/socket.ts
'use client';

import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;
let connectPromise: Promise<Socket> | null = null;

const SOCKET_URL = undefined; 

export const getSocket = (): Promise<Socket> => {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('getSocket can only be called on the client'));
  }

  if (socket?.connected) {
    return Promise.resolve(socket);
  }

  // If already connecting, return the existing promise
  if (connectPromise) {
    return connectPromise;
  }

  // Lazy init socket instance (only once)
  if (!socket) {
    socket = io(SOCKET_URL, {
      path: '/api/socket.io',
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      transports: ['websocket', 'polling'],
      autoConnect: false,           // ← We control connect manually
    });

    socket.on('disconnect', (reason: string) => {
      console.log(`Socket disconnected: ${reason}`);

      if (!socket?.connected) {
        connectPromise = null;
      }
    });

    socket.on('connect_error', (err: Error) => {
      console.error('Socket connection error:', err.message);
    });
  }

  // Create connection promise
  connectPromise = new Promise<Socket>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Socket connection timeout (5s)'));
    }, 5000);

    const onConnect = () => {
      cleanup();
      console.log('Socket connected successfully → ID:', socket!.id);
      resolve(socket!);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      clearTimeout(timeout);
      socket?.off('connect', onConnect);
      socket?.off('connect_error', onError);
      connectPromise = null;
    };

    socket!.once('connect', onConnect);
    socket!.once('connect_error', onError);

    // Trigger connection if not already active
    if (!socket!.active) {
      socket!.connect();
    }
  });

  return connectPromise;
};