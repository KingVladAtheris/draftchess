// src/app/lib/fen-utils.ts
// Shared FEN manipulation utilities for Draft Chess

export function expandFenRow(row: string): string {
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

export function compressFenRow(row: string): string {
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

/**
 * Build the combined starting FEN from two draft FENs.
 * White (player1) occupies rows 1–2, Black (player2) occupies rows 7–8.
 * Draft FENs are stored from white's perspective so row index 7 = rank 1, row index 6 = rank 2.
 */
export function buildCombinedDraftFen(draft1Fen: string, draft2Fen: string): string {
  const w = draft1Fen.split(" ")[0].split("/");
  const b = draft2Fen.split(" ")[0].split("/");

  // Black's pieces: take white's layout from their draft and flip to lowercase
  const blackBack  = expandFenRow(b[7]).split("").map(c => /[a-zA-Z]/.test(c) ? c.toLowerCase() : c).join("");
  const blackFront = expandFenRow(b[6]).split("").map(c => /[a-zA-Z]/.test(c) ? c.toLowerCase() : c).join("");

  const rows = [
    compressFenRow(blackBack),   // rank 8
    compressFenRow(blackFront),  // rank 7
    "8", "8", "8", "8",         // ranks 6-3
    w[6],                        // rank 2 (white front)
    w[7],                        // rank 1 (white back)
  ];

  return rows.join("/") + " w - - 0 1";
}

/**
 * Mask opponent's aux placements in the FEN during prep phase.
 * The opponent's original drafted pieces remain visible.
 * Any NEW pieces the opponent placed as aux purchases are hidden (shown as empty).
 *
 * @param currentFen      The current game FEN (may contain aux placements)
 * @param originalDraftFen The combined FEN at game start, before any aux placements
 * @param viewerIsWhite   Whether the player receiving this FEN is white
 */
export function maskOpponentAuxPlacements(
  currentFen: string,
  originalDraftFen: string,
  viewerIsWhite: boolean
): string {
  const currentRows  = currentFen.split(" ")[0].split("/");
  const originalRows = originalDraftFen.split(" ")[0].split("/");

  // Row indices (0 = rank 8, 7 = rank 1):
  // White's pieces are at rows 6 (rank 2) and 7 (rank 1)
  // Black's pieces are at rows 0 (rank 8) and 1 (rank 7)
  //
  // If the viewer is white, we mask BLACK's rows (0 and 1)
  // If the viewer is black, we mask WHITE's rows (6 and 7)
  const opponentRowIndices = viewerIsWhite ? [0, 1] : [6, 7];

  const masked = [...currentRows];

  for (const idx of opponentRowIndices) {
    const cur = expandFenRow(currentRows[idx]);
    const ori = expandFenRow(originalRows[idx]);
    let row = "";

    for (let f = 0; f < 8; f++) {
      if (ori[f] !== "1") {
        // This square had a piece in the original draft — always show it
        // (show current value in case it was moved, but it can't move during prep)
        row += cur[f];
      } else {
        // This square was EMPTY in the original draft.
        // If there's a piece here now, it's an aux placement — hide it.
        row += "1";
      }
    }

    masked[idx] = compressFenRow(row);
  }

  const fenSuffix = currentFen.split(" ").slice(1).join(" ");
  return masked.join("/") + " " + fenSuffix;
}

/**
 * Check for illegal battery configurations.
 * For the given player's side:
 *   - Two rook-type pieces (Q or R) in the same file across ranks 1–2 is illegal
 *   - Two bishop-type pieces (Q or B) diagonally adjacent across ranks 1–2 is illegal
 */
export function hasIllegalBattery(fen: string, isWhite: boolean): boolean {
  const rows = fen.split(" ")[0].split("/").map(expandFenRow);
  const backIdx  = isWhite ? 7 : 0;
  const frontIdx = isWhite ? 6 : 1;

  // Check vertical rook/queen battery
  for (let file = 0; file < 8; file++) {
    const p1 = rows[backIdx][file].toUpperCase();
    const p2 = rows[frontIdx][file].toUpperCase();
    if (p1 === "1" || p2 === "1") continue;
    if (["Q", "R"].includes(p1) && ["Q", "R"].includes(p2)) return true;
  }

  // Check diagonal bishop/queen battery
  for (let file = 0; file < 7; file++) {
    const pairs = [
      [rows[backIdx][file].toUpperCase(), rows[frontIdx][file + 1].toUpperCase()],
      [rows[backIdx][file + 1].toUpperCase(), rows[frontIdx][file].toUpperCase()],
    ];
    for (const [a, b] of pairs) {
      if (a === "1" || b === "1") continue;
      if (["Q", "B"].includes(a) && ["Q", "B"].includes(b)) return true;
    }
  }

  return false;
}

/**
 * Get the piece character at a given square in a FEN string.
 * Returns "1" if the square is empty.
 */
export function getPieceAt(fen: string, square: string): string {
  const rank = parseInt(square[1], 10);
  const file = square.charCodeAt(0) - 97;
  const rankIndex = 8 - rank;
  const row = expandFenRow(fen.split(" ")[0].split("/")[rankIndex]);
  return row[file] ?? "1";
}

/**
 * Place a piece on the board and return the new FEN.
 * Does not validate — caller must check legality.
 */
export function placePieceOnFen(fen: string, pieceChar: string, square: string): string {
  const rank = parseInt(square[1], 10);
  const fileIndex = square.charCodeAt(0) - 97;
  const fenParts = fen.split(" ");
  const rows = fenParts[0].split("/");
  const rankIndex = 8 - rank;
  let row = expandFenRow(rows[rankIndex]);
  row = row.substring(0, fileIndex) + pieceChar + row.substring(fileIndex + 1);
  rows[rankIndex] = compressFenRow(row);
  return rows.join("/") + " " + fenParts.slice(1).join(" ");
}

/**
 * ELO calculation using standard formula.
 * kFactor adjusts based on number of games played (provisional vs established).
 */
export function calculateEloChange(
  winnerElo: number,
  loserElo: number,
  winnerGames: number,
  isDraw: boolean = false
): { winnerChange: number; loserChange: number } {
  const kFactor = winnerGames < 30 ? 32 : winnerGames < 100 ? 24 : 16;
  const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const expectedLoser = 1 - expectedWinner;
  const actualWinner = isDraw ? 0.5 : 1;
  const actualLoser = isDraw ? 0.5 : 0;
  const winnerChange = Math.round(kFactor * (actualWinner - expectedWinner));
  const loserChange = Math.round(kFactor * (actualLoser - expectedLoser));
  return { winnerChange, loserChange };
}
