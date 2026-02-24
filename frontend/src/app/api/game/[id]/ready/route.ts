// app/api/game/[id]/ready/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { buildCombinedDraftFen, maskOpponentAuxPlacements } from "@/app/lib/fen-utils";

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
      readyPlayer1: true,
      readyPlayer2: true,
      player1Id: true,
      player2Id: true,
      whitePlayerId: true,
      fen: true,                            // Current FEN with aux placements
      draft1: { select: { fen: true } },   // Original draft FEN (no aux)
      draft2: { select: { fen: true } },
    },
  });

  if (!game || game.status !== "prep") {
    return NextResponse.json({ error: "Game not in prep phase" }, { status: 400 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Not participant" }, { status: 403 });
  }

  const isWhite = game.whitePlayerId === userId; // for board orientation, FEN, masking
  const isPlayer1 = game.player1Id === userId;              // for player1/player2 slot fields

  if ((isPlayer1 && game.readyPlayer1) || (!isPlayer1 && game.readyPlayer2)) {
    return NextResponse.json({ error: "Already marked as ready" }, { status: 400 });
  }

  // Mark this player ready
  const updatedGame = await prisma.game.update({
    where: { id: gameId },
    data: isPlayer1 ? { readyPlayer1: true } : { readyPlayer2: true },
    select: {
      readyPlayer1: true,
      readyPlayer2: true,
      fen: true,
    },
  });

  const bothReady = updatedGame.readyPlayer1 && updatedGame.readyPlayer2;
  const emitToGame = (global as any).emitToGame;
  const emitToGameUser = (global as any).emitToGameUser;

  if (bothReady) {
    if (!game.draft1?.fen || !game.draft2?.fen) {
      return NextResponse.json({ error: "Missing draft positions" }, { status: 500 });
    }

    // ─── KEY FIX: Use the CURRENT game.fen (which contains all aux placements) ───
    // Do NOT rebuild from drafts — that would discard all aux pieces placed during prep.
    // The current game.fen already has both players' aux pieces in the correct positions.
    // We just need to transition status to 'active' and reset the timers.
    const activeFen = updatedGame.fen ?? buildCombinedDraftFen(game.draft1.fen, game.draft2.fen);

    const now = new Date();

    await prisma.game.update({
      where: { id: gameId },
      data: {
        status: "active",
        fen: activeFen,
        lastMoveAt: now,
        moveNumber: 0,
        player1Timebank: 60000,
        player2Timebank: 60000,
      },
    });

    // Broadcast full unmasked FEN to both players — game has started, all pieces visible
    if (emitToGame) {
      emitToGame(gameId, "game-update", {
        status: "active",
        fen: activeFen,
        lastMoveAt: now.toISOString(),
        player1Timebank: 60000,
        player2Timebank: 60000,
        moveNumber: 0,
        readyPlayer1: true,
        readyPlayer2: true,
      });
    }

    return NextResponse.json({
      success: true,
      status: "active",
      bothReady: true,
    });
  }

  // Only one player is ready — emit ready-state update, preserve masking
  if (emitToGameUser && game.draft1?.fen && game.draft2?.fen) {
    const originalFen = buildCombinedDraftFen(game.draft1.fen, game.draft2.fen);
    const currentFen = updatedGame.fen ?? "";

    // Player who just readied: mask opponent's aux pieces
    const myMaskedFen = maskOpponentAuxPlacements(currentFen, originalFen, isWhite);
    emitToGameUser(gameId, userId, "game-update", {
      readyPlayer1: updatedGame.readyPlayer1,
      readyPlayer2: updatedGame.readyPlayer2,
      fen: myMaskedFen,
    });

    // Opponent: mask the readying player's aux pieces
    const opponentId = isPlayer1 ? game.player2Id : game.player1Id;
    const opponentIsWhite = !isWhite;
    const opponentMaskedFen = maskOpponentAuxPlacements(currentFen, originalFen, opponentIsWhite);
    emitToGameUser(gameId, opponentId, "game-update", {
      readyPlayer1: updatedGame.readyPlayer1,
      readyPlayer2: updatedGame.readyPlayer2,
      fen: opponentMaskedFen,
    });
  } else if (emitToGame) {
    // Fallback: no draft FENs available, emit without FEN update
    emitToGame(gameId, "game-update", {
      readyPlayer1: updatedGame.readyPlayer1,
      readyPlayer2: updatedGame.readyPlayer2,
    });
  }

  return NextResponse.json({
    success: true,
    status: "prep",
    bothReady: false,
  });
}
