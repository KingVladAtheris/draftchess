// src/app/lib/elo-update.ts
//
// CHANGES:
//   - ELO floor: neither player can drop below MIN_ELO (100).
//   - currentForUserId removed (field deleted from schema in Step 1).
//   - Rapid-loss guard: if a player loses more than MAX_LOSSES_PER_HOUR games
//     in one hour, their ELO loss is capped at 1 point per game for that game.
//     This limits the damage from arranged loss farming without banning players.
//   - The rapid-loss check is a single extra indexed query; it only fires on
//     a loss, not on wins or draws.

import { prisma } from "@/app/lib/prisma.server";
import { calculateEloChange } from "@/app/lib/fen-utils";

const MIN_ELO             = 100;   // hard floor
const MAX_LOSSES_PER_HOUR = 8;     // more than this in 60 min → loss capped to 1pt

class AlreadyFinishedError extends Error {
  constructor() { super("already_finished"); }
}

async function recentLossCount(userId: number): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  return prisma.game.count({
    where: {
      status:    "finished",
      endReason: { not: "draw" },
      winnerId:  { not: userId },   // they lost
      OR: [{ player1Id: userId }, { player2Id: userId }],
      createdAt: { gte: oneHourAgo },
    },
  });
}

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

  const isDraw = winnerId === null;

  // ── Rapid-loss guard ──────────────────────────────────────────────────────
  // Check if the loser has lost suspiciously often in the last hour.
  // We cap their ELO loss (not the winner's gain) to reduce farming incentive.
  let p1LossCap = false;
  let p2LossCap = false;

  if (!isDraw) {
    const loserId = winnerId === player1Id ? player2Id : player1Id;
    const losses  = await recentLossCount(loserId);
    if (losses >= MAX_LOSSES_PER_HOUR) {
      console.warn(`[ELO] rapid-loss cap applied for user ${loserId} (${losses} losses in last hour)`);
      if (loserId === player1Id) p1LossCap = true;
      else                       p2LossCap = true;
    }
  }

  // ── ELO calculation ───────────────────────────────────────────────────────
  let player1EloChange: number;
  let player2EloChange: number;

  if (isDraw) {
    const result = calculateEloChange(player1EloBefore, player2EloBefore, player1Games, true);
    player1EloChange = result.winnerChange;
    player2EloChange = result.loserChange;
  } else if (winnerId === player1Id) {
    const result = calculateEloChange(player1EloBefore, player2EloBefore, player1Games, false);
    player1EloChange = result.winnerChange;
    player2EloChange = p2LossCap ? -1 : result.loserChange;
  } else {
    const result = calculateEloChange(player2EloBefore, player1EloBefore, player2Games, false);
    player2EloChange = result.winnerChange;
    player1EloChange = p1LossCap ? -1 : result.loserChange;
  }

  // ── ELO floor ─────────────────────────────────────────────────────────────
  const rawP1Elo    = player1EloBefore + player1EloChange;
  const rawP2Elo    = player2EloBefore + player2EloChange;
  const newPlayer1Elo = Math.max(MIN_ELO, rawP1Elo);
  const newPlayer2Elo = Math.max(MIN_ELO, rawP2Elo);
  const eloChange     = Math.abs(player1EloChange);

  try {
    await prisma.$transaction(async (tx) => {
      const guard = await tx.game.updateMany({
        where: { id: gameId, status: "active" },
        data:  { status: "finished" },
      });

      if (guard.count === 0) {
        throw new AlreadyFinishedError();
      }

      await tx.game.update({
        where: { id: gameId },
        data: {
          winnerId:        winnerId ?? undefined,
          player1EloAfter: newPlayer1Elo,
          player2EloAfter: newPlayer2Elo,
          eloChange,
          endReason,
          // currentForUserId field removed in Step 1
        },
      });

      await tx.user.update({
        where: { id: player1Id },
        data: {
          elo:         newPlayer1Elo,
          gamesPlayed: { increment: 1 },
          wins:    (!isDraw && winnerId === player1Id) ? { increment: 1 } : undefined,
          losses:  (!isDraw && winnerId !== player1Id) ? { increment: 1 } : undefined,
          draws:   isDraw                              ? { increment: 1 } : undefined,
          queueStatus:   "offline",
          queuedAt:      null,
          queuedDraftId: null,
        },
      });

      await tx.user.update({
        where: { id: player2Id },
        data: {
          elo:         newPlayer2Elo,
          gamesPlayed: { increment: 1 },
          wins:    (!isDraw && winnerId === player2Id) ? { increment: 1 } : undefined,
          losses:  (!isDraw && winnerId !== player2Id) ? { increment: 1 } : undefined,
          draws:   isDraw                              ? { increment: 1 } : undefined,
          queueStatus:   "offline",
          queuedAt:      null,
          queuedDraftId: null,
        },
      });
    });
  } catch (err) {
    if (err instanceof AlreadyFinishedError) {
      console.warn(`updateGameResult: game ${gameId} already finished, skipping`);
      return null;
    }
    throw err;
  }

  console.log(
    `Game ${gameId} ended: ${endReason}. ` +
    `P1 ELO ${player1EloBefore}→${newPlayer1Elo}, P2 ELO ${player2EloBefore}→${newPlayer2Elo}`
  );

  return { newPlayer1Elo, newPlayer2Elo, eloChange };
}
