"use client";

import { useState, useEffect, useRef, useMemo } from "react";
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

type PendingPromotion = {
  from: Square;
  to: Square;
};

type ClientGameProps = {
  gameId: number;
  initialFen: string;
  isWhite: boolean;
  initialStatus: string;
  initialPrepStartedAt: Date | null;
  initialReadyPlayer1: boolean;
  initialReadyPlayer2: boolean;
  initialAuxPointsPlayer1: number;
  initialAuxPointsPlayer2: number;
};

export default function ClientGame({
  gameId,
  initialFen,
  isWhite,
  initialStatus,
  initialPrepStartedAt,
  initialReadyPlayer1,
  initialReadyPlayer2,
  initialAuxPointsPlayer1,
  initialAuxPointsPlayer2,
}: ClientGameProps) {
  const [fen, setFen] = useState(initialFen);
  const [status, setStatus] = useState(initialStatus);
  const [prepStartedAt, setPrepStartedAt] = useState(initialPrepStartedAt);
  const [readyPlayer1, setReadyPlayer1] = useState(initialReadyPlayer1);
  const [readyPlayer2, setReadyPlayer2] = useState(initialReadyPlayer2);
  const [auxPointsPlayer1, setAuxPointsPlayer1] = useState(initialAuxPointsPlayer1);
  const [auxPointsPlayer2, setAuxPointsPlayer2] = useState(initialAuxPointsPlayer2);
  const [activePiece, setActivePiece] = useState<string | null>(null);
  const [remainingTime, setRemainingTime] = useState(60);
  const [legalSquares, setLegalSquares] = useState<string[]>([]);
  const [illegalSquares, setIllegalSquares] = useState<string[]>([]);

  // Promotion modal state
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);

  const gameRef = useRef<DraftChess>(new DraftChess(initialFen));
  const [gameFen, setGameFen] = useState(initialFen);
  const isMovingRef = useRef(false);

  const ownReady = isWhite ? readyPlayer1 : readyPlayer2;
  const oppReady = isWhite ? readyPlayer2 : readyPlayer1;
  const auxPoints = isWhite ? auxPointsPlayer1 : auxPointsPlayer2;

  const promotionPieces = useMemo(
    () => [
      { piece: "q", label: isWhite ? "♛" : "♕", name: "Queen"  },
      { piece: "r", label: isWhite ? "♜" : "♖", name: "Rook"   },
      { piece: "b", label: isWhite ? "♝" : "♗", name: "Bishop" },
      { piece: "n", label: isWhite ? "♞" : "♘", name: "Knight" },
    ],
    [isWhite]
  );

  const pieceLibrary = useMemo(
    () => [
      { name: "Pawn",   value: 1, fen: "P", ui: isWhite ? "wP" : "bP" },
      { name: "Knight", value: 3, fen: "N", ui: isWhite ? "wN" : "bN" },
      { name: "Bishop", value: 3, fen: "B", ui: isWhite ? "wB" : "bB" },
      { name: "Rook",   value: 5, fen: "R", ui: isWhite ? "wR" : "bR" },
    ],
    [isWhite]
  );

  // ─── Polling ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/game/${gameId}/status`);
        if (!res.ok) return;
        const data = await res.json();

        setStatus(prev => {
          if (prev === "prep" && data.status === "active") {
            gameRef.current = new DraftChess(data.fen);
            setGameFen(data.fen);
          }
          return data.status;
        });

        setPrepStartedAt(data.prepStartedAt ? new Date(data.prepStartedAt) : null);
        setReadyPlayer1(data.readyPlayer1);
        setReadyPlayer2(data.readyPlayer2);
        setAuxPointsPlayer1(data.auxPointsPlayer1);
        setAuxPointsPlayer2(data.auxPointsPlayer2);

        if (data.status === "prep") {
          setFen(data.fen);
        }

        if (data.status === "active" && !isMovingRef.current) {
          gameRef.current = new DraftChess(data.fen);
          setGameFen(data.fen);
        }
      } catch (err) {
        console.error("Poll error:", err);
      }
    }, 2000);

    return () => clearInterval(poll);
  }, [gameId]);

  // ─── Prep timer ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (status === "prep" && prepStartedAt) {
      const timer = setInterval(() => {
        const elapsed = (Date.now() - prepStartedAt.getTime()) / 1000;
        const remaining = 60 - elapsed;
        setRemainingTime(remaining > 0 ? remaining : 0);
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [status, prepStartedAt]);

  // ─── FEN helpers ─────────────────────────────────────────────────────────

  const expandFenRow = (row: string): string => {
    let result = "";
    for (const char of row) {
      if (/\d/.test(char)) result += "1".repeat(parseInt(char, 10));
      else result += char;
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
        if (count > 0) { result += count; count = 0; }
        result += char;
      }
    }
    if (count > 0) result += count;
    return result;
  };

  const getPieceAt = (currentFen: string, square: string): string => {
    const rank = parseInt(square[1], 10);
    const file = square.charCodeAt(0) - 97;
    const rankIndex = 8 - rank;
    const row = expandFenRow(currentFen.split(" ")[0].split("/")[rankIndex]);
    return row[file];
  };

  const simulatePlace = (currentFen: string, fenLetter: string, targetSquare: string): string => {
    const rank = parseInt(targetSquare[1], 10);
    const fileIndex = targetSquare.charCodeAt(0) - 97;
    const rows = currentFen.split(" ")[0].split("/");
    const rankIndex = 8 - rank;
    let row = expandFenRow(rows[rankIndex]);
    row = row.substring(0, fileIndex) + fenLetter + row.substring(fileIndex + 1);
    rows[rankIndex] = compressFenRow(row);
    return rows.join("/") + " w - - 0 1";
  };

  // ─── Battery check ───────────────────────────────────────────────────────

  const hasIllegalBattery = (currentFen: string): boolean => {
    const rows = currentFen.split(" ")[0].split("/");
    const board = rows.map(expandFenRow);
    const backIdx  = isWhite ? 7 : 0;
    const frontIdx = isWhite ? 6 : 1;

    for (let file = 0; file < 8; file++) {
      const p1 = board[backIdx][file].toUpperCase();
      const p2 = board[frontIdx][file].toUpperCase();
      if (p1 === "1" || p2 === "1") continue;
      if (["Q", "R"].includes(p1) && ["Q", "R"].includes(p2)) return true;
    }

    for (let file = 0; file < 7; file++) {
      const pairs = [
        [board[backIdx][file].toUpperCase(), board[frontIdx][file + 1].toUpperCase()],
        [board[backIdx][file + 1].toUpperCase(), board[frontIdx][file].toUpperCase()],
      ];
      for (const [a, b] of pairs) {
        if (a === "1" || b === "1") continue;
        if (["Q", "B"].includes(a) && ["Q", "B"].includes(b)) return true;
      }
    }

    return false;
  };

  // ─── Placement square calculation ────────────────────────────────────────

  const calculatePlacementSquares = (fenLetter: string): { legal: string[], illegal: string[] } => {
    const legal: string[] = [];
    const illegal: string[] = [];
    const ownRanks  = isWhite ? [1, 2] : [7, 8];
    const pawnRank  = isWhite ? 2 : 7;
    const kingFiles = ["c", "d", "e", "f"];

    for (const r of ownRanks) {
      for (let f = 0; f < 8; f++) {
        const sq = String.fromCharCode(97 + f) + r;
        if (fenLetter === "P" && r !== pawnRank) { illegal.push(sq); continue; }
        if (fenLetter === "K" && (r !== ownRanks[0] || !kingFiles.includes(sq[0]))) { illegal.push(sq); continue; }
        if (getPieceAt(fen, sq) !== "1") { illegal.push(sq); continue; }
        const pieceChar = isWhite ? fenLetter : fenLetter.toLowerCase();
        const tempFen = simulatePlace(fen, pieceChar, sq);
        if (hasIllegalBattery(tempFen)) { illegal.push(sq); } else { legal.push(sq); }
      }
    }
    return { legal, illegal };
  };

  // ─── Square styles ───────────────────────────────────────────────────────

  const customSquareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    legalSquares.forEach(sq => { styles[sq] = { backgroundColor: "rgba(0, 255, 0, 0.4)" }; });
    illegalSquares.forEach(sq => { styles[sq] = { backgroundColor: "rgba(255, 0, 0, 0.4)" }; });
    return styles;
  }, [legalSquares, illegalSquares]);

  // ─── Move submission helper ───────────────────────────────────────────────

  const submitMove = (from: Square, to: Square, promotion: string) => {
    isMovingRef.current = true;

    fetch(`/api/game/${gameId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, promotion }),
    })
      .then(res => {
        if (!res.ok) {
          gameRef.current.undo();
          setGameFen(gameRef.current.fen());
        }
      })
      .catch(() => {
        gameRef.current.undo();
        setGameFen(gameRef.current.fen());
      })
      .finally(() => {
        isMovingRef.current = false;
      });
  };

  // ─── Promotion choice handler ─────────────────────────────────────────────

  const handlePromotionChoice = (promotion: string) => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);

    try {
      gameRef.current.move({ from, to, promotion });
      setGameFen(gameRef.current.fen());
      submitMove(from, to, promotion);
    } catch {
      // Move was invalid (shouldn't happen since we already validated it)
      gameRef.current = new DraftChess(gameFen);
    }
  };

  const handlePromotionCancel = () => {
    setPendingPromotion(null);
    // Nothing to undo since we hadn't applied the move yet
  };

  // ─── Handlers ────────────────────────────────────────────────────────────

  const handlePlace = async (fenLetter: string, square: string) => {
    const selected = pieceLibrary.find((p) => p.fen === fenLetter);
    if (!selected) return;

    if (selected.value > auxPoints) {
      alert("Not enough auxiliary points");
      return;
    }

    const pieceChar = isWhite ? fenLetter : fenLetter.toLowerCase();
    const prevFen = fen;
    const tempFen = simulatePlace(fen, pieceChar, square);
    setFen(tempFen);

    const tempAux = auxPoints - selected.value;
    if (isWhite) setAuxPointsPlayer1(tempAux);
    else setAuxPointsPlayer2(tempAux);

    setActivePiece(null);
    setLegalSquares([]);
    setIllegalSquares([]);

    try {
      const res = await fetch(`/api/game/${gameId}/place`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ piece: fenLetter, square }),
      });

      if (!res.ok) {
        const error = await res.json();
        alert(error.error);
        setFen(prevFen);
        if (isWhite) setAuxPointsPlayer1(auxPoints);
        else setAuxPointsPlayer2(auxPoints);
      }
    } catch (err) {
      console.error("Place error:", err);
      setFen(prevFen);
    }
  };

  const handleReady = async () => {
    try {
      const res = await fetch(`/api/game/${gameId}/ready`, { method: "POST" });
      if (res.ok) {
        if (isWhite) setReadyPlayer1(true);
        else setReadyPlayer2(true);
      }
    } catch (err) {
      console.error("Ready error:", err);
    }
  };

  const isPromotionMove = (from: Square, to: Square): boolean => {
    const piece = gameRef.current.get(from);
    if (!piece || piece.type !== "p") return false;
    const toRank = to[1];
    return (piece.color === "w" && toRank === "8") ||
           (piece.color === "b" && toRank === "1");
  };

  const handlePieceDrop = ({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    if (!targetSquare) return false;

    const from = sourceSquare as Square;
    const to   = targetSquare as Square;

    try {
      const turn = gameRef.current.turn();
      const isMyTurn = (turn === "w" && isWhite) || (turn === "b" && !isWhite);
      if (!isMyTurn) return false;

      // Check if this is a promotion move BEFORE applying it
      if (isPromotionMove(from, to)) {
        // Validate the move is otherwise legal (try with queen, then undo)
        gameRef.current.move({ from, to, promotion: "q" });
        gameRef.current.undo();

        // Show promotion picker — move will be applied after choice
        setPendingPromotion({ from, to });
        return false; // Don't apply the move yet
      }

      // Normal move
      gameRef.current.move({ from, to });
      setGameFen(gameRef.current.fen());
      submitMove(from, to, "q"); // promotion value ignored for non-pawn moves
      return true;
    } catch (error) {
      console.log("Move rejected:", error);
      return false;
    }
  };

  // ─── Prep phase UI ───────────────────────────────────────────────────────

  if (status === "prep") {
    return (
      <div className="flex min-h-screen bg-gray-100">
        <div className="w-64 bg-white p-6 border-r border-gray-300 flex flex-col">
          <h2 className="text-2xl font-bold mb-6">Auxiliary Purchases</h2>
          <p className="mb-4">Remaining points: {auxPoints} / 6</p>

          <div className="space-y-4 flex-grow">
            {pieceLibrary.map((p) => (
              <div key={p.ui} className="flex justify-between items-center">
                <span>{p.name} ({p.value} pts)</span>
                <button
                  disabled={ownReady}
                  className={`px-3 py-1 rounded ${
                    activePiece === p.ui ? "bg-blue-500 text-white" : "bg-gray-200 hover:bg-gray-300"
                  }`}
                  onClick={() => {
                    if (activePiece === p.ui) {
                      setActivePiece(null);
                      setLegalSquares([]);
                      setIllegalSquares([]);
                    } else {
                      setActivePiece(p.ui);
                      const { legal, illegal } = calculatePlacementSquares(p.fen);
                      setLegalSquares(legal);
                      setIllegalSquares(illegal);
                    }
                  }}
                >
                  {activePiece === p.ui ? "Cancel" : "Place"}
                </button>
              </div>
            ))}
          </div>

          <button
            onClick={handleReady}
            disabled={ownReady}
            className="mt-6 w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold disabled:bg-gray-400"
          >
            {ownReady ? "Waiting for opponent..." : "Ready"}
          </button>

          <p className="mt-4 text-center">
            Time left: {Math.floor(remainingTime)}s
            {remainingTime <= 0 && <span><br />Game starting soon...</span>}
          </p>
          <p className="mt-2 text-center">
            Opponent ready: {oppReady ? "✅ Yes" : "⏳ No"}
          </p>
        </div>

        <div className="flex-1 flex flex-col items-center p-8">
          <h1 className="text-4xl font-bold mb-8">Prep Phase - Game #{gameId}</h1>
          <div className="w-full max-w-[600px] aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
            <Chessboard
              options={{
                position: fen,
                boardOrientation: isWhite ? "white" : "black",
                onPieceDrag: () => {},
                onPieceDrop: () => false,
                onSquareClick: ({ square }) => {
                  if (activePiece && !ownReady) {
                    const selected = pieceLibrary.find((p) => p.ui === activePiece);
                    if (selected) handlePlace(selected.fen, square);
                  }
                },
                squareStyles: { ...customSquareStyles },
              }}
            />
          </div>
          <p className="mt-6 text-gray-600 text-center max-w-md">
            Place additional pieces on your side only. Opponent cannot see your placements until the game starts.
          </p>
        </div>
      </div>
    );
  }

  // ─── Active game UI ──────────────────────────────────────────────────────

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      <h1 className="text-4xl font-bold mb-8">Game #{gameId}</h1>

      <div className="relative w-full max-w-[600px]">
        <div className="aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
          <Chessboard
            options={{
              position: gameFen,
              onPieceDrop: handlePieceDrop,
              boardOrientation: isWhite ? "white" : "black",
            }}
          />
        </div>

        {/* Promotion modal — overlays the board */}
        {pendingPromotion && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center rounded-lg z-10">
            <div className="bg-white rounded-xl p-6 shadow-2xl text-center">
              <h3 className="text-xl font-bold mb-4">Choose promotion</h3>
              <div className="flex gap-3">
                {promotionPieces.map(({ piece, label, name }) => (
                  <button
                    key={piece}
                    onClick={() => handlePromotionChoice(piece)}
                    className="flex flex-col items-center p-3 rounded-lg border-2 border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition"
                  >
                    <span className="text-5xl leading-none">{label}</span>
                    <span className="text-xs mt-1 text-gray-600">{name}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={handlePromotionCancel}
                className="mt-4 text-sm text-gray-500 hover:text-gray-700 underline"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="mt-4 text-gray-600">
        You are playing as {isWhite ? "White ♔" : "Black ♚"}
      </p>
    </div>
  );
}
