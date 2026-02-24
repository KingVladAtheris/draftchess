// src/app/api/notify/match/route.ts
import { NextResponse } from 'next/server';

// Secret key to prevent unauthorized calls (set in .env)
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;

if (!NOTIFY_SECRET) {
  console.error('NOTIFY_SECRET not set in environment!');
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader || authHeader !== `Bearer ${NOTIFY_SECRET}`) {
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

    // Targeted emit: only to the two matched players' personal queue rooms
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