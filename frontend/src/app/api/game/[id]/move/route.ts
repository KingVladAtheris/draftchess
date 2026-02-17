// app/api/game/[id]/move/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { Chess } from "chess.js";

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
  const { from, to, promotion } = await req.json();

  if (!from || !to) {
    return NextResponse.json({ error: "from and to required" }, { status: 400 });
  }

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: {
      status: true,
      fen: true,
      player1Id: true,
      player2Id: true,
    },
  });

  if (!game || game.status !== "active") {
    return NextResponse.json({ error: "Invalid game state" }, { status: 400 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Not participant" }, { status: 403 });
  }

  // Fix: handle null fen
  if (!game.fen) {
    return NextResponse.json({ error: "Game has no position" }, { status: 400 });
  }

  const isWhite = game.player1Id === userId;
  const chess = new Chess(game.fen);

  // Validate it's this player's turn
  const turn = chess.turn(); // "w" or "b"
  if ((turn === "w" && !isWhite) || (turn === "b" && isWhite)) {
    return NextResponse.json({ error: "Not your turn" }, { status: 400 });
  }

  try {
    chess.move({ from, to, promotion: promotion ?? "q" });
  } catch {
    return NextResponse.json({ error: "Illegal move" }, { status: 400 });
  }

  const newFen = chess.fen();
  const newStatus = (chess.isCheckmate() || chess.isDraw()) ? "finished" : "active";

  await prisma.game.update({
    where: { id: gameId },
    data: { fen: newFen, status: newStatus },
  });

  return NextResponse.json({ success: true, fen: newFen, status: newStatus });
}
