// src/app/lib/elo-update.ts
// Shared ELO update logic — called after any game-ending event.
//
// FIXES applied here:
//   #1/#2 — All writes are inside a single $transaction. The guard (status→finished)
//            and all ELO/stat writes are atomic. Two concurrent callers (move route +
//            timeout worker, or forfeit + move route) cannot both pass the guard.
//   #3    — queueStatus reset to 'offline' for both players so they can re-queue
//            after any game end (checkmate, resign, timeout, draw, abandon).
//   #10   — currentForUserId cleared on game finish.

import { prisma } from "@/app/lib/prisma.server";
import { calculateEloChange } from "@/app/lib/fen-utils";

// Sentinel thrown inside the transaction to signal "already finished"
// without causing a real rollback / error propagation.
class AlreadyFinishedError extends Error {
  constructor() { super("already_finished"); }
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
  const eloChange     = Math.abs(player1EloChange);

  try {
    await prisma.$transaction(async (tx) => {
      // ── Atomic guard ─────────────────────────────────────────────────────
      // Only one concurrent caller will update this row; the other sees count=0.
      const guard = await tx.game.updateMany({
        where: { id: gameId, status: "active" },
        data:  { status: "finished" },
      });

      if (guard.count === 0) {
        throw new AlreadyFinishedError();
      }

      // ── Write final game result ───────────────────────────────────────────
      await tx.game.update({
        where: { id: gameId },
        data: {
          winnerId:         winnerId ?? undefined,
          player1EloAfter:  newPlayer1Elo,
          player2EloAfter:  newPlayer2Elo,
          eloChange,
          endReason,
          currentForUserId: null,   // #10: clear stale reference
        },
      });

      // ── Update player stats + reset queue state ───────────────────────────
      await tx.user.update({
        where: { id: player1Id },
        data: {
          elo:         newPlayer1Elo,
          gamesPlayed: { increment: 1 },
          wins:    (!isDraw && winnerId === player1Id) ? { increment: 1 } : undefined,
          losses:  (!isDraw && winnerId !== player1Id) ? { increment: 1 } : undefined,
          draws:   isDraw                              ? { increment: 1 } : undefined,
          // #3: allow re-queue immediately after any game end
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
          // #3: allow re-queue immediately after any game end
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