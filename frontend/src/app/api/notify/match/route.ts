// src/app/api/notify/match/route.ts
//
// FIX #14: Secret comparison uses crypto.timingSafeEqual to prevent
// timing-based side-channel attacks on the bearer token.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

const NOTIFY_SECRET = process.env.NOTIFY_SECRET;
if (!NOTIFY_SECRET) {
  console.error('NOTIFY_SECRET not set in environment!');
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');

    // #14: timing-safe comparison
    const isAuthorized = (() => {
      if (!authHeader || !NOTIFY_SECRET) return false;
      const expected = Buffer.from(`Bearer ${NOTIFY_SECRET}`);
      const provided = Buffer.from(authHeader);
      // Lengths must match before timingSafeEqual (it throws if they differ)
      return expected.length === provided.length && timingSafeEqual(expected, provided);
    })();

    if (!isAuthorized) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { gameId, userIds } = body;

    if (!gameId || typeof gameId !== 'number') {
      return NextResponse.json({ error: 'Invalid gameId' }, { status: 400 });
    }

    if (!Array.isArray(userIds) || userIds.length !== 2) {
      return NextResponse.json({ error: 'Exactly two userIds required' }, { status: 400 });
    }

    const io = (global as any).io;
    if (!io) {
      console.error('Socket.IO not initialized');
      return NextResponse.json({ error: 'Server error' }, { status: 500 });
    }

    userIds.forEach((userId: number) => {
      const room = `queue-user-${userId}`;
      io.to(room).emit('matched', { gameId });
      console.log(`Emitted 'matched' to ${room} for game ${gameId}`);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Notify match error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}