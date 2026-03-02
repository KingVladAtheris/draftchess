// src/app/play/select/SelectClient.tsx
'use client';

import { useState, useEffect, useRef } from 'react';
import { getSocket } from '@/app/lib/socket';

type DraftSelectItem = {
  id: number;
  name: string | null;
  points: number;
  updatedAt: Date;
};

type SelectClientProps = {
  drafts: DraftSelectItem[];
};

export default function SelectClient({ drafts }: SelectClientProps) {
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);
  const [isQueuing, setIsQueuing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track whether WE initiated the leave so the unmount cleanup
  // doesn't fire a redundant /api/queue/leave after an explicit leave.
  const didLeaveRef = useRef(false);
  // Track queuing in a ref as well so the async unmount cleanup can read
  // the latest value without a stale closure.
  const isQueuingRef = useRef(false);

  // ─── Sync isQueuing → ref ────────────────────────────────────────────────
  useEffect(() => {
    isQueuingRef.current = isQueuing;
  }, [isQueuing]);

  // ─── Restore queue state on mount ────────────────────────────────────────
  // If the user was already queued (navigated away and came back), pick up
  // where they left off — show the Leave Queue button and re-attach the
  // matched socket listener.
  useEffect(() => {
    let mounted = true;

    const restore = async () => {
      try {
        const res = await fetch('/api/queue/status');
        if (!res.ok) return;
        const data = await res.json();

        // Already matched — go straight to the game
        if (data.matched && data.gameId) {
          window.location.href = `/play/game/${data.gameId}`;
          return;
        }

        // Was queued before navigating away — restore UI and re-attach socket
        if (data.status === 'queued' && mounted) {
          setIsQueuing(true);
          attachMatchedListener();
        }
      } catch {
        // Non-fatal — user just starts fresh
      }
    };

    restore();
    return () => { mounted = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Cleanup on unmount (page navigation) ────────────────────────────────
  // If the user navigates away while still queued, remove them from the queue.
  // keepalive: true ensures the fetch completes even after the component
  // unmounts / the page starts navigating away.
  useEffect(() => {
    return () => {
      if (isQueuingRef.current && !didLeaveRef.current) {
        fetch('/api/queue/leave', { method: 'POST', keepalive: true }).catch(() => {});
        getSocket()
          .then(socket => socket.emit('leave-queue'))
          .catch(() => {});
      }
    };
  }, []); // runs only on unmount

  // ─── Attach socket matched listener ──────────────────────────────────────
  function attachMatchedListener() {
    getSocket()
      .then(socket => {
        socket.emit('join-queue');

        // Remove any previous listener before adding to avoid duplicates
        socket.off('matched');
        socket.on('matched', (data: { gameId: number }) => {
          console.log('Match found! Game ID:', data.gameId);
          didLeaveRef.current = true; // don't call leave on unmount
          setIsQueuing(false);
          window.location.href = `/play/game/${data.gameId}`;
        });

        socket.off('queue-error');
        socket.on('queue-error', (msg: string) => {
          setError(msg);
          setIsQueuing(false);
        });
      })
      .catch(err => {
        console.error('Socket error:', err);
        setError('Could not connect to matchmaking server');
        setIsQueuing(false);
      });
  }

  // ─── Join queue ───────────────────────────────────────────────────────────
  const handleQueue = async () => {
    if (!selectedDraftId || isQueuing) return;
    setError(null);

    try {
      const res = await fetch('/api/queue/join', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ draftId: selectedDraftId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to join queue');
      }

      didLeaveRef.current = false;
      setIsQueuing(true);
      attachMatchedListener();
    } catch (err: any) {
      console.error('Queue error:', err);
      setError(err.message || 'Something went wrong');
    }
  };

  // ─── Leave queue ──────────────────────────────────────────────────────────
  const handleLeaveQueue = async () => {
    didLeaveRef.current = true; // prevent unmount cleanup from double-firing
    setIsQueuing(false);
    setError(null);

    try {
      await fetch('/api/queue/leave', { method: 'POST' });
    } catch (err) {
      console.error('Leave queue error:', err);
    }

    getSocket()
      .then(socket => {
        socket.emit('leave-queue');
        socket.off('matched');
        socket.off('queue-error');
      })
      .catch(() => {});
  };

  const selectedDraft = drafts.find(d => d.id === selectedDraftId);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Action area */}
      <div className="mb-10 text-center">
        {isQueuing ? (
          <div className="flex flex-col items-center gap-4">
            {/* Spinner + status */}
            <div className="flex items-center gap-3 text-purple-700 font-medium text-lg">
              <svg
                className="animate-spin h-5 w-5 text-purple-600"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              Searching for opponent...
            </div>

            {selectedDraft && (
              <p className="text-sm text-gray-500">
                Playing with{' '}
                <span className="font-semibold text-gray-700">
                  {selectedDraft.name || `Draft #${selectedDraft.id}`}
                </span>
              </p>
            )}

            <button
              onClick={handleLeaveQueue}
              className="px-8 py-3 bg-red-100 text-red-700 border border-red-300 rounded-lg hover:bg-red-200 font-semibold transition"
            >
              Leave Queue
            </button>
          </div>
        ) : (
          <button
            disabled={!selectedDraftId}
            onClick={handleQueue}
            className={`px-12 py-5 text-white text-2xl rounded-lg transition ${
              selectedDraftId
                ? 'bg-purple-600 hover:bg-purple-700'
                : 'bg-gray-400 cursor-not-allowed'
            }`}
          >
            Queue for Match
          </button>
        )}

        {error && (
          <p className="mt-3 text-red-600 text-sm">{error}</p>
        )}
      </div>

      {/* Draft list */}
      <div className={`bg-white rounded-lg shadow p-6 max-h-[60vh] overflow-y-auto transition ${isQueuing ? 'opacity-50 pointer-events-none' : ''}`}>
        {drafts.length === 0 ? (
          <p className="text-center text-gray-500 py-8">
            No drafts available. Create one first!
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {drafts.map((draft) => {
              const isSelected = selectedDraftId === draft.id;
              return (
                <div
                  key={draft.id}
                  onClick={() => { if (!isQueuing) setSelectedDraftId(draft.id); }}
                  className={`p-6 border-2 rounded-lg transition relative ${
                    isQueuing
                      ? isSelected
                        ? 'border-purple-400 bg-purple-50'
                        : 'border-gray-200 bg-gray-50'
                      : isSelected
                        ? 'border-purple-600 bg-purple-50 shadow-lg cursor-pointer'
                        : 'border-gray-200 hover:border-purple-400 hover:bg-gray-50 cursor-pointer'
                  }`}
                >
                  {isSelected && (
                    <div className="absolute top-2 right-2 text-purple-600 text-2xl">✓</div>
                  )}
                  <h3 className="font-bold text-lg mb-2">
                    {draft.name || `Draft #${draft.id}`}
                  </h3>
                  <p className="text-sm text-gray-600 mb-2">Points used: {draft.points}</p>
                  <p className="text-xs text-gray-500">
                    Last updated: {new Date(draft.updatedAt).toLocaleDateString()}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
