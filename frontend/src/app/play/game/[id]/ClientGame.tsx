// app/play/game/[id]/ClientGame.tsx
"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Chessboard } from "react-chessboard";
import { Chess, type Square } from "chess.js";
import { getSocket } from "@/app/lib/socket";

class DraftChess extends Chess {
  constructor(fen?: string) { super(fen ?? "start"); }
  move(moveObj: any, options?: any) {
    const result = super.move(moveObj, options);
    if (result && (result.flags.includes("k") || result.flags.includes("q") || result.flags.includes("e"))) {
      super.undo();
      throw new Error("Castling and en passant are not allowed");
    }
    return result;
  }
}

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

const MOVE_TIME_LIMIT = 30000;
const TIMEBANK_BONUS_INTERVAL = 20;

export default function ClientGame({
  gameId, myUserId, initialFen, isWhite, initialStatus,
  initialPrepStartedAt, initialReadyPlayer1, initialReadyPlayer2,
  initialAuxPointsPlayer1, initialAuxPointsPlayer2, player1Id, player2Id,
}: ClientGameProps) {

  const [fen, setFen]                       = useState(initialFen);
  const [status, setStatus]                 = useState<GameStatus>(initialStatus as GameStatus);
  const [prepStartedAt, setPrepStartedAt]   = useState<Date | null>(initialPrepStartedAt);
  const [readyPlayer1, setReadyPlayer1]     = useState(initialReadyPlayer1);
  const [readyPlayer2, setReadyPlayer2]     = useState(initialReadyPlayer2);
  const [auxPointsPlayer1, setAuxPointsPlayer1] = useState(initialAuxPointsPlayer1);
  const [auxPointsPlayer2, setAuxPointsPlayer2] = useState(initialAuxPointsPlayer2);
  const [player1Timebank, setPlayer1Timebank]   = useState(60000);
  const [player2Timebank, setPlayer2Timebank]   = useState(60000);
  const [lastMoveAt, setLastMoveAt]         = useState<Date | null>(null);
  const [moveTimeRemaining, setMoveTimeRemaining] = useState(MOVE_TIME_LIMIT);
  const [prepTimeRemaining, setPrepTimeRemaining] = useState(60);
  const [moveNumber, setMoveNumber]         = useState(0);
  const [showTimebankBonus, setShowTimebankBonus] = useState(false);
  const [gameResult, setGameResult]         = useState<GameResult | null>(null);
  const [socketError, setSocketError]       = useState<string | null>(null);
  const [activePiece, setActivePiece]       = useState<string | null>(null);
  const [legalSquares, setLegalSquares]     = useState<string[]>([]);
  const [illegalSquares, setIllegalSquares] = useState<string[]>([]);
  const [pendingPromotion, setPendingPromotion] = useState<PendingPromotion | null>(null);

  const chessRef        = useRef<DraftChess>(new DraftChess(initialFen));
  const isSubmittingMove = useRef(false);

  // ─── Timer snapshot ref ────────────────────────────────────────────────────
  // The interval reads from here exclusively — never from React state.
  const timerSnapshot = useRef<{
    lastMoveAt: Date;
    player1Timebank: number;
    player2Timebank: number;
  } | null>(null);

  // ─── Timebank mirror refs ──────────────────────────────────────────────────
  // FIX: These refs mirror timebank state synchronously. handleGameUpdate reads
  // from them instead of closing over the state values. This breaks the cycle:
  //
  //   interval tick → setPlayer1Timebank(x) → handleGameUpdate recreated with
  //   player1Timebank=x in closure → socket listener re-registered → next
  //   game-update uses stale 60000 from old closure → display snaps to 1:00
  //
  // With refs, handleGameUpdate has no timebank values in its dep array so it
  // is never recreated by the interval's setState calls.
  const player1TimebankRef = useRef(60000);
  const player2TimebankRef = useRef(60000);

  useEffect(() => { player1TimebankRef.current = player1Timebank; }, [player1Timebank]);
  useEffect(() => { player2TimebankRef.current = player2Timebank; }, [player2Timebank]);

  // ─── Derived ───────────────────────────────────────────────────────────────
  const isPlayer1   = myUserId === player1Id;
  const ownReady    = isPlayer1 ? readyPlayer1 : readyPlayer2;
  const oppReady    = isPlayer1 ? readyPlayer2 : readyPlayer1;
  const auxPoints   = isPlayer1 ? auxPointsPlayer1 : auxPointsPlayer2;
  const myTimebank  = isPlayer1 ? player1Timebank : player2Timebank;
  const oppTimebank = isPlayer1 ? player2Timebank : player1Timebank;

  const isMyTurn = useMemo(() => {
    if (status !== "active") return false;
    try {
      const turn = fen.split(" ")[1];
      return (turn === "w" && isWhite) || (turn === "b" && !isWhite);
    } catch { return false; }
  }, [fen, status, isWhite]);

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

  const formatTime = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  // ─── updateTimerSnapshot — defined before handleGameUpdate ─────────────────
  const updateTimerSnapshot = useCallback((
    newLastMoveAt: Date,
    newP1Timebank: number,
    newP2Timebank: number,
  ) => {
    timerSnapshot.current = { lastMoveAt: newLastMoveAt, player1Timebank: newP1Timebank, player2Timebank: newP2Timebank };
    player1TimebankRef.current = newP1Timebank;
    player2TimebankRef.current = newP2Timebank;
    setLastMoveAt(newLastMoveAt);
    setPlayer1Timebank(newP1Timebank);
    setPlayer2Timebank(newP2Timebank);
    setMoveTimeRemaining(MOVE_TIME_LIMIT);
  }, []);

  // ─── handleGameUpdate ──────────────────────────────────────────────────────
  // player1Timebank / player2Timebank intentionally NOT in dep array.
  // Latest values are always available via refs.
  const handleGameUpdate = useCallback((payload: any) => {
    if (payload.fen !== undefined) {
      setFen(payload.fen);
      try { chessRef.current = new DraftChess(payload.fen); } catch { /* keep current */ }
    }
    if (payload.status       !== undefined) setStatus(payload.status as GameStatus);
    if (payload.readyPlayer1 !== undefined) setReadyPlayer1(payload.readyPlayer1);
    if (payload.readyPlayer2 !== undefined) setReadyPlayer2(payload.readyPlayer2);
    if (payload.auxPointsPlayer1 !== undefined) setAuxPointsPlayer1(payload.auxPointsPlayer1);
    if (payload.auxPointsPlayer2 !== undefined) setAuxPointsPlayer2(payload.auxPointsPlayer2);

    if (payload.moveNumber !== undefined) {
      setMoveNumber((prev) => {
        const next = payload.moveNumber;
        if (next > 0 && next % TIMEBANK_BONUS_INTERVAL === 0 && next !== prev) {
          setShowTimebankBonus(true);
          setTimeout(() => setShowTimebankBonus(false), 4000);
        }
        return next;
      });
    }

    if (payload.lastMoveAt !== undefined) {
      // Use refs for fallback — not state — so this callback stays stable
      updateTimerSnapshot(
        new Date(payload.lastMoveAt),
        payload.player1Timebank ?? player1TimebankRef.current,
        payload.player2Timebank ?? player2TimebankRef.current,
      );
    } else {
      if (payload.player1Timebank !== undefined) {
        setPlayer1Timebank(payload.player1Timebank);
        player1TimebankRef.current = payload.player1Timebank;
      }
      if (payload.player2Timebank !== undefined) {
        setPlayer2Timebank(payload.player2Timebank);
        player2TimebankRef.current = payload.player2Timebank;
      }
    }

    if (payload.status === "finished") {
      setGameResult({
        winnerId:        payload.winnerId  ?? null,
        endReason:       payload.endReason ?? "unknown",
        player1EloAfter: payload.player1EloAfter,
        player2EloAfter: payload.player2EloAfter,
        eloChange:       payload.eloChange,
      });
    }
  }, [updateTimerSnapshot]); // stable — no timebank state in deps

  // ─── WebSocket setup ───────────────────────────────────────────────────────
  useEffect(() => {
    let mounted = true;
    const init = async () => {
      try {
        const res = await fetch(`/api/game/${gameId}/status`);
        if (!res.ok) throw new Error("Failed to load game state");
        const data = await res.json();
        if (mounted) {
          handleGameUpdate(data);
          if (data.prepStartedAt) setPrepStartedAt(new Date(data.prepStartedAt));
          if (data.moveNumber !== undefined) setMoveNumber(data.moveNumber);
          if (data.lastMoveAt) {
            updateTimerSnapshot(new Date(data.lastMoveAt), data.player1Timebank ?? 60000, data.player2Timebank ?? 60000);
            if (data.timeRemainingOnMove !== undefined) setMoveTimeRemaining(data.timeRemainingOnMove);
          }
          if (data.status === "finished" && data.endReason) {
            setGameResult({ winnerId: data.winnerId ?? null, endReason: data.endReason, player1EloAfter: data.player1EloAfter, player2EloAfter: data.player2EloAfter, eloChange: data.eloChange });
          }
        }

        const socket = await getSocket();
        socket.emit("join-game", gameId);
        socket.on("game-update",    (payload: any) => { if (mounted) handleGameUpdate(payload); });
        socket.on("connect_error",  (err: Error)   => { console.error("WS error:", err); if (mounted) setSocketError("Real-time connection lost — moves may be delayed."); });
        socket.on("reconnect",      ()             => { if (mounted) { setSocketError(null); socket.emit("join-game", gameId); } });
        socket.on("game-snapshot",  (data: any)   => {
          if (!mounted) return;
          handleGameUpdate(data);
          if (data.prepStartedAt) setPrepStartedAt(new Date(data.prepStartedAt));
          if (data.moveNumber !== undefined) setMoveNumber(data.moveNumber);
          if (data.lastMoveAt) {
            updateTimerSnapshot(new Date(data.lastMoveAt), data.player1Timebank ?? 60000, data.player2Timebank ?? 60000);
            if (data.timeRemainingOnMove !== undefined) setMoveTimeRemaining(data.timeRemainingOnMove);
          }
          if (data.status === "finished" && data.endReason) {
            setGameResult({ winnerId: data.winnerId ?? null, endReason: data.endReason, player1EloAfter: data.player1EloAfter, player2EloAfter: data.player2EloAfter, eloChange: data.eloChange });
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
      getSocket().then(s => { s.off("game-update"); s.off("game-snapshot"); s.off("connect_error"); s.off("reconnect"); }).catch(() => {});
    };
  }, [gameId, handleGameUpdate, updateTimerSnapshot]);

  // ─── Prep countdown ────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "prep" || !prepStartedAt) return;
    const timer = setInterval(() => {
      setPrepTimeRemaining(Math.max(0, 60 - (Date.now() - prepStartedAt.getTime()) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [status, prepStartedAt]);

  // ─── Active game timer ─────────────────────────────────────────────────────
  // Created once when status → 'active'. Reads only from refs — never state.
  useEffect(() => {
    if (status !== "active") return;
    const tick = () => {
      const snap = timerSnapshot.current;
      if (!snap) return;
      const elapsed    = Date.now() - snap.lastMoveAt.getTime();
      const p1IsActive = chessRef.current.turn() === "w";
      setMoveTimeRemaining(Math.max(0, MOVE_TIME_LIMIT - elapsed));
      if (elapsed > MOVE_TIME_LIMIT) {
        const overage = elapsed - MOVE_TIME_LIMIT;
        if (p1IsActive) setPlayer1Timebank(Math.max(0, snap.player1Timebank - overage));
        else            setPlayer2Timebank(Math.max(0, snap.player2Timebank - overage));
      }
    };
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ─── FEN helpers ───────────────────────────────────────────────────────────
  const expandFenRow = (row: string) => {
    let r = "";
    for (const c of row) r += /\d/.test(c) ? "1".repeat(parseInt(c)) : c;
    return r;
  };
  const compressFenRow = (row: string) => {
    let r = "", n = 0;
    for (const c of row) { if (c === "1") n++; else { if (n) { r += n; n = 0; } r += c; } }
    if (n) r += n;
    return r;
  };
  const getPieceAt = (f: string, sq: string) => {
    const rank = parseInt(sq[1]); const file = sq.charCodeAt(0) - 97;
    const rows = f.split(" ")[0].split("/"); const ri = 8 - rank;
    if (ri < 0 || ri >= 8) return "1";
    return expandFenRow(rows[ri])[file] ?? "1";
  };
  const simulatePlace = (f: string, piece: string, sq: string) => {
    const rank = parseInt(sq[1]); const fi = sq.charCodeAt(0) - 97;
    const rows = f.split(" ")[0].split("/"); const ri = 8 - rank;
    let row = expandFenRow(rows[ri]);
    row = row.substring(0, fi) + piece + row.substring(fi + 1);
    rows[ri] = compressFenRow(row);
    return rows.join("/") + " w - - 0 1";
  };
  const hasIllegalBattery = (f: string) => {
    const rows = f.split(" ")[0].split("/").map(expandFenRow);
    const bi = isWhite ? 7 : 0; const fi = isWhite ? 6 : 1;
    for (let c = 0; c < 8; c++) {
      const a = rows[bi][c].toUpperCase(); const b = rows[fi][c].toUpperCase();
      if (a !== "1" && b !== "1" && ["Q","R"].includes(a) && ["Q","R"].includes(b)) return true;
    }
    for (let c = 0; c < 7; c++) {
      const pairs = [[rows[bi][c].toUpperCase(), rows[fi][c+1].toUpperCase()], [rows[bi][c+1].toUpperCase(), rows[fi][c].toUpperCase()]];
      for (const [a, b] of pairs)
        if (a !== "1" && b !== "1" && ["Q","B"].includes(a) && ["Q","B"].includes(b)) return true;
    }
    return false;
  };

  const calculatePlacementSquares = useCallback((fenLetter: string) => {
    const legal: string[] = []; const illegal: string[] = [];
    const ownRanks = isWhite ? [1,2] : [7,8]; const pawnRank = isWhite ? 2 : 7;
    for (const r of ownRanks) {
      for (let f = 0; f < 8; f++) {
        const sq = String.fromCharCode(97+f) + r;
        if (fenLetter === "P" && r !== pawnRank)         { illegal.push(sq); continue; }
        if (getPieceAt(fen, sq) !== "1")                 { illegal.push(sq); continue; }
        const tempFen = simulatePlace(fen, isWhite ? fenLetter : fenLetter.toLowerCase(), sq);
        if (hasIllegalBattery(tempFen)) illegal.push(sq); else legal.push(sq);
      }
    }
    return { legal, illegal };
  }, [fen, isWhite]); // eslint-disable-line react-hooks/exhaustive-deps

  const customSquareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    legalSquares.forEach(sq   => { styles[sq] = { backgroundColor: "rgba(0,200,0,0.45)" }; });
    illegalSquares.forEach(sq => { styles[sq] = { backgroundColor: "rgba(220,0,0,0.35)" }; });
    return styles;
  }, [legalSquares, illegalSquares]);

  // ─── Handlers ──────────────────────────────────────────────────────────────
  const handlePlace = async (fenLetter: string, square: string) => {
    const selected = pieceLibrary.find(p => p.fen === fenLetter);
    if (!selected || ownReady || selected.value > auxPoints) return;
    setActivePiece(null); setLegalSquares([]); setIllegalSquares([]);
    try {
      const res = await fetch(`/api/game/${gameId}/place`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ piece: fenLetter, square }) });
      if (!res.ok) { const err = await res.json(); alert(err.error ?? "Failed to place piece"); }
    } catch { alert("Failed to place piece — please try again"); }
  };

  const handleReady = async () => {
    if (ownReady) return;
    try {
      const res = await fetch(`/api/game/${gameId}/ready`, { method: "POST" });
      if (!res.ok) { const err = await res.json(); alert(err.error ?? "Failed to mark ready"); }
    } catch (err) { console.error("Ready error:", err); }
  };

  const submitMove = useCallback((from: Square, to: Square, promotion: string) => {
    isSubmittingMove.current = true;
    fetch(`/api/game/${gameId}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to, promotion }) })
      .then(async res => {
        if (!res.ok) {
          const err = await res.json(); console.error("Move rejected:", err.error);
          const sr = await fetch(`/api/game/${gameId}/status`);
          if (sr.ok) handleGameUpdate(await sr.json());
        }
      })
      .catch(err => console.error("Move error:", err))
      .finally(() => { isSubmittingMove.current = false; });
  }, [gameId, handleGameUpdate]);

  const handlePromotionChoice = (promotion: string) => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion; setPendingPromotion(null);
    try { chessRef.current.move({ from, to, promotion }); setFen(chessRef.current.fen()); } catch { /* corrected by server */ }
    submitMove(from, to, promotion);
  };
  const handlePromotionCancel = () => { setPendingPromotion(null); setFen(chessRef.current.fen()); };
  const isPromotionMove = (from: Square, to: Square) => {
    const piece = chessRef.current.get(from);
    if (!piece || piece.type !== "p") return false;
    return (piece.color === "w" && to[1] === "8") || (piece.color === "b" && to[1] === "1");
  };

  const handlePieceDrop = ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }): boolean => {
    if (!targetSquare || status !== "active" || !isMyTurn || isSubmittingMove.current) return false;
    const from = sourceSquare as Square; const to = targetSquare as Square;
    try {
      const turn = chessRef.current.turn();
      if ((turn === "w" && !isWhite) || (turn === "b" && isWhite)) return false;
      if (isPromotionMove(from, to)) {
        chessRef.current.move({ from, to, promotion: "q" }); chessRef.current.undo();
        setPendingPromotion({ from, to }); return false;
      }
      chessRef.current.move({ from, to }); setFen(chessRef.current.fen());
      submitMove(from, to, "q"); return true;
    } catch { return false; }
  };

  const handleResign = async () => {
    if (!confirm("Are you sure you want to resign?")) return;
    try {
      const res = await fetch(`/api/game/${gameId}/resign`, { method: "POST" });
      if (!res.ok) { const err = await res.json(); alert(err.error ?? "Failed to resign"); }
    } catch (err) { console.error("Resign error:", err); }
  };

  // ─── Overlays ──────────────────────────────────────────────────────────────
  const renderGameResult = () => {
    if (!gameResult) return null;
    const isWinner = gameResult.winnerId === myUserId; const isDraw = gameResult.winnerId === null;
    const resultText  = isDraw ? "Draw!" : isWinner ? "You win! 🎉" : "You lost.";
    const resultColor = isDraw ? "text-yellow-600" : isWinner ? "text-green-600" : "text-red-600";
    const myEloAfter  = isPlayer1 ? gameResult.player1EloAfter : gameResult.player2EloAfter;
    const eloSign     = isWinner ? "+" : isDraw ? "±" : "-";
    const labels: Record<string, string> = { checkmate: "Checkmate", stalemate: "Stalemate", repetition: "Threefold Repetition", insufficient_material: "Insufficient Material", draw: "Draw by Agreement", timeout: "Time Out", resignation: "Resignation", abandoned: "Abandoned" };
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
        <div className="bg-white rounded-2xl p-10 shadow-2xl text-center max-w-sm w-full mx-4">
          <h2 className={`text-4xl font-bold mb-2 ${resultColor}`}>{resultText}</h2>
          <p className="text-gray-500 mb-6">{labels[gameResult.endReason] ?? gameResult.endReason}</p>
          {myEloAfter !== undefined && gameResult.eloChange !== undefined && (
            <p className="text-lg mb-6">ELO: <span className="font-bold">{myEloAfter}</span>
              <span className={`ml-2 ${isWinner ? "text-green-600" : isDraw ? "text-gray-500" : "text-red-600"}`}>({eloSign}{gameResult.eloChange})</span>
            </p>
          )}
          <div className="flex gap-3 justify-center">
            <a href="/play/select" className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold">Play Again</a>
            <a href="/" className="px-6 py-3 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 font-semibold">Home</a>
          </div>
        </div>
      </div>
    );
  };

  const renderSocketBanner = () => !socketError ? null : (
    <div className="w-full max-w-[600px] mb-4 p-3 bg-yellow-100 text-yellow-800 rounded border border-yellow-300 text-center text-sm">
      ⚠️ {socketError}
      <button onClick={() => window.location.reload()} className="ml-3 underline font-semibold">Refresh</button>
    </div>
  );

  // ─── Render: prep ───────────────────────────────────────────────────────────
  if (status === "prep") {
    return (
      <div className="flex min-h-screen bg-gray-100">
        <div className="w-64 bg-white p-6 border-r border-gray-300 flex flex-col">
          <h2 className="text-2xl font-bold mb-2">Prep Phase</h2>
          <p className="text-sm text-gray-500 mb-6">Place extra pieces on your side</p>
          <p className="mb-4 font-medium">Your points: <span className="text-blue-600 font-bold">{auxPoints}</span> / 6</p>
          <div className="space-y-3 flex-grow">
            {pieceLibrary.map(p => (
              <div key={p.ui} className="flex justify-between items-center">
                <span className="text-sm">{p.name} ({p.value} pts)</span>
                <button
                  disabled={ownReady || p.value > auxPoints}
                  className={`px-3 py-1 rounded text-sm transition ${activePiece === p.ui ? "bg-blue-500 text-white" : p.value > auxPoints || ownReady ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-gray-200 hover:bg-gray-300"}`}
                  onClick={() => {
                    if (activePiece === p.ui) { setActivePiece(null); setLegalSquares([]); setIllegalSquares([]); }
                    else { setActivePiece(p.ui); const { legal, illegal } = calculatePlacementSquares(p.fen); setLegalSquares(legal); setIllegalSquares(illegal); }
                  }}
                >{activePiece === p.ui ? "Cancel" : "Place"}</button>
              </div>
            ))}
          </div>
          <div className="mt-6 space-y-2 text-center text-sm text-gray-600">
            <p>Time left: <span className="font-bold">{Math.ceil(prepTimeRemaining)}s</span></p>
            <p>Opponent ready: {oppReady ? "✅ Yes" : "⏳ Waiting..."}</p>
          </div>
          <button onClick={handleReady} disabled={ownReady} className="mt-4 w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-semibold disabled:bg-gray-400 disabled:cursor-not-allowed transition">
            {ownReady ? "Waiting for opponent..." : "Ready!"}
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center p-8">
          {renderSocketBanner()}
          <h1 className="text-3xl font-bold mb-8">Game #{gameId} — Prep Phase</h1>
          <div className="w-full max-w-[600px] aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
            <Chessboard options={{ position: fen, boardOrientation: isWhite ? "white" : "black", onPieceDrag: () => {}, onPieceDrop: () => false, onSquareClick: ({ square }) => { if (!activePiece || ownReady) return; const s = pieceLibrary.find(p => p.ui === activePiece); if (s) handlePlace(s.fen, square); }, squareStyles: customSquareStyles }} />
          </div>
          <p className="mt-4 text-gray-500 text-sm text-center max-w-md">Your opponent cannot see the pieces you place here until the game starts.</p>
        </div>
      </div>
    );
  }

  // ─── Render: active / finished ──────────────────────────────────────────────
  const isTimebankActive = isMyTurn && moveTimeRemaining === 0;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 p-4">
      {renderGameResult()}
      {renderSocketBanner()}
      <div className="w-full max-w-[600px] mb-4 flex justify-between items-center bg-white rounded-xl p-4 shadow">
        <div className="flex-1">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Opponent</div>
          <div className="text-xl font-bold text-gray-800">{formatTime(oppTimebank)}<span className="text-xs text-gray-400 ml-1">bank</span></div>
        </div>
        <div className="text-center px-6">
          <div className="text-xs text-gray-500 mb-1">Move {moveNumber}</div>
          {status === "active" && (
            <div className={`text-2xl font-bold tabular-nums ${isMyTurn ? isTimebankActive ? "text-red-500 animate-pulse" : moveTimeRemaining < 10000 ? "text-orange-500" : "text-green-600" : "text-gray-400"}`}>
              {isMyTurn ? isTimebankActive ? `⏱ ${formatTime(myTimebank)}` : formatTime(moveTimeRemaining) : "—"}
            </div>
          )}
          {isMyTurn && !isTimebankActive && <div className="text-xs text-gray-400 mt-1">your move</div>}
          {isTimebankActive && isMyTurn && <div className="text-xs text-red-400 mt-1">timebank draining</div>}
        </div>
        <div className="flex-1 text-right">
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">You</div>
          <div className="text-xl font-bold text-gray-800">{formatTime(myTimebank)}<span className="text-xs text-gray-400 ml-1">bank</span></div>
        </div>
      </div>

      {showTimebankBonus && (
        <div className="w-full max-w-[600px] mb-3 bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded-lg text-center font-medium animate-bounce">
          🎉 +60 seconds added to both timers!
        </div>
      )}

      <h1 className="text-2xl font-bold mb-4 text-gray-700">Game #{gameId} — You are {isWhite ? "White ♔" : "Black ♚"}</h1>

      <div className="relative w-full max-w-[600px]">
        <div className="aspect-square border-4 border-gray-800 rounded-lg overflow-hidden shadow-2xl">
          <Chessboard options={{ position: fen, onPieceDrop: handlePieceDrop, boardOrientation: isWhite ? "white" : "black" }} />
        </div>
        {pendingPromotion && (
          <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center rounded-lg z-10">
            <div className="bg-white rounded-xl p-6 shadow-2xl text-center">
              <h3 className="text-xl font-bold mb-4">Promote pawn to:</h3>
              <div className="flex gap-3">
                {promotionPieces.map(({ piece, label, name }) => (
                  <button key={piece} onClick={() => handlePromotionChoice(piece)} className="flex flex-col items-center p-3 rounded-lg border-2 border-gray-200 hover:border-blue-500 hover:bg-blue-50 transition">
                    <span className="text-5xl leading-none">{label}</span>
                    <span className="text-xs mt-1 text-gray-600">{name}</span>
                  </button>
                ))}
              </div>
              <button onClick={handlePromotionCancel} className="mt-4 text-sm text-gray-400 hover:text-gray-600 underline">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {status === "active" && !gameResult && (
        <div className="mt-4">
          <button onClick={handleResign} className="px-5 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium transition">Resign</button>
        </div>
      )}
    </div>
  );
}
