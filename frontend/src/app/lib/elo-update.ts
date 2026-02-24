// src/app/lib/elo-update.ts
// Shared ELO update logic — called after any game-ending event

import { prisma } from "@/app/lib/prisma.server";
import { calculateEloChange } from "@/app/lib/fen-utils";

export async function updateGameResult(
  gameId: number,
  winnerId: number | null,
  player1Id: number,
  player2Id: number,
  player1EloBefore: number,
  player2EloBefore: number,
  player1Games: number,
  player2Games: number,
  endReason: string
): Promise<{ newPlayer1Elo: number; newPlayer2Elo: number; eloChange: number } | null> {
  // Use a DB-level conditional update to prevent double-processing.
  // Only proceed if the game is still 'active' (not already finished).
  const guard = await prisma.game.updateMany({
    where: { id: gameId, status: "active" },
    data: { status: "finished" },
  });

  // If no rows were updated, the game was already finished — bail out
  if (guard.count === 0) {
    console.warn(`updateGameResult: game ${gameId} already finished, skipping`);
    return null;
  }

  const isDraw = winnerId === null;

  let player1EloChange: number;
  let player2EloChange: number;

  if (isDraw) {
    const result = calculateEloChange(player1EloBefore, player2EloBefore, player1Games, true);
    player1EloChange = result.winnerChange;
    player2EloChange = result.loserChange;
  } else if (winnerId === player1Id) {
    const result = calculateEloChange(player1EloBefore, player2EloBefore, player1Games, false);
    player1EloChange = result.winnerChange;
    player2EloChange = result.loserChange;
  } else {
    const result = calculateEloChange(player2EloBefore, player1EloBefore, player2Games, false);
    player2EloChange = result.winnerChange;
    player1EloChange = result.loserChange;
  }

  const newPlayer1Elo = player1EloBefore + player1EloChange;
  const newPlayer2Elo = player2EloBefore + player2EloChange;
  const eloChange = Math.abs(player1EloChange);

  // Write final game result fields
  await prisma.game.update({
    where: { id: gameId },
    data: {
      winnerId: winnerId ?? undefined,
      player1EloAfter: newPlayer1Elo,
      player2EloAfter: newPlayer2Elo,
      eloChange,
      endReason,
    },
  });

  // Update player stats
  await prisma.user.update({
    where: { id: player1Id },
    data: {
      elo: newPlayer1Elo,
      gamesPlayed: { increment: 1 },
      wins:   isDraw ? undefined : winnerId === player1Id ? { increment: 1 } : undefined,
      losses: isDraw ? undefined : winnerId !== player1Id ? { increment: 1 } : undefined,
      draws:  isDraw ? { increment: 1 } : undefined,
    },
  });

  await prisma.user.update({
    where: { id: player2Id },
    data: {
      elo: newPlayer2Elo,
      gamesPlayed: { increment: 1 },
      wins:   isDraw ? undefined : winnerId === player2Id ? { increment: 1 } : undefined,
      losses: isDraw ? undefined : winnerId !== player2Id ? { increment: 1 } : undefined,
      draws:  isDraw ? { increment: 1 } : undefined,
    },
  });

  console.log(
    `Game ${gameId} ended: ${endReason}. ` +
    `P1 ELO ${player1EloBefore}→${newPlayer1Elo}, P2 ELO ${player2EloBefore}→${newPlayer2Elo}`
  );

  return { newPlayer1Elo, newPlayer2Elo, eloChange };
}
