// src/app/api/drafts/[id]/route.ts

import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { NextRequest, NextResponse } from "next/server";
import { consume, draftLimiter } from "@/app/lib/rate-limit";

const MAX_FEN_LENGTH  = 120;
const MAX_NAME_LENGTH = 64;
const VALID_FEN_CHARS = /^[rnbqkpRNBQKP1-8\/\s\-0]+$/;

function isValidFenStructure(fen: string): boolean {
  const parts = fen.split(" ");
  if (parts.length < 1) return false;
  const rows = parts[0].split("/");
  if (rows.length !== 8) return false;
  for (const row of rows) {
    let count = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) count += parseInt(ch, 10);
      else if (/[rnbqkpRNBQKP]/.test(ch)) count += 1;
      else return false;
    }
    if (count !== 8) return false;
  }
  return true;
}

export async function POST(
  request: NextRequest,
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

  const limited = await consume(draftLimiter, request, userId.toString());
  if (limited) return limited;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fen, points, name } = body;

  if (typeof fen !== "string" || typeof points !== "number") {
    return NextResponse.json({ error: "Invalid fen or points" }, { status: 400 });
  }

  if (fen.length > MAX_FEN_LENGTH) {
    return NextResponse.json({ error: "FEN string too long" }, { status: 400 });
  }

  if (!VALID_FEN_CHARS.test(fen)) {
    return NextResponse.json({ error: "FEN contains invalid characters" }, { status: 400 });
  }

  if (!isValidFenStructure(fen)) {
    return NextResponse.json({ error: "Invalid FEN structure" }, { status: 400 });
  }

  if (points < 0 || points > 33 || !Number.isInteger(points)) {
    return NextResponse.json({ error: "Invalid points value" }, { status: 400 });
  }

  if (name !== undefined) {
    if (typeof name !== "string") {
      return NextResponse.json({ error: "Invalid name" }, { status: 400 });
    }
    if (name.length > MAX_NAME_LENGTH) {
      return NextResponse.json(
        { error: `Name must be ${MAX_NAME_LENGTH} characters or fewer` },
        { status: 400 }
      );
    }
  }

  const draft = await prisma.draft.findUnique({
    where:  { id: draftId },
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
      ...(name !== undefined ? { name } : {}),
      updatedAt: new Date(),
    },
  });

  return NextResponse.json({ success: true });
}
