"use client";

import { useState, useMemo } from "react";
import { Chessboard } from "react-chessboard";

type LibraryPiece = {
  name: string;
  value: number;
  fen: string; // uppercase: "P", "N", "B", "R", "Q", "K"
  ui: string;  // "wP", "wN", etc.
};

export default function DraftPage() {
  const [position, setPosition] = useState("8/8/8/8/8/8/8/4K3 w - - 0 1"); // white king on e1

  const [pointsUsed, setPointsUsed] = useState(0);
  const maxPoints = 36;

  const [activePiece, setActivePiece] = useState<string | null>(null);
  const [draggedSquare, setDraggedSquare] = useState<string | null>(null);
  const [legalSquares, setLegalSquares] = useState<string[]>([]);
  const [illegalSquares, setIllegalSquares] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const pieceLibrary: LibraryPiece[] = useMemo(
    () => [
      { name: "Pawn",   value: 1, fen: "P", ui: "wP" },
      { name: "Knight", value: 3, fen: "N", ui: "wN" },
      { name: "Bishop", value: 3, fen: "B", ui: "wB" },
      { name: "Rook",   value: 5, fen: "R", ui: "wR" },
      { name: "Queen",  value: 9, fen: "Q", ui: "wQ" },
    ],
    []
  );

  // FEN helpers
  const expandFenRow = (row: string): string => {
    let result = "";
    for (const char of row) {
      if (/\d/.test(char)) {
        result += "1".repeat(parseInt(char, 10));
      } else {
        result += char;
      }
    }
    return result;
  };

  const compressFenRow = (row: string): string => {
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
  };

  const placePiece = (fenLetter: string, targetSquare: string, addPoints = true): boolean => {
    const rank = parseInt(targetSquare[1], 10);
    const fileIndex = targetSquare.charCodeAt(0) - 97;

    if (rank !== 1 && rank !== 2) {
      alert("Pieces can only be placed on ranks 1 or 2");
      return false;
    }

    if (fenLetter === "K") {
      if (rank !== 1) {
        alert("King can only be placed on rank 1");
        return false;
      }
      const file = targetSquare[0];
      if (!["c", "d", "e", "f"].includes(file)) {
        alert("King must be placed on files c, d, e, or f on rank 1");
        return false;
      }
    }

    const selected = pieceLibrary.find((p) => p.fen === fenLetter) ||
                     (fenLetter === "K" ? { name: "King", value: 0, fen: "K", ui: "wK" } : null);
    if (!selected) return false;

    if (addPoints && pointsUsed + selected.value > maxPoints) {
      alert(`Not enough points remaining (${pointsUsed}/${maxPoints})`);
      return false;
    }

    const fenParts = position.split(" ");
    const rows = fenParts[0].split("/");

    const rankIndex = 8 - rank;
    let row = expandFenRow(rows[rankIndex]);

    if (row[fileIndex] !== "1") {
      alert("Square is already occupied");
      return false;
    }

    row = row.substring(0, fileIndex) + fenLetter + row.substring(fileIndex + 1);
    rows[rankIndex] = compressFenRow(row);
    const newPosition = rows.join("/") + " w - - 0 1";

    if (hasIllegalBattery(newPosition)) {
      alert("Illegal battery detected");
      return false;
    }

    setPosition(newPosition);
    if (addPoints) setPointsUsed((prev) => prev + selected.value);

    return true;
  };

  const removePiece = (square: string, refund = true): boolean => {
    const rank = parseInt(square[1], 10);
    const fileIndex = square.charCodeAt(0) - 97;

    const fenParts = position.split(" ");
    const rows = fenParts[0].split("/");

    const rankIndex = 8 - rank;
    let row = expandFenRow(rows[rankIndex]);

    const piece = row[fileIndex];
    if (piece === "1") return false;

    if (piece === "K") {
      alert("Cannot remove the king");
      return false;
    }

    row = row.substring(0, fileIndex) + "1" + row.substring(fileIndex + 1);
    rows[rankIndex] = compressFenRow(row);
    const newPosition = rows.join("/") + " w - - 0 1";

    setPosition(newPosition);

    if (refund) {
      const selected = pieceLibrary.find((p) => p.fen === piece.toUpperCase());
      if (selected) {
        setPointsUsed((prev) => Math.max(0, prev - selected.value));
      }
    }

    return true;
  };

  const movePiece = (from: string, to: string): boolean => {
    const rankTo = parseInt(to[1], 10);

    if (rankTo !== 1 && rankTo !== 2) {
      alert("Pieces can only be moved to ranks 1 or 2");
      return false;
    }

    const rankFrom = parseInt(from[1], 10);
    const fileFrom = from.charCodeAt(0) - 97;
    const fileTo = to.charCodeAt(0) - 97;

    const fenParts = position.split(" ");
    const rows = fenParts[0].split("/");

    const rankIndexFrom = 8 - rankFrom;
    const rankIndexTo = 8 - rankTo;

    let rowFrom = expandFenRow(rows[rankIndexFrom]);
    const piece = rowFrom[fileFrom];

    if (piece === "1") return false;

    // King restriction
    if (piece === "K") {
      const file = to[0];
      if (rankTo !== 1 || !["c", "d", "e", "f"].includes(file)) {
        alert("King can only be moved to rank 1, files c-f");
        return false;
      }
    }

    if (rowFrom[fileFrom] === "1") return false;

    // Remove from source
    rowFrom = rowFrom.substring(0, fileFrom) + "1" + rowFrom.substring(fileFrom + 1);
    rows[rankIndexFrom] = compressFenRow(rowFrom);

    let rowTo = expandFenRow(rows[rankIndexTo]);

    if (rowTo[fileTo] !== "1") {
      alert("Cannot move onto occupied square");
      return false;
    }

    // Place at target
    rowTo = rowTo.substring(0, fileTo) + piece + rowTo.substring(fileTo + 1);
    rows[rankIndexTo] = compressFenRow(rowTo);

    const newPosition = rows.join("/") + " w - - 0 1";

    if (hasIllegalBattery(newPosition)) {
      alert("Illegal battery detected");
      return false;
    }

    setPosition(newPosition);
    return true;
  };

  const hasIllegalBattery = (pos?: string): boolean => {
    const currentPos = pos || position;
    const rows = currentPos.split(" ")[0].split("/");

    const board = rows.map(expandFenRow);

    // Vertical batteries (Q/R only)
    // rank 1 is board[7], rank 2 is board[6]
    for (let file = 0; file < 8; file++) {
      const p1 = board[7][file]; // rank 1
      const p2 = board[6][file]; // rank 2

      if (p1 === "1" || p2 === "1") continue;

      // Check for Q/R vertical batteries
      if ((p1 === "Q" || p1 === "R") && (p2 === "Q" || p2 === "R")) {
        return true;
      }
    }

    // Diagonal batteries (Q/B only)
    for (let file = 0; file < 7; file++) {
      const pairs = [
        [board[7][file], board[6][file + 1]],     // rank 1 to rank 2, one file right
        [board[7][file + 1], board[6][file]],     // rank 1 to rank 2, one file left
      ];

      for (const [a, b] of pairs) {
        if (a === "1" || b === "1") continue;

        // Check for Q/B diagonal batteries
        if ((a === "Q" || a === "B") && (b === "Q" || b === "B")) {
          return true;
        }
      }
    }

    return false;
  };

  const getPieceAt = (square: string): string => {
    const rank = parseInt(square[1], 10);
    const file = square.charCodeAt(0) - 97;
    const rankIndex = 8 - rank;
    const row = expandFenRow(position.split(" ")[0].split("/")[rankIndex]);
    return row[file];
  };

  const simulateMove = (from: string, to: string): string => {
    const fenParts = position.split(" ");
    const rows = fenParts[0].split("/");

    const fromRank = parseInt(from[1], 10);
    const fromFile = from.charCodeAt(0) - 97;
    const toRank = parseInt(to[1], 10);
    const toFile = to.charCodeAt(0) - 97;

    const rankIndexFrom = 8 - fromRank;
    const rankIndexTo = 8 - toRank;

    let rowFrom = expandFenRow(rows[rankIndexFrom]);
    const piece = rowFrom[fromFile];

    rowFrom = rowFrom.substring(0, fromFile) + "1" + rowFrom.substring(fromFile + 1);
    rows[rankIndexFrom] = compressFenRow(rowFrom);

    let rowTo = expandFenRow(rows[rankIndexTo]);
    rowTo = rowTo.substring(0, toFile) + piece + rowTo.substring(toFile + 1);
    rows[rankIndexTo] = compressFenRow(rowTo);

    return rows.join("/") + " w - - 0 1";
  };

  const calculateLegalAndIllegalSquares = (from: string): { legal: string[], illegal: string[] } => {
    const legal: string[] = [];
    const illegal: string[] = [];
    const piece = getPieceAt(from);

    if (!piece || piece === "1") return { legal, illegal };

    for (let r = 1; r <= 2; r++) {
      for (let f = 0; f < 8; f++) {
        const to = String.fromCharCode(97 + f) + r;
        if (to === from) continue;

        // Check if square is occupied
        if (getPieceAt(to) !== "1") {
          illegal.push(to);
          continue;
        }

        // King restriction
        if (piece === "K" && (r !== 1 || !["c", "d", "e", "f"].includes(to[0]))) {
          illegal.push(to);
          continue;
        }

        // Simulate move and check for illegal battery
        const tempPos = simulateMove(from, to);
        if (hasIllegalBattery(tempPos)) {
          illegal.push(to);
        } else {
          legal.push(to);
        }
      }
    }

    return { legal, illegal };
  };


  const handlePieceDrag = (args: any) => {
    const square = args.square as string;
    
    if (!isDragging) {
      setIsDragging(true);
    }
    
    // Only calculate on first drag or if dragging a different piece
    if (draggedSquare !== square) {
      setDraggedSquare(square);
      const { legal, illegal } = calculateLegalAndIllegalSquares(square);
      setLegalSquares(legal);
      setIllegalSquares(illegal);
    }
  };

  const customSquareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    
    if (isDragging) {
      legalSquares.forEach(sq => {
        styles[sq] = { backgroundColor: "rgba(0, 255, 0, 0.4)" };
      });
      illegalSquares.forEach(sq => {
        styles[sq] = { backgroundColor: "rgba(255, 0, 0, 0.4)" };
      });
    }
    
    return styles;
  }, [isDragging, legalSquares, illegalSquares]);

  const handlePieceDrop = (args: any) => {
    const sourceSquare = args.sourceSquare as string;
    const targetSquare = args.targetSquare as string;
    
    // Clear highlighting
    setIsDragging(false);
    setDraggedSquare(null);
    setLegalSquares([]);
    setIllegalSquares([]);
    
    if (!targetSquare) return false;
    
    return movePiece(sourceSquare, targetSquare);
  };

  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* Sidebar */}
      <div className="w-64 bg-white p-6 border-r border-gray-300">
        <h2 className="text-2xl font-bold mb-6">Draft Army</h2>

        <div className="space-y-4">
          {pieceLibrary.map((p) => (
            <div key={p.ui} className="flex justify-between items-center">
              <span>
                {p.name} ({p.value} pts)
              </span>
              <button
                className={`px-3 py-1 rounded ${
                  activePiece === p.ui ? "bg-blue-500 text-white" : "bg-gray-200 hover:bg-gray-300"
                }`}
                onClick={() => setActivePiece(activePiece === p.ui ? null : p.ui)}
              >
                {activePiece === p.ui ? "Cancel" : "Place"}
              </button>
            </div>
          ))}
        </div>

        <div className="mt-10 font-bold text-lg text-center">
          Points used: {pointsUsed} / {maxPoints}
        </div>
      </div>

      {/* Board */}
      <div className="flex-1 flex flex-col items-center p-8">
        <h1 className="text-4xl font-bold mb-8">Draft Army</h1>

        <div className="w-full max-w-[600px] aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
          <Chessboard
            options={{
              position,
              boardOrientation: "white",
              onPieceDrag: handlePieceDrag,
              onPieceDrop: handlePieceDrop,
              onSquareClick: ({ square }) => {
                if (activePiece) {
                  const selected = pieceLibrary.find(p => p.ui === activePiece);
                  if (!selected) return;
                  placePiece(selected.fen, square);
                  setActivePiece(null);
                } else if (getPieceAt(square) !== "1") {
                  removePiece(square);
                }
              },
              onSquareRightClick: ({ square }) => {
                removePiece(square);
              },
              squareStyles: { ...customSquareStyles },
            }}
          />
        </div>

        <p className="mt-6 text-gray-600 text-center max-w-md">
          All pieces must stay on ranks 1 or 2 at all times.<br />
          The white king starts on e1 — drag it to files c–f on rank 1.<br />
          Place other pieces on ranks 1 or 2. Drag to move within ranks 1–2. Click occupied square to remove.
        </p>
      </div>
    </div>
  );
}
