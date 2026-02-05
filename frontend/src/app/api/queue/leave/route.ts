// app/api/queue/leave/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  
  const userId = parseInt(session.user.id);

  await prisma.user.update({
    where: { id: userId },
    data: {
      queueStatus: "offline",
      queuedAt: null,
      queuedDraftId: null,
      // currentGameId removed - no longer exists in schema
    },
  });

  return NextResponse.json({ success: true });
}