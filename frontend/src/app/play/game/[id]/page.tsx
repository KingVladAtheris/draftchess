// app/play/game/[id]/page.tsx
// This is a Server Component — no "use client" here

import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";  // your server-only Prisma
import { redirect } from "next/navigation";
import ClientGameBoard from "./ClientGameBoard";  // import the client part

interface GamePageProps {
  params: Promise<{ id: string }>;
}

export default async function GamePage({ params }: GamePageProps) {
  const { id } = await params;
  const gameId = parseInt(id, 10);

  if (isNaN(gameId)) {
    redirect("/play/select");
  }

  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const userId = parseInt(session.user.id);

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    include: {
      player1: { select: { id: true, username: true } },
      player2: { select: { id: true, username: true } },
      draft1: { select: { fen: true } },
      draft2: { select: { fen: true } },
    },
  });

  if (!game) {
    redirect("/play/select?error=game_not_found");
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    redirect("/play/select?error=not_participant");
  }

  const initialFen = game.draft1?.fen ?? "start";

  // Optionally determine board orientation (white/black perspective)
  const isWhite = game.player1Id === userId;

  return (
    <ClientGameBoard
      gameId={gameId}
      initialFen={initialFen}
      isWhite={isWhite}
      // You can pass more props later (player usernames, opponent info, etc.)
    />
  );
}