// src/app/api/notify/game-update/route.ts
// Called by external services (timeout-checker, matchmaker) to relay
// game-update events through the main server's Socket.IO instance.
// Protected by NOTIFY_SECRET bearer token.

import { NextResponse } from "next/server";

const NOTIFY_SECRET = process.env.NOTIFY_SECRET;

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || authHeader !== `Bearer ${NOTIFY_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { gameId, payload, targetUserId } = body;

    if (!gameId || typeof gameId !== "number") {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const emitToGame = (global as any).emitToGame;
    const emitToGameUser = (global as any).emitToGameUser;

    if (!emitToGame) {
      console.error("Socket.IO emitToGame not initialized");
      return NextResponse.json({ error: "Socket.IO not ready" }, { status: 500 });
    }

    if (targetUserId && typeof targetUserId === "number") {
      // Targeted emit to a specific player in the game room
      if (emitToGameUser) {
        emitToGameUser(gameId, targetUserId, "game-update", payload);
        console.log(`Emitted targeted game-update to user ${targetUserId} in game ${gameId}`);
      }
    } else {
      // Broadcast to everyone in the game room
      emitToGame(gameId, "game-update", payload);
      console.log(`Emitted game-update broadcast to game ${gameId}`);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Notify game-update error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
