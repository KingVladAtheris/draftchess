// app/api/game/[id]/ready/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";

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
    },
  });

  if (!game || game.status !== "prep") {
    return NextResponse.json({ error: "Invalid game state" }, { status: 400 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Not participant" }, { status: 403 });
  }

  const isWhite = game.player1Id === userId;

  if ((isWhite && game.readyPlayer1) || (!isWhite && game.readyPlayer2)) {
    return NextResponse.json({ error: "Already ready" }, { status: 400 });
  }

  await prisma.game.update({
    where: { id: gameId },
    data: isWhite ? { readyPlayer1: true } : { readyPlayer2: true },
  });

  return NextResponse.json({ success: true });
}
