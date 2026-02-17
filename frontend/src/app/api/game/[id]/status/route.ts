// app/api/game/[id]/status/route.ts
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";

function expandFenRow(row: string): string {
  let result = "";
  for (const char of row) {
    if (/\d/.test(char)) result += "1".repeat(parseInt(char, 10));
    else result += char;
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
      if (count > 0) { result += count; count = 0; }
      result += char;
    }
  }
  if (count > 0) result += count;
  return result;
}

// Reconstruct what the board looked like right after matchmaking combined the
// two drafts (before any aux placements). This is used to detect which squares
// were added during prep.
function buildCombinedDraftFen(draft1Fen: string, draft2Fen: string): string {
  const w = draft1Fen.split(" ")[0].split("/");
  const b = draft2Fen.split(" ")[0].split("/");

  // Black pieces go on ranks 7-8 (indices 0-1), lowercased
  const blackBack  = expandFenRow(b[7]).split("").map(c => /[a-zA-Z]/.test(c) ? c.toLowerCase() : c).join("");
  const blackFront = expandFenRow(b[6]).split("").map(c => /[a-zA-Z]/.test(c) ? c.toLowerCase() : c).join("");

  const rows = [
    compressFenRow(blackBack),
    compressFenRow(blackFront),
    "8", "8", "8", "8",
    w[6], // white forward rank (rank 2)
    w[7], // white back rank   (rank 1)
  ];

  return rows.join("/") + " w - - 0 1";
}

// Hide any piece that exists in currentFen on the opponent's ranks
// but did NOT exist in the originalDraftFen (i.e. was placed during prep).
// Draft pieces remain fully visible.
function maskAuxPlacements(
  currentFen: string,
  originalDraftFen: string,
  isWhite: boolean        // true = caller is white, so mask black's aux pieces
): string {
  const currentRows  = currentFen.split(" ")[0].split("/");
  const originalRows = originalDraftFen.split(" ")[0].split("/");

  // Opponent's row indices:
  //   white player → opponent is black → rows 0 (rank8) and 1 (rank7)
  //   black player → opponent is white → rows 6 (rank2) and 7 (rank1)
  const opponentIndices = isWhite ? [0, 1] : [6, 7];

  const masked = [...currentRows];

  for (const idx of opponentIndices) {
    const cur = expandFenRow(currentRows[idx]);
    const ori = expandFenRow(originalRows[idx]);
    let row = "";

    for (let f = 0; f < 8; f++) {
      // Square had a piece in the original draft → always show it
      // Square was empty in the original draft but has a piece now → it's an
      // aux placement → hide it (replace with empty)
      if (ori[f] !== "1") {
        row += cur[f];           // original draft piece — keep visible
      } else if (cur[f] !== "1") {
        row += "1";              // aux placement — hide
      } else {
        row += "1";              // empty — keep empty
      }
    }

    masked[idx] = compressFenRow(row);
  }

  return masked.join("/") + " " + currentFen.split(" ").slice(1).join(" ");
}

export async function GET(
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

  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: {
      fen: true,
      status: true,
      prepStartedAt: true,
      readyPlayer1: true,
      readyPlayer2: true,
      auxPointsPlayer1: true,
      auxPointsPlayer2: true,
      player1Id: true,
      player2Id: true,
      draft1: { select: { fen: true } },
      draft2: { select: { fen: true } },
    },
  });

  if (!game || (game.player1Id !== userId && game.player2Id !== userId)) {
    return NextResponse.json({ error: "Not participant" }, { status: 403 });
  }

  // Fix: handle null fen
  const gameFen = game.fen ?? "";
  const isWhite = game.player1Id === userId;

  let fen = gameFen;

  if (game.status === "prep" && game.draft1?.fen && game.draft2?.fen) {
    const originalDraftFen = buildCombinedDraftFen(game.draft1.fen, game.draft2.fen);
    fen = maskAuxPlacements(gameFen, originalDraftFen, isWhite);
  }

  return NextResponse.json({
    fen,
    status: game.status,
    prepStartedAt: game.prepStartedAt,
    readyPlayer1: game.readyPlayer1,
    readyPlayer2: game.readyPlayer2,
    auxPointsPlayer1: game.auxPointsPlayer1,
    auxPointsPlayer2: game.auxPointsPlayer2,
    player1Id: game.player1Id,
    player2Id: game.player2Id,
  });
}
