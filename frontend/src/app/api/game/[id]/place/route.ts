// app/api/game/[id]/place/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";

function expandFenRow(row: string): string {
  let result = "";
  for (const char of row) {
    if (/\d/.test(char)) {
      result += "1".repeat(parseInt(char, 10));
    } else {
      result += char;
    }
  }
  return result;
}

function compressFenRow(row: string): string {
  let result = "";
  let count = 0;
  for (const char of row) {
    if (char === "1") {
      count++;
    } else {
      if (count > 0) {
        result += count;
        count = 0;
      }
      result += char;
    }
  }
  if (count > 0) result += count;
  return result;
}

function hasIllegalBattery(fen: string, isWhite: boolean): boolean {
  const rows = fen.split(" ")[0].split("/").map(expandFenRow);
  const bottomIdx = isWhite ? 7 : 0;
  const forwardIdx = isWhite ? 6 : 1;

  for (let file = 0; file < 8; file++) {
    const p1 = rows[bottomIdx][file].toUpperCase();
    const p2 = rows[forwardIdx][file].toUpperCase();
    if (p1 === "1" || p2 === "1") continue;
    if (["Q", "R"].includes(p1) && ["Q", "R"].includes(p2)) return true;
  }

  for (let file = 0; file < 7; file++) {
    const pairs = [
      [rows[bottomIdx][file].toUpperCase(), rows[forwardIdx][file + 1].toUpperCase()],
      [rows[bottomIdx][file + 1].toUpperCase(), rows[forwardIdx][file].toUpperCase()],
    ];
    for (const [a, b] of pairs) {
      if (a === "1" || b === "1") continue;
      if (["Q", "B"].includes(a) && ["Q", "B"].includes(b)) return true;
    }
  }

  return false;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const userId = parseInt(session.user.id);
  const gameId = parseInt(id);
  const { piece, square } = await req.json();

  if (!piece || !square) {
    return NextResponse.json({ error: "piece and square required" }, { status: 400 });
  }

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: {
      status: true,
      fen: true,
      auxPointsPlayer1: true,
      auxPointsPlayer2: true,
      player1Id: true,
      player2Id: true,
    },
  });

  if (!game || game.status !== "prep") {
    return NextResponse.json({ error: "Invalid game state" }, { status: 400 });
  }

  if (game.player1Id !== userId && game.player2Id !== userId) {
    return NextResponse.json({ error: "Not participant" }, { status: 403 });
  }

  const isWhite = game.player1Id === userId;
  const auxPoints = isWhite ? game.auxPointsPlayer1 : game.auxPointsPlayer2;

  const values: Record<string, number> = { P: 1, N: 3, B: 3, R: 5 };
  const value = values[piece];
  if (!value) {
    return NextResponse.json({ error: "Invalid piece" }, { status: 400 });
  }

  if (value > auxPoints) {
    return NextResponse.json({ error: "Not enough points" }, { status: 400 });
  }

  const rank = parseInt(square[1], 10);
  const fileIndex = square.charCodeAt(0) - "a".charCodeAt(0);

  if (isNaN(rank) || isNaN(fileIndex) || fileIndex < 0 || fileIndex > 7) {
    return NextResponse.json({ error: "Invalid square" }, { status: 400 });
  }

  const ownRanks = isWhite ? [1, 2] : [7, 8];
  if (!ownRanks.includes(rank)) {
    return NextResponse.json({ error: "Can only place on own ranks" }, { status: 400 });
  }

  const fenParts = game.fen.split(" ");
  const rows = fenParts[0].split("/");
  const rankIndex = 8 - rank;
  let row = expandFenRow(rows[rankIndex]);

  if (row[fileIndex] !== "1") {
    return NextResponse.json({ error: "Square occupied" }, { status: 400 });
  }

  const pieceChar = isWhite ? piece : piece.toLowerCase();
  row = row.substring(0, fileIndex) + pieceChar + row.substring(fileIndex + 1);
  rows[rankIndex] = compressFenRow(row);
  const newFen = rows.join("/") + " w - - 0 1";

  if (hasIllegalBattery(newFen, isWhite)) {
    return NextResponse.json({ error: "Illegal battery" }, { status: 400 });
  }

  await prisma.game.update({
    where: { id: gameId },
    data: {
      fen: newFen,
      ...(isWhite
        ? { auxPointsPlayer1: auxPoints - value }
        : { auxPointsPlayer2: auxPoints - value }),
    },
  });

  return NextResponse.json({ success: true });
}
