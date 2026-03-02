// src/app/lib/forfeit.ts
// Handles game forfeit due to disconnect timeout.
//
// NOTE on race safety (#2):
// The prep→active promotion here (updateMany prep→active) races with the
// ready route. Both use updateMany guards, so only one can win. After
// promotion, we call updateGameResult which is now fully transactional —
// if the ready route also triggered updateGameResult, the second caller's
// transaction sees status='finished' and returns null cleanly.

import { prisma } from "@/app/lib/prisma.server";
import { updateGameResult } from "@/app/lib/elo-update";
import { cancelTimeoutJob } from "@/app/lib/queues";

export async function forfeitGame(
  gameId:     number,
  userId:     number,
  emitToGame: (gameId: number, event: string, payload: any) => void
): Promise<void> {

  const game = await prisma.game.findUnique({
    where:  { id: gameId },
    select: {
      status:           true,
      player1Id:        true,
      player2Id:        true,
      player1EloBefore: true,
      player2EloBefore: true,
      player1:          { select: { gamesPlayed: true } },
      player2:          { select: { gamesPlayed: true } },
    },
  });

  if (!game) {
    console.warn(`[Forfeit] game ${gameId} not found`);
    return;
  }

  if (game.status !== "active" && game.status !== "prep") {
    console.log(`[Forfeit] game ${gameId} already finished (status: ${game.status}), skipping`);
    return;
  }

  const isPlayer1 = game.player1Id === userId;
  if (!isPlayer1 && game.player2Id !== userId) {
    console.warn(`[Forfeit] user ${userId} is not a participant in game ${gameId}`);
    return;
  }

  // For prep games, promote to active so updateGameResult's guard can fire.
  // updateMany is atomic — if the ready route beat us here, count=0 and we exit.
  if (game.status === "prep") {
    const promoted = await prisma.game.updateMany({
      where: { id: gameId, status: "prep" },
      data:  { status: "active" },
    });
    if (promoted.count === 0) {
      console.log(`[Forfeit] game ${gameId} prep already resolved, skipping`);
      return;
    }
  }

  const winnerId = isPlayer1 ? game.player2Id : game.player1Id;

  const result = await updateGameResult(
    gameId,
    winnerId,
    game.player1Id,
    game.player2Id,
    game.player1EloBefore ?? 1200,
    game.player2EloBefore ?? 1200,
    game.player1.gamesPlayed,
    game.player2.gamesPlayed,
    "abandoned"
  );

  if (!result) {
    // updateGameResult's transaction saw status != 'active' — another path
    // (timeout, move) already finished the game. queueStatus was reset there.
    console.log(`[Forfeit] game ${gameId} already finished by another path, skipping`);
    return;
  }

  // updateGameResult already reset queueStatus for both players (#3).
  // cancelTimeoutJob is idempotent — safe to call even if already cancelled.
  await cancelTimeoutJob(gameId);

  emitToGame(gameId, "game-update", {
    status:          "finished",
    winnerId,
    endReason:       "abandoned",
    player1EloAfter: result.newPlayer1Elo,
    player2EloAfter: result.newPlayer2Elo,
    eloChange:       result.eloChange,
  });

  console.log(`[Forfeit] game ${gameId}: user ${userId} forfeited, winner: ${winnerId}`);
}