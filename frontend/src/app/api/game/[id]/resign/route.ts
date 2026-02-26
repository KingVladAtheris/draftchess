// app/api/game/[id]/resign/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { updateGameResult } from "@/app/lib/elo-update";
import { cancelTimeoutJob } from "@/app/lib/queues";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = parseInt(session.user.id);
  const gameId = parseInt(id);

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: {
      status: true,
      player1Id: true,
      player2Id: true,
      player1EloBefore: true,
      player2EloBefore: true,
      player1: { select: { gamesPlayed: true } },
      player2: { select: { gamesPlayed: true } },
    },
  });

  if (!game || game.status !== "active") {
    return NextResponse.json({ error: "Game is not active" }, { status: 400 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "You are not a participant in this game" }, { status: 403 });
  }

  // Opponent wins on resignation
  const isPlayer1Resigning = game.player1Id === userId;
  const winnerId = isPlayer1Resigning ? game.player2Id : game.player1Id;

  const result = await updateGameResult(
    gameId,
    winnerId,
    game.player1Id,
    game.player2Id,
    game.player1EloBefore ?? 1200,
    game.player2EloBefore ?? 1200,
    game.player1.gamesPlayed,
    game.player2.gamesPlayed,
    "resignation"
  );

  if (!result) {
    // Game was already finished (race condition)
    return NextResponse.json({ error: "Game already finished" }, { status: 409 });
  }

  // Cancel the pending timeout job — game is now finished
  await cancelTimeoutJob(gameId);

  // Broadcast resignation to both players
  const emitToGame = (global as any).emitToGame;
  if (emitToGame) {
    emitToGame(gameId, "game-update", {
      status: "finished",
      winnerId,
      endReason: "resignation",
      player1EloAfter: result.newPlayer1Elo,
      player2EloAfter: result.newPlayer2Elo,
      eloChange: result.eloChange,
    });
  }

  return NextResponse.json({
    success: true,
    winnerId,
    endReason: "resignation",
  });
}
