// app/play/game/[id]/ClientGameBoard.tsx
"use client";

import { useState } from "react";
import { Chessboard } from "react-chessboard";
import { Chess, type Square } from "chess.js";

class DraftChess extends Chess {
  constructor(fen?: string) {
    super(fen ?? "start");
  }

  move(
    moveObj: string | { from: Square; to: Square; promotion?: string },
    options?: any
  ) {
    try {
      const result = super.move(moveObj, options);

      if (result.flags === "e" || result.flags === "k" || result.flags === "q") {
        super.undo();
        throw new Error("Forbidden move: castling or en passant not allowed");
      }

      return result;
    } catch (error) {
      throw error;
    }
  }
}

type ClientGameBoardProps = {
  gameId: number;
  initialFen: string;
  isWhite: boolean;
};

export default function ClientGameBoard({
  gameId,
  initialFen,
  isWhite,
}: ClientGameBoardProps) {
  const [game, setGame] = useState(() => new DraftChess(initialFen));

  const handlePieceDrop = ({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    if (!targetSquare) return false;

    try {
      game.move({
        from: sourceSquare as Square,
        to: targetSquare as Square,
        promotion: "q",
      });

      setGame(new DraftChess(game.fen()));
      return true;
    } catch (error) {
      console.log("Move rejected:", error);
      return false;
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <h1 className="text-4xl font-bold mb-8">Game #{gameId}</h1>

      <div className="w-full max-w-[600px] aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
        <Chessboard
          options={{
            position: game.fen(),
            onPieceDrop: handlePieceDrop,
            boardOrientation: isWhite ? "white" : "black", // ← now dynamic!
          }}
        />
      </div>

      {/* Add reset, resign, chat, move list, etc. later */}
      <p className="mt-4 text-gray-600">
        You are playing as {isWhite ? "White" : "Black"}
      </p>
    </div>
  );
}