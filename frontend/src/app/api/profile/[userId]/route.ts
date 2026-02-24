// app/api/profile/[userId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/app/lib/prisma.server";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  const { userId } = await params;
  const id = parseInt(userId);

  if (isNaN(id)) {
    return NextResponse.json({ error: "Invalid user ID" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      name: true,
      elo: true,
      gamesPlayed: true,
      wins: true,
      losses: true,
      draws: true,
      createdAt: true,
    },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Calculate win rate
  const winRate = user.gamesPlayed > 0
    ? Math.round((user.wins / user.gamesPlayed) * 100)
    : 0;

  // Get recent games
  const recentGames = await prisma.game.findMany({
    where: {
      OR: [
        { player1Id: id },
        { player2Id: id },
      ],
      status: "finished",
    },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      player1Id: true,
      player2Id: true,
      winnerId: true,
      player1EloBefore: true,
      player2EloBefore: true,
      player1EloAfter: true,
      player2EloAfter: true,
      eloChange: true,
      createdAt: true,
      player1: { select: { username: true } },
      player2: { select: { username: true } },
    },
  });

  const games = recentGames.map(g => {
    const isPlayer1 = g.player1Id === id;
    const won = g.winnerId === id;
    const draw = g.winnerId === null;
    const eloBefore = isPlayer1 ? g.player1EloBefore : g.player2EloBefore;
    const eloAfter = isPlayer1 ? g.player1EloAfter : g.player2EloAfter;
    const eloChange = eloAfter && eloBefore ? eloAfter - eloBefore : 0;

    return {
      id: g.id,
      opponent: isPlayer1 ? g.player2.username : g.player1.username,
      result: draw ? "draw" : won ? "win" : "loss",
      eloChange,
      date: g.createdAt,
    };
  });

  return NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      elo: user.elo,
      gamesPlayed: user.gamesPlayed,
      wins: user.wins,
      losses: user.losses,
      draws: user.draws,
      winRate,
      memberSince: user.createdAt,
    },
    recentGames: games,
  });
}
