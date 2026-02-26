// app/api/game/[id]/move/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { Chess } from "chess.js";
import { updateGameResult } from "@/app/lib/elo-update";
import { scheduleTimeoutJob, cancelTimeoutJob } from "@/app/lib/queues";

// Time control constants
const MOVE_TIME_LIMIT     = 30000; // 30 seconds per move in ms
const TIMEBANK_BONUS_INTERVAL = 20;   // Add bonus every N moves
const TIMEBANK_BONUS_AMOUNT   = 60000; // 60 second bonus in ms

// Extend Chess to block castling and en passant (Draft Chess rules)
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

  // ─── Load game ───────────────────────────────────────────────────────────
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

  // ─── Server-authoritative turn check ─────────────────────────────────────
  // Derive whose turn it is from the FEN — never trust the client
  const chess = new DraftChess(game.fen);
  const turn = chess.turn(); // "w" or "b"
  const isPlayer1 = game.player1Id === userId;
  const isWhite = game.whitePlayerId === userId; // color from whitePlayerId, not queue slot

  const isMyTurn = (turn === "w" && isWhite) || (turn === "b" && !isWhite);
  if (!isMyTurn) {
    return NextResponse.json({ error: "It is not your turn" }, { status: 400 });
  }

  // ─── Time accounting ─────────────────────────────────────────────────────
  const now = new Date();
  const lastMoveTime = game.lastMoveAt ? new Date(game.lastMoveAt) : now;
  const elapsedMs = now.getTime() - lastMoveTime.getTime();

  let currentTimebank = isPlayer1 ? game.player1Timebank : game.player2Timebank;

  if (elapsedMs > MOVE_TIME_LIMIT) {
    const overage = elapsedMs - MOVE_TIME_LIMIT;
    currentTimebank -= overage;

    if (currentTimebank <= 0) {
      // This player has timed out — opponent wins
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
        "timeout"
      );

      // updateGameResult returns null if game was already finished (race condition guard)
      if (result) {
        // Cancel the BullMQ timeout job — game is now finished
        await cancelTimeoutJob(gameId);
        const emitToGame = (global as any).emitToGame;
        if (emitToGame) {
          emitToGame(gameId, "game-update", {
            status: "finished",
            winnerId,
            endReason: "timeout",
            player1EloAfter: result.newPlayer1Elo,
            player2EloAfter: result.newPlayer2Elo,
            eloChange: result.eloChange,
          });
        }
      }

      return NextResponse.json({
        success: false,
        error: "Your time has expired",
        winnerId,
        endReason: "timeout",
      }, { status: 400 });
    }
  }

  // ─── Validate and execute move ────────────────────────────────────────────
  try {
    chess.move({ from, to, promotion: promotion ?? "q" });
  } catch (err: any) {
    return NextResponse.json({ error: `Illegal move: ${err.message}` }, { status: 400 });
  }

  const newFen = chess.fen();
  const newMoveNumber = game.moveNumber + 1;

  // ─── Check game-ending conditions ────────────────────────────────────────
  let newStatus = "active";
  let winnerId: number | null = null;
  let endReason: string | null = null;

  if (chess.isCheckmate()) {
    newStatus = "finished";
    winnerId = userId;
    endReason = "checkmate";
  } else if (chess.isStalemate()) {
    newStatus = "finished";
    endReason = "stalemate";
  } else if (chess.isThreefoldRepetition()) {
    newStatus = "finished";
    endReason = "repetition";
  } else if (chess.isInsufficientMaterial()) {
    newStatus = "finished";
    endReason = "insufficient_material";
  } else if (chess.isDraw()) {
    newStatus = "finished";
    endReason = "draw";
  }

  // ─── Timebank bonus every TIMEBANK_BONUS_INTERVAL moves ──────────────────
  let player1TimebankUpdate = isPlayer1 ? currentTimebank : game.player1Timebank;
  let player2TimebankUpdate = isPlayer1 ? game.player2Timebank : currentTimebank;
  const bonusAwarded = newMoveNumber % TIMEBANK_BONUS_INTERVAL === 0;
  if (bonusAwarded) {
    player1TimebankUpdate += TIMEBANK_BONUS_AMOUNT;
    player2TimebankUpdate += TIMEBANK_BONUS_AMOUNT;
    console.log(`Game ${gameId}: +${TIMEBANK_BONUS_AMOUNT / 1000}s timebank bonus at move ${newMoveNumber}`);
  }

  // ─── Persist move ─────────────────────────────────────────────────────────
  // If game ended, updateGameResult will set status to "finished" via its own guard.
  // For active games, we update here. We do NOT set status="finished" here if ending
  // because updateGameResult does it atomically with the ELO update.
  const updatedGame = await prisma.game.update({
    where: { id: gameId },
    data: {
      fen: newFen,
      // Only set status to finished here if there's no ELO update needed
      // (draws don't need ELO guard since updateGameResult handles it)
      lastMoveAt: now,
      lastMoveBy: userId,
      moveNumber: newMoveNumber,
      player1Timebank: player1TimebankUpdate,
      player2Timebank: player2TimebankUpdate,
    },
  });

  // ─── ELO update if game ended ─────────────────────────────────────────────
  let eloResult: { newPlayer1Elo: number; newPlayer2Elo: number; eloChange: number } | null = null;
  if (newStatus === "finished" && endReason) {
    eloResult = await updateGameResult(
      gameId,
      winnerId,
      game.player1Id,
      game.player2Id,
      game.player1EloBefore ?? 1200,
      game.player2EloBefore ?? 1200,
      game.player1.gamesPlayed,
      game.player2.gamesPlayed,
      endReason
    );
  }

  // ─── Broadcast to both players ────────────────────────────────────────────
  // Server computes isMyTurn for each player from the new FEN — never trust client state
  const newChess = new DraftChess(newFen);
  const newTurn = newChess.turn();
  const emitToGame = (global as any).emitToGame;

  if (emitToGame) {
    const basePayload: any = {
      fen: newFen,
      moveNumber: newMoveNumber,
      player1Timebank: player1TimebankUpdate,
      player2Timebank: player2TimebankUpdate,
      lastMoveAt: now.toISOString(),
      // Each client will compute isMyTurn from the FEN + their colour
      turn: newTurn,
      timebankBonusAwarded: bonusAwarded,
    };

    if (newStatus === "finished") {
      basePayload.status = "finished";
      basePayload.winnerId = winnerId;
      basePayload.endReason = endReason;
      if (eloResult) {
        basePayload.player1EloAfter = eloResult.newPlayer1Elo;
        basePayload.player2EloAfter = eloResult.newPlayer2Elo;
        basePayload.eloChange = eloResult.eloChange;
      }
    }

    emitToGame(gameId, "game-update", basePayload);
  }

  // ─── Schedule / cancel timeout job ───────────────────────────────────────
  if (newStatus === "finished") {
    // Game over — cancel any pending timeout job
    await cancelTimeoutJob(gameId);
  } else {
    // Schedule a new timeout job for the next player's move.
    // This replaces the previous job atomically (same jobId).
    const newChessTurn = new DraftChess(newFen).turn();
    await scheduleTimeoutJob(
      gameId,
      player1TimebankUpdate,
      player2TimebankUpdate,
      now,
      newChessTurn,
    );
  }

  return NextResponse.json({
    success: true,
    fen: newFen,
    moveNumber: newMoveNumber,
    player1Timebank: player1TimebankUpdate,
    player2Timebank: player2TimebankUpdate,
    turn: newTurn,
    timebankBonusAwarded: bonusAwarded,
    ...(newStatus === "finished" && {
      status: "finished",
      winnerId,
      isDraw: winnerId === null,
      endReason,
    }),
  });
}
