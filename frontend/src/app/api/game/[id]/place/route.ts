// app/api/game/[id]/place/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import {
  expandFenRow,
  compressFenRow,
  hasIllegalBattery,
  getPieceAt,
  placePieceOnFen,
  buildCombinedDraftFen,
  maskOpponentAuxPlacements,
} from "@/app/lib/fen-utils";

// Piece point values (Queen is not available as an aux piece)
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

  const isWhite = game.whitePlayerId === userId; // for board orientation, FEN, masking
  const isPlayer1 = game.player1Id === userId;              // for player1/player2 slot fields
  const auxPoints = isPlayer1 ? game.auxPointsPlayer1 : game.auxPointsPlayer2;

  // Validate piece type
  const value = PIECE_VALUES[piece.toUpperCase()];
  if (!value) {
    return NextResponse.json({ error: "Invalid piece type" }, { status: 400 });
  }

  // Validate points
  if (value > auxPoints) {
    return NextResponse.json({ error: "Not enough auxiliary points" }, { status: 400 });
  }

  // Validate square format
  const rank = parseInt(square[1], 10);
  const fileIndex = square.charCodeAt(0) - "a".charCodeAt(0);
  if (isNaN(rank) || isNaN(fileIndex) || fileIndex < 0 || fileIndex > 7) {
    return NextResponse.json({ error: "Invalid square" }, { status: 400 });
  }

  // Validate square is on own side
  const ownRanks = isWhite ? [1, 2] : [7, 8];
  if (!ownRanks.includes(rank)) {
    return NextResponse.json({ error: "Can only place on own ranks" }, { status: 400 });
  }

  // Pawns can only go on the front rank
  if (piece.toUpperCase() === "P") {
    const pawnRank = isWhite ? 2 : 7;
    if (rank !== pawnRank) {
      return NextResponse.json({ error: "Pawns can only be placed on the front rank" }, { status: 400 });
    }
  }

  const currentFen = game.fen ?? "";

  // Check square is empty
  if (getPieceAt(currentFen, square) !== "1") {
    return NextResponse.json({ error: "Square is already occupied" }, { status: 400 });
  }

  // Build new FEN with piece placed
  const pieceChar = isWhite ? piece.toUpperCase() : piece.toLowerCase();
  const newFen = placePieceOnFen(currentFen, pieceChar, square);

  // Validate battery rule
  if (hasIllegalBattery(newFen, isWhite)) {
    return NextResponse.json({ error: "Illegal battery — cannot place here" }, { status: 400 });
  }

  // Persist
  const updatedGame = await prisma.game.update({
    where: { id: gameId },
    data: {
      fen: newFen,
      ...(isPlayer1
        ? { auxPointsPlayer1: auxPoints - value }
        : { auxPointsPlayer2: auxPoints - value }),
    },
  });

  // ─── Per-player masked broadcasts ─────────────────────────────────────────
  // Each player receives their own view:
  //   - The placing player: sees their own new piece + opponent's original draft
  //   - The opponent: sees the same as before (placing player's new piece is hidden)
  const emitToGameUser = (global as any).emitToGameUser;

  if (emitToGameUser && game.draft1?.fen && game.draft2?.fen) {
    const originalFen = buildCombinedDraftFen(game.draft1.fen, game.draft2.fen);

    // Placing player: mask OPPONENT's aux pieces (not their own)
    const placerMaskedFen = maskOpponentAuxPlacements(newFen, originalFen, isWhite);
    emitToGameUser(gameId, userId, "game-update", {
      fen: placerMaskedFen,
      auxPointsPlayer1: updatedGame.auxPointsPlayer1,
      auxPointsPlayer2: updatedGame.auxPointsPlayer2,
    });

    // Opponent: mask the placing player's aux pieces
    const opponentId = isPlayer1 ? game.player2Id : game.player1Id;
    const opponentIsWhite = !isWhite;
    const opponentMaskedFen = maskOpponentAuxPlacements(newFen, originalFen, opponentIsWhite);
    emitToGameUser(gameId, opponentId, "game-update", {
      fen: opponentMaskedFen,
      auxPointsPlayer1: updatedGame.auxPointsPlayer1,
      auxPointsPlayer2: updatedGame.auxPointsPlayer2,
    });
  }

  return NextResponse.json({ success: true });
}
