// app/api/queue/join/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { triggerMatchmaking } from "@/app/lib/queue-join";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = parseInt(session.user.id);
  const { draftId } = await req.json();

  if (!draftId || typeof draftId !== "number") {
    return NextResponse.json({ error: "draftId required" }, { status: 400 });
  }

  try {
    // Verify the draft actually belongs to this user
    const draft = await prisma.draft.findFirst({
      where: {
        id: draftId,
        userId,
      },
    });

    if (!draft) {
      return NextResponse.json({ error: "Draft not found or not owned" }, { status: 403 });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        queueStatus: "queued",
        queuedAt: new Date(),
        queuedDraftId: draftId,
      },
    });

    // Immediately wake the match-worker so pairing happens without delay.
    // Non-fatal — if Redis is briefly unavailable the matchmaker will still
    // find this player on its next startup seed check.
    await triggerMatchmaking();

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}