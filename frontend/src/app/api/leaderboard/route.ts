// app/api/leaderboard/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/app/lib/prisma.server";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = parseInt(searchParams.get("limit") ?? "50");
  const page = parseInt(searchParams.get("page") ?? "1");

  if (limit < 1 || limit > 100) {
    return NextResponse.json({ error: "Limit must be between 1 and 100" }, { status: 400 });
  }

  const skip = (page - 1) * limit;

  // Get top players by ELO
  const players = await prisma.user.findMany({
    where: {
      gamesPlayed: { gt: 0 },  // Only include players who have played at least one game
    },
    orderBy: [
      { elo: "desc" },
      { gamesPlayed: "desc" },  // Tiebreaker: more games = higher rank
    ],
    take: limit,
    skip,
    select: {
      id: true,
      username: true,
      name: true,
      elo: true,
      gamesPlayed: true,
      wins: true,
      losses: true,
      draws: true,
    },
  });

  // Calculate total count for pagination
  const totalCount = await prisma.user.count({
    where: { gamesPlayed: { gt: 0 } },
  });

  const leaderboard = players.map((player, index) => {
    const winRate = player.gamesPlayed > 0
      ? Math.round((player.wins / player.gamesPlayed) * 100)
      : 0;

    return {
      rank: skip + index + 1,
      id: player.id,
      username: player.username,
      name: player.name,
      elo: player.elo,
      gamesPlayed: player.gamesPlayed,
      wins: player.wins,
      losses: player.losses,
      draws: player.draws,
      winRate,
    };
  });

  return NextResponse.json({
    leaderboard,
    pagination: {
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      totalCount,
    },
  });
}
