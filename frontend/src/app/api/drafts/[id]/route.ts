// src/app/api/drafts/[id]/route.ts
import { auth } from "@/auth";
import prisma from "@/app/lib/prisma";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const draftId = parseInt(id);

  if (isNaN(draftId) || draftId <= 0) {
    return NextResponse.json({ error: "Invalid draft ID" }, { status: 400 });
  }

  const userId = parseInt(session.user.id);

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fen, points, name } = body;

  // Optional: basic input validation
  if (typeof fen !== "string" || typeof points !== "number") {
    return NextResponse.json({ error: "Invalid fen or points" }, { status: 400 });
  }

  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { userId: true },
  });

  if (!draft || draft.userId !== userId) {
    return NextResponse.json({ error: "Draft not found or unauthorized" }, { status: 404 });
  }

  await prisma.draft.update({
    where: { id: draftId },
    data: {
      fen,
      points,
      ...(name !== undefined ? { name } : {}), // only update if provided
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({ success: true });
}