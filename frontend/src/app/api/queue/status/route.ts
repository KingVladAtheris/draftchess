// app/api/queue/status/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = parseInt(session.user.id);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      queueStatus: true,
      currentGames: {
        where: { status: { in: ["starting", "active"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const currentGame = user.currentGames[0];
  const isMatched = user.queueStatus === "in_game" && currentGame != null;

  return NextResponse.json({
    matched: isMatched,
    gameId: isMatched ? currentGame.id : null,
    status: user.queueStatus,
  });
}