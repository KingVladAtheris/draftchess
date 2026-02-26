// src/app/lib/forfeit.ts
// Handles game forfeit due to disconnect timeout.
// Called from server.ts when a presence key expires in Redis.
// Same outcome as resignation — opponent wins, ELO updated, socket event emitted.

import { prisma } from "@/app/lib/prisma.server";
import { updateGameResult } from "@/app/lib/elo-update";
import { cancelTimeoutJob } from "@/app/lib/queues";

export async function forfeitGame(
  gameId:  number,
  userId:  number,  // the player who disconnected
  emitToGame: (gameId: number, event: string, payload: any) => void
): Promise<void> {
  // Load the game — must be active and the user must be a participant
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

  if (game.status !== 'active' && game.status !== 'prep') {
    console.log(`[Forfeit] game ${gameId} already finished (status: ${game.status}), skipping`);
    return;
  }

  const isPlayer1 = game.player1Id === userId;
  if (!isPlayer1 && game.player2Id !== userId) {
    console.warn(`[Forfeit] user ${userId} is not a participant in game ${gameId}`);
    return;
  }

  // Both prep and active: full ELO update via updateGameResult.
  // updateGameResult guards on status = 'active', so for prep games we
  // manually transition to active first so the guard passes, then let
  // updateGameResult handle the rest atomically.
  if (game.status === 'prep') {
    const promoted = await prisma.game.updateMany({
      where: { id: gameId, status: 'prep' },
      data:  { status: 'active' },
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
    'abandoned'
  );

  if (!result) {
    // Race condition — game was already finished by another path (timeout, move, etc.)
    console.log(`[Forfeit] game ${gameId} already finished by another path, skipping`);
    return;
  }

  // Cancel the BullMQ timeout job — forfeit supersedes it
  await cancelTimeoutJob(gameId);

  // Reset both players out of in_game so they can queue again
  await prisma.user.updateMany({
    where: { id: { in: [game.player1Id, game.player2Id] } },
    data:  { queueStatus: 'offline' },
  });

  emitToGame(gameId, 'game-update', {
    status:          'finished',
    winnerId,
    endReason:       'abandoned',
    player1EloAfter: result.newPlayer1Elo,
    player2EloAfter: result.newPlayer2Elo,
    eloChange:       result.eloChange,
  });

  console.log(`[Forfeit] game ${gameId}: user ${userId} forfeited (was ${game.status}), winner: ${winnerId}`);
}