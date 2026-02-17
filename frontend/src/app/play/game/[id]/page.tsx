// app/play/game/[id]/page.tsx
// Updated to fetch additional game fields for prep phase
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";  
import { redirect } from "next/navigation";
import ClientGame from "./ClientGame";  

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

  const isWhite = game.player1Id === userId;

  return (
    <ClientGame
      gameId={gameId}
      initialFen={game.fen ?? "start"}
      isWhite={isWhite}
      initialStatus={game.status}
      initialPrepStartedAt={game.prepStartedAt}
      initialReadyPlayer1={game.readyPlayer1}
      initialReadyPlayer2={game.readyPlayer2}
      initialAuxPointsPlayer1={game.auxPointsPlayer1}
      initialAuxPointsPlayer2={game.auxPointsPlayer2}
    />
  );
}