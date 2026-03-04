// app/api/game/[id]/place/route.ts

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import {
  buildCombinedDraftFen,
  maskOpponentAuxPlacements,
  getPieceAt,
  placePieceOnFen,
  hasIllegalBattery,
} from "@/app/lib/fen-utils";
import { consume, placeLimiter } from "@/app/lib/rate-limit";

const PIECE_VALUES: Record<string, number> = { P: 1, N: 3, B: 3, R: 5 };

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

  const limited = await consume(placeLimiter, req, userId.toString());
  if (limited) return limited;

  const { piece, square } = await req.json();

  if (!piece || !square) {
    return NextResponse.json({ error: "piece and square required" }, { status: 400 });
  }

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: {
      status: true,
      fen: true,
      auxPointsPlayer1: true,
      auxPointsPlayer2: true,
      player1Id: true,
      player2Id: true,
      whitePlayerId: true,
      draft1: { select: { fen: true } },
      draft2: { select: { fen: true } },
    },
  });

  if (!game || game.status !== "prep") {
    return NextResponse.json({ error: "Invalid game state" }, { status: 400 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Not participant" }, { status: 403 });
  }

  const isWhite   = game.whitePlayerId === userId;
  const isPlayer1 = game.player1Id === userId;

  const value = PIECE_VALUES[piece.toUpperCase()];
  if (!value) {
    return NextResponse.json({ error: "Invalid piece type" }, { status: 400 });
  }

  // JS-level pre-check (fast path for clearly invalid requests)
  const auxPoints = isPlayer1 ? game.auxPointsPlayer1 : game.auxPointsPlayer2;
  if (value > auxPoints) {
    return NextResponse.json({ error: "Not enough auxiliary points" }, { status: 400 });
  }

  const rank      = parseInt(square[1], 10);
  const fileIndex = square.charCodeAt(0) - "a".charCodeAt(0);
  if (isNaN(rank) || isNaN(fileIndex) || fileIndex < 0 || fileIndex > 7) {
    return NextResponse.json({ error: "Invalid square" }, { status: 400 });
  }

  const ownRanks = isWhite ? [1, 2] : [7, 8];
  if (!ownRanks.includes(rank)) {
    return NextResponse.json({ error: "Can only place on own ranks" }, { status: 400 });
  }

  if (piece.toUpperCase() === "P" && rank !== (isWhite ? 2 : 7)) {
    return NextResponse.json({ error: "Pawns can only be placed on the front rank" }, { status: 400 });
  }

  const currentFen = game.fen ?? "";

  if (getPieceAt(currentFen, square) !== "1") {
    return NextResponse.json({ error: "Square is already occupied" }, { status: 400 });
  }

  const pieceChar = isWhite ? piece.toUpperCase() : piece.toLowerCase();
  const newFen    = placePieceOnFen(currentFen, pieceChar, square);

  if (hasIllegalBattery(newFen, isWhite)) {
    return NextResponse.json({ error: "Illegal battery — cannot place here" }, { status: 400 });
  }

  // ── Atomic conditional update ─────────────────────────────────────────────
  const pointsField = isPlayer1 ? "auxPointsPlayer1" : "auxPointsPlayer2";

  const updateResult = await prisma.game.updateMany({
    where: {
      id:     gameId,
      status: "prep",
      ...(isPlayer1
        ? { auxPointsPlayer1: { gte: value } }
        : { auxPointsPlayer2: { gte: value } }),
    },
    data: {
      fen: newFen,
      [pointsField]: { decrement: value },
    },
  });

  if (updateResult.count === 0) {
    return NextResponse.json(
      { error: "Not enough auxiliary points or game state changed" },
      { status: 409 }
    );
  }

  const updatedGame = await prisma.game.findUnique({
    where:  { id: gameId },
    select: { auxPointsPlayer1: true, auxPointsPlayer2: true },
  });

  // ── Per-player masked broadcasts ──────────────────────────────────────────
  const emitToGameUser = (global as any).emitToGameUser;

  if (emitToGameUser && game.draft1?.fen && game.draft2?.fen) {
    const originalFen = buildCombinedDraftFen(game.draft1.fen, game.draft2.fen);

    const placerMaskedFen = maskOpponentAuxPlacements(newFen, originalFen, isWhite);
    emitToGameUser(gameId, userId, "game-update", {
      fen: placerMaskedFen,
      auxPointsPlayer1: updatedGame?.auxPointsPlayer1,
      auxPointsPlayer2: updatedGame?.auxPointsPlayer2,
    });

    const opponentId        = isPlayer1 ? game.player2Id : game.player1Id;
    const opponentIsWhite   = !isWhite;
    const opponentMaskedFen = maskOpponentAuxPlacements(newFen, originalFen, opponentIsWhite);
    emitToGameUser(gameId, opponentId, "game-update", {
      fen: opponentMaskedFen,
      auxPointsPlayer1: updatedGame?.auxPointsPlayer1,
      auxPointsPlayer2: updatedGame?.auxPointsPlayer2,
    });
  }

  return NextResponse.json({ success: true });
}
