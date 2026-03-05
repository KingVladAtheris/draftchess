// src/app/api/queue/join/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { triggerMatchmaking } from "@/app/lib/queue-join";
import { consume, queueLimiter } from "@/app/lib/rate-limit";
import { checkCsrf } from "@/app/lib/csrf";

export async function POST(req: NextRequest) {
  const csrfError = checkCsrf(req);
  if (csrfError) return csrfError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = parseInt(session.user.id);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { draftId } = body;
  if (!draftId || typeof draftId !== "number") {
    return NextResponse.json({ error: "draftId required" }, { status: 400 });
  }

  try {
    const existingGame = await prisma.game.findFirst({
      where: {
        status: { in: ["active", "prep"] },
        OR: [{ player1Id: userId }, { player2Id: userId }],
      },
      select: { id: true },
    });

    if (existingGame) {
      return NextResponse.json(
        { error: "You are already in a game", gameId: existingGame.id },
        { status: 409 }
      );
    }

    const draft = await prisma.draft.findFirst({
      where: { id: draftId, userId },
    });

    if (!draft) {
      return NextResponse.json({ error: "Draft not found or not owned" }, { status: 403 });
    }

    const limited = await consume(queueLimiter, req, userId.toString());
    if (limited) return limited;

    await prisma.user.update({
      where: { id: userId },
      data: {
        queueStatus:   "queued",
        queuedAt:      new Date(),
        queuedDraftId: draftId,
      },
    });

    await triggerMatchmaking();
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
