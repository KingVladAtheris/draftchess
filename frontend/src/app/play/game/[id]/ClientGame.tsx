// app/play/game/[id]/ClientGame.tsx
"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Chessboard } from "react-chessboard";
import { Chess, type Square } from "chess.js";
import { getSocket } from "@/app/lib/socket";

// ─── Draft Chess: blocks castling and en passant ───────────────────────────
class DraftChess extends Chess {
  constructor(fen?: string) {
    super(fen ?? "start");
  }
  move(moveObj: any, options?: any) {
    const result = super.move(moveObj, options);
    if (
      result &&
      (result.flags.includes("k") ||
        result.flags.includes("q") ||
        result.flags.includes("e"))
    ) {
      super.undo();
      throw new Error("Castling and en passant are not allowed");
    }
    return result;
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────
type GameStatus = "prep" | "active" | "finished";

type PendingPromotion = { from: Square; to: Square };

type GameResult = {
  winnerId: number | null;
  endReason: string;
  player1EloAfter?: number;
  player2EloAfter?: number;
  eloChange?: number;
};

type ClientGameProps = {
  gameId: number;
  myUserId: number;
  initialFen: string;
  isWhite: boolean;
  initialStatus: string;
  initialPrepStartedAt: Date | null;
  initialReadyPlayer1: boolean;
  initialReadyPlayer2: boolean;
  initialAuxPointsPlayer1: number;
  initialAuxPointsPlayer2: number;
  player1Id: number;
  player2Id: number;
};

// ─── Constants ─────────────────────────────────────────────────────────────
const MOVE_TIME_LIMIT = 30000;
const TIMEBANK_BONUS_INTERVAL = 20;

export default function ClientGame({
  gameId,
  myUserId,
  initialFen,
  isWhite,
  initialStatus,
  initialPrepStartedAt,
  initialReadyPlayer1,
  initialReadyPlayer2,
  initialAuxPointsPlayer1,
  initialAuxPointsPlayer2,
  player1Id,
  player2Id,
}: ClientGameProps) {
  // ─── Core game state (server-authoritative) ───────────────────────────────
  // Single FEN: used for both prep and active. During prep it may be masked.
  const [fen, setFen] = useState(initialFen);
  const [status, setStatus] = useState<GameStatus>(initialStatus as GameStatus);
  const [prepStartedAt, setPrepStartedAt] = useState<Date | null>(initialPrepStartedAt);
  const [readyPlayer1, setReadyPlayer1] = useState(initialReadyPlayer1);
  const [readyPlayer2, setReadyPlayer2] = useState(initialReadyPlayer2);
  const [auxPointsPlayer1, setAuxPointsPlayer1] = useState(initialAuxPointsPlayer1);
  const [auxPointsPlayer2, setAuxPointsPlayer2] = useState(initialAuxPointsPlayer2);

  // ─── Time state (server sets, client counts down) ─────────────────────────
  const [player1Timebank, setPlayer1Timebank] = useState(60000);
  const [player2Timebank, setPlayer2Timebank] = useState(60000);
  const [lastMoveAt, setLastMoveAt] = useState<Date | null>(null);
  const [moveTimeRemaining, setMoveTimeRemaining] = useState(MOVE_TIME_LIMIT);

  // isMyTurn is always derived from the FEN turn + isWhite — never from server opinion
  const isMyTurn = useMemo(() => {
    if (status !== "active") return false;
    try {
      const turn = fen.split(" ")[1];
      return (turn === "w" && isWhite) || (turn === "b" && !isWhite);
    } catch {
      return false;
    }
  }, [fen, status, isWhite]);

  // ─── Move number (for timebank bonus notification) ────────────────────────
  const [moveNumber, setMoveNumber] = useState(0);
  const [showTimebankBonus, setShowTimebankBonus] = useState(false);

  // ─── Game result overlay ──────────────────────────────────────────────────
  const [gameResult, setGameResult] = useState<GameResult | null>(null);

  // ─── UI / UX state ────────────────────────────────────────────────────────
  const [socketError, setSocketError] = useState<string | null>(null);
  const [activePiece, setActivePiece] = useState<string | null>(null);
  const [legalSquares, setLegalSquares] = useState<string[]>([]);
  const [illegalSquares, setIllegalSquares] = useState<string[]>([]);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);
  const [prepTimeRemaining, setPrepTimeRemaining] = useState(60);

  // ─── Chess engine ref (active game only) ──────────────────────────────────
  // We keep a ref to the chess engine for move validation.
  // It is ALWAYS synced from the server FEN — never from optimistic local state.
  const chessRef = useRef<DraftChess>(new DraftChess(initialFen));
  const isSubmittingMove = useRef(false);

  // ─── Derived values ───────────────────────────────────────────────────────
  // isPlayer1: true if this user occupies the player1 slot (queue order, not color)
  // Used for slot-based fields: readyPlayer1/2, auxPointsPlayer1/2, player1/2Timebank
  const isPlayer1 = myUserId === player1Id;

  const ownReady = isPlayer1 ? readyPlayer1 : readyPlayer2;
  const oppReady = isPlayer1 ? readyPlayer2 : readyPlayer1;
  const auxPoints = isPlayer1 ? auxPointsPlayer1 : auxPointsPlayer2;
  const myTimebank = isPlayer1 ? player1Timebank : player2Timebank;
  const oppTimebank = isPlayer1 ? player2Timebank : player1Timebank;

  const pieceLibrary = useMemo(() => [
    { name: "Pawn",   value: 1, fen: "P", ui: isWhite ? "wP" : "bP" },
    { name: "Knight", value: 3, fen: "N", ui: isWhite ? "wN" : "bN" },
    { name: "Bishop", value: 3, fen: "B", ui: isWhite ? "wB" : "bB" },
    { name: "Rook",   value: 5, fen: "R", ui: isWhite ? "wR" : "bR" },
  ], [isWhite]);

  const promotionPieces = useMemo(() => [
    { piece: "q", label: isWhite ? "♛" : "♕", name: "Queen" },
    { piece: "r", label: isWhite ? "♜" : "♖", name: "Rook" },
    { piece: "b", label: isWhite ? "♝" : "♗", name: "Bishop" },
    { piece: "n", label: isWhite ? "♞" : "♘", name: "Knight" },
  ], [isWhite]);

  // ─── Format ms as M:SS ────────────────────────────────────────────────────
  const formatTime = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // ─── Handle game-update socket payload ───────────────────────────────────
  const handleGameUpdate = useCallback((payload: any) => {
    // FEN update — always accept server FEN as truth
    if (payload.fen !== undefined) {
      const serverFen = payload.fen;
      setFen(serverFen);
      // Sync chess engine to server FEN
      try {
        chessRef.current = new DraftChess(serverFen);
      } catch {
        // Malformed FEN — keep current
      }
    }

    if (payload.status !== undefined) setStatus(payload.status as GameStatus);
    if (payload.readyPlayer1 !== undefined) setReadyPlayer1(payload.readyPlayer1);
    if (payload.readyPlayer2 !== undefined) setReadyPlayer2(payload.readyPlayer2);
    if (payload.auxPointsPlayer1 !== undefined) setAuxPointsPlayer1(payload.auxPointsPlayer1);
    if (payload.auxPointsPlayer2 !== undefined) setAuxPointsPlayer2(payload.auxPointsPlayer2);

    // Time updates — server sends absolute timebank values
    if (payload.player1Timebank !== undefined) setPlayer1Timebank(payload.player1Timebank);
    if (payload.player2Timebank !== undefined) setPlayer2Timebank(payload.player2Timebank);

    if (payload.moveNumber !== undefined) {
      const prevMove = moveNumber;
      setMoveNumber(payload.moveNumber);
      // Show timebank bonus notification
      if (
        payload.moveNumber > 0 &&
        payload.moveNumber % TIMEBANK_BONUS_INTERVAL === 0 &&
        payload.moveNumber !== prevMove
      ) {
        setShowTimebankBonus(true);
        setTimeout(() => setShowTimebankBonus(false), 4000);
      }
    }

    // Reset move timer when a new move is registered.
    // This triggers the timer useEffect to restart from the server's lastMoveAt.
    if (payload.lastMoveAt !== undefined) {
      setLastMoveAt(new Date(payload.lastMoveAt));
      setMoveTimeRemaining(MOVE_TIME_LIMIT); // reset display immediately
    }

    // Game end — only trigger when status is explicitly 'finished'
    if (payload.status === "finished") {
      setGameResult({
        winnerId: payload.winnerId ?? null,
        endReason: payload.endReason ?? "unknown",
        player1EloAfter: payload.player1EloAfter,
        player2EloAfter: payload.player2EloAfter,
        eloChange: payload.eloChange,
      });
    }
  }, [moveNumber]);

  // ─── WebSocket setup + initial HTTP load ──────────────────────────────────
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        // Fetch authoritative state from server on mount
        const res = await fetch(`/api/game/${gameId}/status`);
        if (!res.ok) throw new Error("Failed to load game state");
        const data = await res.json();

        if (mounted) {
          handleGameUpdate(data);
          // Status endpoint also sends these:
          if (data.prepStartedAt) setPrepStartedAt(new Date(data.prepStartedAt));
          if (data.lastMoveAt) setLastMoveAt(new Date(data.lastMoveAt));
          if (data.moveNumber !== undefined) setMoveNumber(data.moveNumber);
          if (data.player1Timebank !== undefined) setPlayer1Timebank(data.player1Timebank);
          if (data.player2Timebank !== undefined) setPlayer2Timebank(data.player2Timebank);
          if (data.timeRemainingOnMove !== undefined) setMoveTimeRemaining(data.timeRemainingOnMove);
          // Only show result overlay if the game is actually finished
          if (data.status === "finished" && data.endReason) {
            setGameResult({
              winnerId: data.winnerId ?? null,
              endReason: data.endReason,
              player1EloAfter: data.player1EloAfter,
              player2EloAfter: data.player2EloAfter,
              eloChange: data.eloChange,
            });
          }
        }

        // Connect WebSocket
        const socket = await getSocket();
        socket.emit("join-game", gameId);

        socket.on("game-update", (payload: any) => {
          if (!mounted) return;
          handleGameUpdate(payload);
        });

        socket.on("connect_error", (err: Error) => {
          console.error("WS error:", err);
          if (mounted) setSocketError("Real-time connection lost — moves may be delayed.");
        });

        socket.on("reconnect", () => {
          if (mounted) {
            setSocketError(null);
            socket.emit("join-game", gameId);
          }
        });

        // game-snapshot: full state pushed by server after every join-game.
        // On first connect this arrives just after the HTTP status fetch —
        // applying it is harmless (same data). On reconnect this is what
        // restores any state missed while the socket was down.
        socket.on("game-snapshot", (data: any) => {
          if (!mounted) return;
          handleGameUpdate(data);
          if (data.prepStartedAt) setPrepStartedAt(new Date(data.prepStartedAt));
          if (data.lastMoveAt)    setLastMoveAt(new Date(data.lastMoveAt));
          if (data.moveNumber    !== undefined) setMoveNumber(data.moveNumber);
          if (data.player1Timebank !== undefined) setPlayer1Timebank(data.player1Timebank);
          if (data.player2Timebank !== undefined) setPlayer2Timebank(data.player2Timebank);
          if (data.timeRemainingOnMove !== undefined) setMoveTimeRemaining(data.timeRemainingOnMove);
          if (data.status === "finished" && data.endReason) {
            setGameResult({
              winnerId:        data.winnerId ?? null,
              endReason:       data.endReason,
              player1EloAfter: data.player1EloAfter,
              player2EloAfter: data.player2EloAfter,
              eloChange:       data.eloChange,
            });
          }
        });
      } catch (err) {
        console.error("Init error:", err);
        if (mounted) setSocketError("Failed to connect to game server.");
      }
    };

    init();

    return () => {
      mounted = false;
      getSocket()
        .then((socket) => {
          socket.off("game-update");
          socket.off("game-snapshot");
          socket.off("connect_error");
          socket.off("reconnect");
        })
        .catch(() => {});
    };
  }, [gameId, handleGameUpdate]);

  // ─── Prep countdown timer ─────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "prep" || !prepStartedAt) return;
    const timer = setInterval(() => {
      const elapsed = (Date.now() - prepStartedAt.getTime()) / 1000;
      setPrepTimeRemaining(Math.max(0, 60 - elapsed));
    }, 500);
    return () => clearInterval(timer);
  }, [status, prepStartedAt]);

  // ─── Unified timer effect ────────────────────────────────────────────────
  // Runs whenever lastMoveAt or the server timebank snapshots change.
  // Handles two phases:
  //   1. Move countdown (0–30s): counts down moveTimeRemaining
  //   2. Timebank drain: once move time expires, drain the active player's timebank
  //      Visible in real-time on BOTH screens using the server snapshot as the baseline.
  //
  // We capture the server timebank values at the moment lastMoveAt is set so that
  // both players see the same drain without needing continuous socket pushes.
  const p1TimebankAtLastMove = useRef(player1Timebank);
  const p2TimebankAtLastMove = useRef(player2Timebank);

  // Capture snapshot when lastMoveAt changes (i.e., when a new move is registered)
  useEffect(() => {
    p1TimebankAtLastMove.current = player1Timebank;
    p2TimebankAtLastMove.current = player2Timebank;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMoveAt]); // only snapshot at move time, not on every tick

  useEffect(() => {
    if (status !== "active" || !lastMoveAt) return;

    // Which player is moving? Derived from FEN — server authoritative.
    const fenTurn = fen.split(" ")[1]; // "w" or "b"
    const activePlayerIsWhite = fenTurn === "w";

    const tick = () => {
      const elapsed = Date.now() - lastMoveAt.getTime();
      setMoveTimeRemaining(Math.max(0, MOVE_TIME_LIMIT - elapsed));

      if (elapsed > MOVE_TIME_LIMIT) {
        const overage = elapsed - MOVE_TIME_LIMIT;
        // Compute drain from the server snapshot taken at last move,
        // not from the current state (avoids compound subtraction drift).
        if (activePlayerIsWhite) {
          setPlayer1Timebank(Math.max(0, p1TimebankAtLastMove.current - overage));
        } else {
          setPlayer2Timebank(Math.max(0, p2TimebankAtLastMove.current - overage));
        }
      }
    };

    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, lastMoveAt]); // deliberately omit fen/timebanks — only restart on move

  // ─── FEN helpers ──────────────────────────────────────────────────────────
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
      if (char === "1") { count++; }
      else { if (count > 0) { result += count; count = 0; } result += char; }
    }
    if (count > 0) result += count;
    return result;
  };

  const getPieceAt = (currentFen: string, square: string): string => {
    const rank = parseInt(square[1], 10);
    const file = square.charCodeAt(0) - 97;
    const rankIndex = 8 - rank;
    const rows = currentFen.split(" ")[0].split("/");
    if (rankIndex < 0 || rankIndex >= 8) return "1";
    const row = expandFenRow(rows[rankIndex]);
    return row[file] ?? "1";
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

  // ─── Battery check ────────────────────────────────────────────────────────
  const hasIllegalBattery = (currentFen: string): boolean => {
    const rows = currentFen.split(" ")[0].split("/").map(expandFenRow);
    const backIdx  = isWhite ? 7 : 0;
    const frontIdx = isWhite ? 6 : 1;

    for (let file = 0; file < 8; file++) {
      const p1 = rows[backIdx][file].toUpperCase();
      const p2 = rows[frontIdx][file].toUpperCase();
      if (p1 === "1" || p2 === "1") continue;
      if (["Q", "R"].includes(p1) && ["Q", "R"].includes(p2)) return true;
    }
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
  };

  // ─── Placement square calculation ─────────────────────────────────────────
  const calculatePlacementSquares = useCallback((fenLetter: string) => {
    const legal: string[] = [];
    const illegal: string[] = [];
    const ownRanks = isWhite ? [1, 2] : [7, 8];
    const pawnRank = isWhite ? 2 : 7;
    const kingFiles = ["c", "d", "e", "f"];

    for (const r of ownRanks) {
      for (let f = 0; f < 8; f++) {
        const sq = String.fromCharCode(97 + f) + r;

        if (fenLetter === "P" && r !== pawnRank) { illegal.push(sq); continue; }
        if (fenLetter === "K" && (r !== ownRanks[0] || !kingFiles.includes(sq[0]))) { illegal.push(sq); continue; }
        if (getPieceAt(fen, sq) !== "1") { illegal.push(sq); continue; }

        const pieceChar = isWhite ? fenLetter : fenLetter.toLowerCase();
        const tempFen = simulatePlace(fen, pieceChar, sq);
        if (hasIllegalBattery(tempFen)) { illegal.push(sq); }
        else { legal.push(sq); }
      }
    }
    return { legal, illegal };
  }, [fen, isWhite]);

  // ─── Square styles ────────────────────────────────────────────────────────
  const customSquareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    legalSquares.forEach(sq => { styles[sq] = { backgroundColor: "rgba(0, 200, 0, 0.45)" }; });
    illegalSquares.forEach(sq => { styles[sq] = { backgroundColor: "rgba(220, 0, 0, 0.35)" }; });
    return styles;
  }, [legalSquares, illegalSquares]);

  // ─── Prep: place piece ────────────────────────────────────────────────────
  const handlePlace = async (fenLetter: string, square: string) => {
    const selected = pieceLibrary.find(p => p.fen === fenLetter);
    if (!selected || ownReady) return;

    if (selected.value > auxPoints) {
      alert("Not enough auxiliary points");
      return;
    }

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
        const err = await res.json();
        alert(err.error ?? "Failed to place piece");
      }
      // Server will emit game-update with correct masked FEN — no optimistic update needed
    } catch (err) {
      console.error("Place error:", err);
      alert("Failed to place piece — please try again");
    }
  };

  // ─── Prep: ready ──────────────────────────────────────────────────────────
  const handleReady = async () => {
    if (ownReady) return;
    try {
      const res = await fetch(`/api/game/${gameId}/ready`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error ?? "Failed to mark ready");
      }
      // Server emits game-update
    } catch (err) {
      console.error("Ready error:", err);
    }
  };

  // ─── Active: move submission ───────────────────────────────────────────────
  const submitMove = useCallback((from: Square, to: Square, promotion: string) => {
    isSubmittingMove.current = true;

    fetch(`/api/game/${gameId}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, promotion }),
    })
      .then(async res => {
        if (!res.ok) {
          const err = await res.json();
          console.error("Move rejected by server:", err.error);
          // Re-fetch authoritative state to fix any optimistic UI drift
          const statusRes = await fetch(`/api/game/${gameId}/status`);
          if (statusRes.ok) {
            const data = await statusRes.json();
            handleGameUpdate(data);
          }
        }
        // Success: server broadcasts game-update to both players via socket
      })
      .catch(err => {
        console.error("Move submission error:", err);
      })
      .finally(() => {
        isSubmittingMove.current = false;
      });
  }, [gameId, handleGameUpdate]);

  // ─── Promotion handlers ───────────────────────────────────────────────────
  const handlePromotionChoice = (promotion: string) => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);

    // Apply optimistically to chess engine for immediate visual feedback
    try {
      chessRef.current.move({ from, to, promotion });
      setFen(chessRef.current.fen());
    } catch {
      // Will be corrected by server update
    }
    submitMove(from, to, promotion);
  };

  const handlePromotionCancel = () => {
    setPendingPromotion(null);
    // Restore FEN from chess engine (no move was applied)
    setFen(chessRef.current.fen());
  };

  const isPromotionMove = (from: Square, to: Square): boolean => {
    const piece = chessRef.current.get(from);
    if (!piece || piece.type !== "p") return false;
    return (piece.color === "w" && to[1] === "8") || (piece.color === "b" && to[1] === "1");
  };

  // ─── Piece drop handler ───────────────────────────────────────────────────
  const handlePieceDrop = ({
    sourceSquare,
    targetSquare,
  }: {
    sourceSquare: string;
    targetSquare: string | null;
  }): boolean => {
    if (!targetSquare || status !== "active" || !isMyTurn || isSubmittingMove.current) {
      return false;
    }

    const from = sourceSquare as Square;
    const to = targetSquare as Square;

    try {
      // Validate turn from chess engine
      const turn = chessRef.current.turn();
      if ((turn === "w" && !isWhite) || (turn === "b" && isWhite)) return false;

      if (isPromotionMove(from, to)) {
        // Test legality first (with queen, then undo)
        chessRef.current.move({ from, to, promotion: "q" });
        chessRef.current.undo();
        setPendingPromotion({ from, to });
        return false; // Don't apply yet — wait for promotion choice
      }

      // Apply optimistically for immediate feedback
      chessRef.current.move({ from, to });
      setFen(chessRef.current.fen());
      submitMove(from, to, "q");
      return true;
    } catch (err) {
      // Illegal move — chess engine already handled it
      return false;
    }
  };

  // ─── Resign ───────────────────────────────────────────────────────────────
  const handleResign = async () => {
    if (!confirm("Are you sure you want to resign?")) return;
    try {
      const res = await fetch(`/api/game/${gameId}/resign`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error ?? "Failed to resign");
      }
      // Server broadcasts game-update with result
    } catch (err) {
      console.error("Resign error:", err);
    }
  };

  // ─── Game result overlay ──────────────────────────────────────────────────
  const renderGameResult = () => {
    if (!gameResult) return null;

    const isWinner = gameResult.winnerId === myUserId;
    const isDraw = gameResult.winnerId === null;

    const resultText = isDraw
      ? "Draw!"
      : isWinner
        ? "You win! 🎉"
        : "You lost.";

    const resultColor = isDraw
      ? "text-yellow-600"
      : isWinner
        ? "text-green-600"
        : "text-red-600";

    const myEloAfter = isPlayer1 ? gameResult.player1EloAfter : gameResult.player2EloAfter;
    const eloChange = gameResult.eloChange;
    const eloSign = isWinner ? "+" : isDraw ? "±" : "-";

    const endReasonLabels: Record<string, string> = {
      checkmate: "Checkmate",
      stalemate: "Stalemate",
      repetition: "Threefold Repetition",
      insufficient_material: "Insufficient Material",
      draw: "Draw by Agreement",
      timeout: "Time Out",
      resignation: "Resignation",
    };

    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-white rounded-2xl p-10 shadow-2xl text-center max-w-sm w-full mx-4">
          <h2 className={`text-4xl font-bold mb-2 ${resultColor}`}>{resultText}</h2>
          <p className="text-gray-500 mb-6">
            {endReasonLabels[gameResult.endReason] ?? gameResult.endReason}
          </p>
          {myEloAfter !== undefined && eloChange !== undefined && (
            <p className="text-lg mb-6">
              ELO: <span className="font-bold">{myEloAfter}</span>
              <span className={`ml-2 ${isWinner ? "text-green-600" : isDraw ? "text-gray-500" : "text-red-600"}`}>
                ({eloSign}{eloChange})
              </span>
            </p>
          )}
          <div className="flex gap-3 justify-center">
            <a
              href="/play/select"
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold"
            >
              Play Again
            </a>
            <a
              href="/"
              className="px-6 py-3 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 font-semibold"
            >
              Home
            </a>
          </div>
        </div>
      </div>
    );
  };

  // ─── Render: connection error ─────────────────────────────────────────────
  // Non-fatal: show banner but allow play to continue
  const renderSocketBanner = () => {
    if (!socketError) return null;
    return (
      <div className="w-full max-w-[600px] mb-4 p-3 bg-yellow-100 text-yellow-800 rounded border border-yellow-300 text-center text-sm">
        ⚠️ {socketError}
        <button
          onClick={() => window.location.reload()}
          className="ml-3 underline font-semibold"
        >
          Refresh
        </button>
      </div>
    );
  };

  // ─── Render: prep phase ───────────────────────────────────────────────────
  if (status === "prep") {
    return (
      <div className="flex min-h-screen bg-gray-100">
        {/* Sidebar */}
        <div className="w-64 bg-white p-6 border-r border-gray-300 flex flex-col">
          <h2 className="text-2xl font-bold mb-2">Prep Phase</h2>
          <p className="text-sm text-gray-500 mb-6">Place extra pieces on your side</p>

          <p className="mb-4 font-medium">
            Your points: <span className="text-blue-600 font-bold">{auxPoints}</span> / 6
          </p>

          <div className="space-y-3 flex-grow">
            {pieceLibrary.map(p => (
              <div key={p.ui} className="flex justify-between items-center">
                <span className="text-sm">{p.name} ({p.value} pts)</span>
                <button
                  disabled={ownReady || p.value > auxPoints}
                  className={`px-3 py-1 rounded text-sm transition ${
                    activePiece === p.ui
                      ? "bg-blue-500 text-white"
                      : p.value > auxPoints || ownReady
                        ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                        : "bg-gray-200 hover:bg-gray-300"
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

          <div className="mt-6 space-y-2 text-center text-sm text-gray-600">
            <p>Time left: <span className="font-bold">{Math.ceil(prepTimeRemaining)}s</span></p>
            <p>Opponent ready: {oppReady ? "✅ Yes" : "⏳ Waiting..."}</p>
          </div>

          <button
            onClick={handleReady}
            disabled={ownReady}
            className="mt-4 w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold disabled:bg-gray-400 disabled:cursor-not-allowed transition"
          >
            {ownReady ? "Waiting for opponent..." : "Ready!"}
          </button>
        </div>

        {/* Board */}
        <div className="flex-1 flex flex-col items-center p-8">
          {renderSocketBanner()}
          <h1 className="text-3xl font-bold mb-8">Game #{gameId} — Prep Phase</h1>
          <div className="w-full max-w-[600px] aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
            <Chessboard
              options={{
                position: fen,
                boardOrientation: isWhite ? "white" : "black",
                onPieceDrag: () => {},
                onPieceDrop: () => false,
                onSquareClick: ({ square }) => {
                  if (!activePiece || ownReady) return;
                  const selected = pieceLibrary.find(p => p.ui === activePiece);
                  if (selected) handlePlace(selected.fen, square);
                },
                squareStyles: customSquareStyles,
              }}
            />
          </div>
          <p className="mt-4 text-gray-500 text-sm text-center max-w-md">
            Your opponent cannot see the pieces you place here until the game starts.
          </p>
        </div>
      </div>
    );
  }

  // ─── Render: active game ──────────────────────────────────────────────────
  const movingPlayerTimebank = isMyTurn ? myTimebank : oppTimebank;
  const isTimebankActive = isMyTurn && moveTimeRemaining === 0;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      {renderGameResult()}
      {renderSocketBanner()}

      {/* Timer bar */}
      <div className="w-full max-w-[600px] mb-4 flex justify-between items-center bg-white rounded-xl p-4 shadow">
        {/* Opponent */}
        <div className="flex-1">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Opponent</div>
          <div className="text-xl font-bold text-gray-800">
            {formatTime(oppTimebank)}
            <span className="text-xs text-gray-400 ml-1">bank</span>
          </div>
        </div>

        {/* Center: move timer */}
        <div className="text-center px-6">
          <div className="text-xs text-gray-500 mb-1">Move {moveNumber}</div>
          {status === "active" && (
            <div className={`text-2xl font-bold tabular-nums ${
              isMyTurn
                ? isTimebankActive
                  ? "text-red-500 animate-pulse"
                  : moveTimeRemaining < 10000
                    ? "text-orange-500"
                    : "text-green-600"
                : "text-gray-400"
            }`}>
              {isMyTurn
                ? isTimebankActive
                  ? `⏱ ${formatTime(myTimebank)}`
                  : formatTime(moveTimeRemaining)
                : "—"}
            </div>
          )}
          {isMyTurn && !isTimebankActive && (
            <div className="text-xs text-gray-400 mt-1">your move</div>
          )}
          {isTimebankActive && isMyTurn && (
            <div className="text-xs text-red-400 mt-1">timebank draining</div>
          )}
        </div>

        {/* You */}
        <div className="flex-1 text-right">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">You</div>
          <div className="text-xl font-bold text-gray-800">
            {formatTime(myTimebank)}
            <span className="text-xs text-gray-400 ml-1">bank</span>
          </div>
        </div>
      </div>

      {/* Timebank bonus notification */}
      {showTimebankBonus && (
        <div className="w-full max-w-[600px] mb-3 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded-lg text-center font-medium animate-bounce">
          🎉 +60 seconds added to both timers!
        </div>
      )}

      <h1 className="text-2xl font-bold mb-4 text-gray-700">
        Game #{gameId} — You are {isWhite ? "White ♔" : "Black ♚"}
      </h1>

      {/* Board */}
      <div className="relative w-full max-w-[600px]">
        <div className="aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
          <Chessboard
            options={{
              position: fen,
              onPieceDrop: handlePieceDrop,
              boardOrientation: isWhite ? "white" : "black",
            }}
          />
        </div>

        {/* Promotion picker overlay */}
        {pendingPromotion && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center rounded-lg z-10">
            <div className="bg-white rounded-xl p-6 shadow-2xl text-center">
              <h3 className="text-xl font-bold mb-4">Promote pawn to:</h3>
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
                className="mt-4 text-sm text-gray-400 hover:text-gray-600 underline"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      {status === "active" && !gameResult && (
        <div className="mt-4">
          <button
            onClick={handleResign}
            className="px-5 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium transition"
          >
            Resign
          </button>
        </div>
      )}
    </div>
  );
}
