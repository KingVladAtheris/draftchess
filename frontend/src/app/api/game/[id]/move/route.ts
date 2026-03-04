// app/api/game/[id]/move/route.ts

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { Chess } from "chess.js";
import { updateGameResult } from "@/app/lib/elo-update";
import { scheduleTimeoutJob, cancelTimeoutJob } from "@/app/lib/queues";
import { consume, moveLimiter } from "@/app/lib/rate-limit";

const MOVE_TIME_LIMIT         = 30000;
const TIMEBANK_BONUS_INTERVAL = 20;
const TIMEBANK_BONUS_AMOUNT   = 60000;

class DraftChess extends Chess {
  move(moveObj: any, options?: any) {
    const result = super.move(moveObj, options);
    if (result && (result.flags.includes("k") || result.flags.includes("q") || result.flags.includes("e"))) {
      super.undo();
      throw new Error("Castling and en passant are not allowed in Draft Chess");
    }
    return result;
  }
}

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

  const limited = await consume(moveLimiter, req, userId.toString());
  if (limited) return limited;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { from, to, promotion } = body;
  if (!from || !to) {
    return NextResponse.json({ error: "from and to are required" }, { status: 400 });
  }

  // ─── Load game ────────────────────────────────────────────────────────────
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: {
      status: true,
      fen: true,
      player1Id: true,
      player2Id: true,
      whitePlayerId: true,
      player1EloBefore: true,
      player2EloBefore: true,
      lastMoveAt: true,
      moveNumber: true,
      player1Timebank: true,
      player2Timebank: true,
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

  if (!game.fen) {
    return NextResponse.json({ error: "Game has no position" }, { status: 400 });
  }

  // ─── Turn check ───────────────────────────────────────────────────────────
  const chess   = new DraftChess(game.fen);
  const turn    = chess.turn();
  const isWhite = game.whitePlayerId === userId;
  const isMyTurn = (turn === "w" && isWhite) || (turn === "b" && !isWhite);

  if (!isMyTurn) {
    return NextResponse.json({ error: "It is not your turn" }, { status: 400 });
  }

  // ─── Time accounting ──────────────────────────────────────────────────────
  const now          = new Date();
  const lastMoveTime = game.lastMoveAt ? new Date(game.lastMoveAt) : now;
  const elapsedMs    = now.getTime() - lastMoveTime.getTime();
  const isPlayer1    = game.player1Id === userId;
  const currentTimebank = isPlayer1 ? game.player1Timebank : game.player2Timebank;
  const overage         = Math.max(0, elapsedMs - MOVE_TIME_LIMIT);

  if (overage > 0 && currentTimebank - overage <= 0) {
    const winnerId = isPlayer1 ? game.player2Id : game.player1Id;

    const result = await updateGameResult(
      gameId, winnerId,
      game.player1Id, game.player2Id,
      game.player1EloBefore ?? 1200, game.player2EloBefore ?? 1200,
      game.player1.gamesPlayed, game.player2.gamesPlayed,
      "timeout"
    );

    if (result) {
      await cancelTimeoutJob(gameId);
      const emitFn = (global as any).emitToGame;
      if (emitFn) {
        emitFn(gameId, "game-update", {
          status: "finished", winnerId, endReason: "timeout",
          player1EloAfter: result.newPlayer1Elo,
          player2EloAfter: result.newPlayer2Elo,
          eloChange:       result.eloChange,
        });
      }
    }

    return NextResponse.json(
      { success: false, error: "Your time has expired", winnerId, endReason: "timeout" },
      { status: 400 }
    );
  }

  // ─── Validate and execute move ────────────────────────────────────────────
  try {
    chess.move({ from, to, promotion: promotion ?? "q" });
  } catch (err: any) {
    return NextResponse.json({ error: `Illegal move: ${err.message}` }, { status: 400 });
  }

  const newFen        = chess.fen();
  const newMoveNumber = game.moveNumber + 1;

  // ─── Game-ending conditions ───────────────────────────────────────────────
  let newStatus: string  = "active";
  let winnerId: number | null = null;
  let endReason: string | null = null;

  if (chess.isCheckmate())               { newStatus = "finished"; winnerId = userId; endReason = "checkmate"; }
  else if (chess.isStalemate())          { newStatus = "finished"; endReason = "stalemate"; }
  else if (chess.isThreefoldRepetition()){ newStatus = "finished"; endReason = "repetition"; }
  else if (chess.isInsufficientMaterial()){ newStatus = "finished"; endReason = "insufficient_material"; }
  else if (chess.isDraw())               { newStatus = "finished"; endReason = "draw"; }

  const bonusAwarded  = newMoveNumber % TIMEBANK_BONUS_INTERVAL === 0;
  const timebankField = isPlayer1 ? "player1Timebank" : "player2Timebank";
  const otherField    = isPlayer1 ? "player2Timebank" : "player1Timebank";

  // ─── Persist — guarded on status:'active' ────────────────────────────────
  const persistResult = await prisma.game.updateMany({
    where: { id: gameId, status: "active" },
    data: {
      fen:        newFen,
      lastMoveAt: now,
      lastMoveBy: userId,
      moveNumber: newMoveNumber,
      ...(overage > 0
        ? { [timebankField]: { decrement: overage } }
        : {}
      ),
      ...(bonusAwarded
        ? {
            [timebankField]: { increment: TIMEBANK_BONUS_AMOUNT - (overage > 0 ? overage : 0) },
            [otherField]:    { increment: TIMEBANK_BONUS_AMOUNT },
          }
        : {}
      ),
    },
  });

  if (persistResult.count === 0) {
    return NextResponse.json({ error: "Game already finished" }, { status: 409 });
  }

  // Re-fetch timebanks (we used expressions so the new values must be read back)
  const updatedGame = await prisma.game.findUnique({
    where:  { id: gameId },
    select: { player1Timebank: true, player2Timebank: true },
  });

  const player1TimebankFinal = updatedGame?.player1Timebank ?? game.player1Timebank;
  const player2TimebankFinal = updatedGame?.player2Timebank ?? game.player2Timebank;

  // ─── ELO update if game ended ─────────────────────────────────────────────
  let eloResult: { newPlayer1Elo: number; newPlayer2Elo: number; eloChange: number } | null = null;
  if (newStatus === "finished" && endReason) {
    eloResult = await updateGameResult(
      gameId, winnerId,
      game.player1Id, game.player2Id,
      game.player1EloBefore ?? 1200, game.player2EloBefore ?? 1200,
      game.player1.gamesPlayed, game.player2.gamesPlayed,
      endReason
    );
  }

  // ─── Broadcast ────────────────────────────────────────────────────────────
  const newTurn = new DraftChess(newFen).turn();
  const emitFn  = (global as any).emitToGame;

  if (emitFn) {
    const payload: any = {
      fen:         newFen,
      moveNumber:  newMoveNumber,
      player1Timebank: player1TimebankFinal,
      player2Timebank: player2TimebankFinal,
      lastMoveAt:  now.toISOString(),
      turn:        newTurn,
      timebankBonusAwarded: bonusAwarded,
    };

    if (newStatus === "finished") {
      payload.status    = "finished";
      payload.winnerId  = winnerId;
      payload.endReason = endReason;
      if (eloResult) {
        payload.player1EloAfter = eloResult.newPlayer1Elo;
        payload.player2EloAfter = eloResult.newPlayer2Elo;
        payload.eloChange       = eloResult.eloChange;
      }
    }

    emitFn(gameId, "game-update", payload);
  }

  // ─── Schedule / cancel timeout ────────────────────────────────────────────
  if (newStatus === "finished") {
    await cancelTimeoutJob(gameId);
  } else {
    await scheduleTimeoutJob(
      gameId,
      player1TimebankFinal,
      player2TimebankFinal,
      now,
      newTurn,
    );
  }

  return NextResponse.json({
    success:    true,
    fen:        newFen,
    moveNumber: newMoveNumber,
    player1Timebank: player1TimebankFinal,
    player2Timebank: player2TimebankFinal,
    turn:       newTurn,
    timebankBonusAwarded: bonusAwarded,
    ...(newStatus === "finished" && {
      status:   "finished",
      winnerId,
      isDraw:   winnerId === null,
      endReason,
    }),
  });
}
