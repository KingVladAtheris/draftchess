// src/app/play/page.tsx
"use client";

import { useState } from "react";
import { Chess, type Move, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";

// Custom class: only override .move() to block forbidden types
class DraftChess extends Chess {
  constructor(fen?: string) {
    super(fen);
  }

  move(
    moveObj: string | { from: Square; to: Square; promotion?: string },
    options?: any
  ): Move {
    try {
      const result = super.move(moveObj, options);

      if (result.flags === "e" || result.flags === "k" || result.flags === "q") {
        super.undo();
        throw new Error("Forbidden move: castling or en passant not allowed");
      }

      return result;
    } catch (error) {
      throw error; // rethrow so caller sees it
    }
  }
}

const createDraftGame = () => new DraftChess();

export default function Home() {
  const [game, setGame] = useState(createDraftGame());

  const handlePieceDrop = ({
    piece,
    sourceSquare,
    targetSquare,
  }: {
    piece: { isSparePiece: boolean; pieceType: string; position: string };
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    if (targetSquare === null) return false;

    try {
      game.move({
        from: sourceSquare as Square,
        to: targetSquare as Square,
        promotion: "q",
      });

      setGame(new DraftChess(game.fen()));
      return true;
    } catch (error) {
      if (error instanceof Error) {
        console.log("Move rejected:", error.message);
      } else {
        console.log("Move rejected:", error);
      }
      return false;
    }
  };

  const resetGame = () => {
    setGame(createDraftGame());
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <h1 className="text-4xl font-bold mb-8">Draft Chess Prototype</h1>

      <div className="w-full max-w-[600px] aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
        <Chessboard
          options={{
            position: game.fen(),
            onPieceDrop: handlePieceDrop,
          }}
        />
      </div>

      <div className="mt-6 flex gap-4">
        <button
          className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition"
          onClick={resetGame}
        >
          Reset Board
        </button>
      </div>

      <p className="mt-6 text-gray-600 text-center max-w-md">
        Drag pieces — castling and en passant are disabled!
      </p>
    </div>
  );
}