// src/app/play/select/SelectClient.tsx
// Z-pattern: draft list left, queue panel sticky right.
// One decision (which draft), one action (queue). Nothing else.
"use client";

import { useState, useEffect, useRef } from "react";
import { getSocket } from "@/app/lib/socket";

type Draft = { id: number; name: string | null; points: number; updatedAt: Date; };

function timeAgo(date: Date) {
  const d = Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7)  return `${d}d ago`;
  return new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function DraftOption({ draft, selected, disabled, onSelect }: {
  draft: Draft; selected: boolean; disabled: boolean; onSelect: () => void;
}) {
  const pct = Math.min(100, (draft.points / 33) * 100);
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className={`w-full text-left p-4 rounded-xl border transition-all duration-200
        ${disabled ? "opacity-60 cursor-not-allowed" :
          selected ? "border-amber-500/50 bg-amber-500/8 cursor-pointer" :
          "border-white/8 bg-white/[0.02] hover:border-white/18 hover:bg-white/[0.05] cursor-pointer"}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className={`font-display font-600 text-sm truncate ${selected ? "text-amber-400" : "text-white/80"}`}>
          {draft.name || `Draft #${draft.id}`}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {selected && <span className="w-4 h-4 rounded-full bg-amber-400 flex items-center justify-center text-[9px] text-[#0f1117] font-bold">✓</span>}
          <span className="text-xs text-white/30">{timeAgo(draft.updatedAt)}</span>
        </div>
      </div>
      <div className="h-0.5 rounded-full bg-white/8 overflow-hidden mb-2">
        <div className={`h-full rounded-full ${selected ? "bg-amber-400" : "bg-white/25"}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-white/35">{draft.points}/33 pts</span>
    </button>
  );
}

function QueuePanel({ selectedDraft, isQueuing, onQueue, onLeave }: {
  selectedDraft: Draft | null; isQueuing: boolean; onQueue: () => void; onLeave: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isQueuing) { setElapsed(0); startRef.current = null; return; }
    startRef.current = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current!) / 1000)), 1000);
    return () => clearInterval(t);
  }, [isQueuing]);

  const fmt = (s: number) => { const m = Math.floor(s/60); return m > 0 ? `${m}:${(s%60).toString().padStart(2,"0")}` : `${s}s`; };

  return (
    <div className="rounded-2xl border border-white/8 bg-white/[0.02] p-6 flex flex-col gap-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-white/35 mb-3">Playing with</p>
        {selectedDraft ? (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.04] border border-white/8">
            <div className="w-9 h-9 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-amber-400 text-xl flex-shrink-0">♟</div>
            <div className="min-w-0">
              <p className="text-sm font-600 font-display text-white truncate">{selectedDraft.name || `Draft #${selectedDraft.id}`}</p>
              <p className="text-xs text-white/35">{selectedDraft.points}/33 pts</p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] border border-dashed border-white/10">
            <div className="w-9 h-9 rounded-lg bg-white/5 flex items-center justify-center text-white/20 text-xl flex-shrink-0">?</div>
            <p className="text-sm text-white/30 italic">No draft selected</p>
          </div>
        )}
      </div>

      {isQueuing && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-amber-500/8 border border-amber-500/20">
          <div className="flex gap-0.5 items-end h-4">
            {[0,1,2].map(i => (
              <div key={i} className="w-1 rounded-full bg-amber-400 animate-bounce" style={{ height: "100%", animationDelay: `${i*0.15}s` }} />
            ))}
          </div>
          <div>
            <p className="text-xs font-semibold text-amber-400">Searching for opponent</p>
            <p className="text-xs text-amber-400/50 tabular-nums">{fmt(elapsed)}</p>
          </div>
        </div>
      )}

      {isQueuing ? (
        <button onClick={onLeave} className="btn-danger w-full py-3">Leave Queue</button>
      ) : (
        <button onClick={onQueue} disabled={!selectedDraft} className="btn-primary w-full py-3 disabled:opacity-40 disabled:cursor-not-allowed">
          Find a match
        </button>
      )}

      {!isQueuing && !selectedDraft && (
        <p className="text-xs text-white/30 text-center -mt-2">Select a draft to continue</p>
      )}
    </div>
  );
}

export default function SelectClient({ drafts }: { drafts: Draft[] }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isQueuing, setIsQueuing]   = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const didLeaveRef                 = useRef(false);
  const isQueuingRef                = useRef(false);

  useEffect(() => { isQueuingRef.current = isQueuing; }, [isQueuing]);

  useEffect(() => {
    let mounted = true;
    fetch("/api/queue/status").then(r => r.ok ? r.json() : null).then(data => {
      if (!mounted || !data) return;
      if (data.matched && data.gameId) { window.location.href = `/play/game/${data.gameId}`; return; }
      if (data.status === "queued") { setIsQueuing(true); attachSocket(); }
    }).catch(() => {});
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (isQueuingRef.current && !didLeaveRef.current) {
        fetch("/api/queue/leave", { method: "POST", keepalive: true }).catch(() => {});
        getSocket().then(s => s.emit("leave-queue")).catch(() => {});
      }
    };
  }, []);

  function attachSocket() {
    getSocket().then(socket => {
      socket.emit("join-queue");
      socket.off("matched");
      socket.on("matched", (data: { gameId: number }) => {
        didLeaveRef.current = true; setIsQueuing(false);
        window.location.href = `/play/game/${data.gameId}`;
      });
      socket.off("queue-error");
      socket.on("queue-error", (msg: string) => { setError(msg); setIsQueuing(false); });
    }).catch(() => { setError("Could not connect to matchmaking server"); setIsQueuing(false); });
  }

  const handleQueue = async () => {
    if (!selectedId || isQueuing) return;
    setError(null);
    try {
      const res = await fetch("/api/queue/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draftId: selectedId }) });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed to join queue"); }
      didLeaveRef.current = false; setIsQueuing(true); attachSocket();
    } catch (e: any) { setError(e.message); }
  };

  const handleLeave = async () => {
    didLeaveRef.current = true; setIsQueuing(false);
    await fetch("/api/queue/leave", { method: "POST" }).catch(() => {});
    getSocket().then(s => { s.emit("leave-queue"); s.off("matched"); s.off("queue-error"); }).catch(() => {});
  };

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-8 py-10">
      <div className="mb-8">
        <h1 className="font-display text-3xl font-800 text-white">Find a match</h1>
        <p className="text-white/45 text-sm mt-1">Choose a draft, then search for an opponent.</p>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
      )}

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        <div className={`flex-1 min-w-0 transition-opacity duration-200 ${isQueuing ? "opacity-50 pointer-events-none" : ""}`}>
          <p className="text-xs font-semibold uppercase tracking-wider text-white/35 mb-3">Your drafts</p>
          {drafts.length === 0 ? (
            <div className="flex flex-col items-center py-16 text-center rounded-2xl border border-dashed border-white/10">
              <p className="text-white/40 text-sm mb-4">No drafts yet.</p>
              <a href="/drafts" className="btn-secondary py-2 px-5 text-sm">Create a draft</a>
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {drafts.map(draft => (
                <DraftOption key={draft.id} draft={draft} selected={selectedId === draft.id} disabled={isQueuing} onSelect={() => setSelectedId(draft.id)} />
              ))}
            </div>
          )}
        </div>

        <div className="w-full lg:w-72 flex-shrink-0 lg:sticky lg:top-20">
          <QueuePanel selectedDraft={drafts.find(d => d.id === selectedId) ?? null} isQueuing={isQueuing} onQueue={handleQueue} onLeave={handleLeave} />
        </div>
      </div>
    </div>
  );
}
