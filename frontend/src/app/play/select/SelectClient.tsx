// src/app/play/select/SelectClient.tsx
'use client';

import { useState, useEffect } from 'react';
import { getSocket } from '@/app/lib/socket';  // ← new import

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
  const [socketError, setSocketError] = useState<string | null>(null);

  // Cleanup function for socket listeners
  useEffect(() => {
    return () => {
      // Optional: leave queue room when unmounting / changing page
      getSocket().then((socket) => {
        socket.emit('leave-queue');
      }).catch(() => {});
    };
  }, []);

  const handleSelect = (id: number) => {
    setSelectedDraftId(id);
  };

  const handleQueue = async () => {
    if (!selectedDraftId) return;

    setIsQueuing(true);
    setSocketError(null);

    try {
      const res = await fetch('/api/queue/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: selectedDraftId }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to join queue');
      }

      // Now connect to WebSocket and join the queue room
      const socket = await getSocket();

      // Optional: emit join-queue (server already has middleware to join 'queue' on connect,
      // but explicit emit can be useful if you want per-user tracking)
      socket.emit('join-queue');

      // Listen for match notification from matchmaker
      socket.on('matched', (data: { gameId: number }) => {
        console.log('Match found! Game ID:', data.gameId);
        setIsQueuing(false);
        window.location.href = `/play/game/${data.gameId}`;
      });

      // Optional: listen for errors from server (e.g. queue full, invalid draft)
      socket.on('queue-error', (msg: string) => {
        setSocketError(msg);
        setIsQueuing(false);
      });

    } catch (err: any) {
      console.error('Queue error:', err);
      setSocketError(err.message || 'Something went wrong');
      setIsQueuing(false);
    }
  };

  return (
    <>
      {/* Queue Button */}
      <div className="mb-10 text-center">
        <button
          disabled={!selectedDraftId || isQueuing}
          onClick={handleQueue}
          className={`px-12 py-5 text-white text-2xl rounded-lg transition ${
            selectedDraftId && !isQueuing
              ? 'bg-purple-600 hover:bg-purple-700'
              : 'bg-gray-400 cursor-not-allowed'
          }`}
        >
          {isQueuing ? 'Searching for opponent...' : 'Queue for Match'}
        </button>

        {socketError && (
          <p className="mt-3 text-red-600">{socketError}</p>
        )}

        {isQueuing && selectedDraftId && (
          <p className="mt-3 text-purple-700 font-medium">
            Selected: {drafts.find((d) => d.id === selectedDraftId)?.name || `Draft #${selectedDraftId}`}
          </p>
        )}
      </div>

      {/* Draft List – unchanged */}
      <div className="bg-white rounded-lg shadow p-6 max-h-[60vh] overflow-y-auto">
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
                  onClick={() => handleSelect(draft.id)}
                  className={`p-6 border-2 rounded-lg transition cursor-pointer relative ${
                    isSelected
                      ? 'border-purple-600 bg-purple-50 shadow-lg'
                      : 'border-gray-200 hover:border-purple-400 hover:bg-gray-50'
                  }`}
                >
                  {isSelected && (
                    <div className="absolute top-2 right-2 text-purple-600 text-2xl">✓</div>
                  )}
                  <h3 className="font-bold text-lg mb-2">
                    {draft.name || `Draft #${draft.id}`}
                  </h3>
                  <p className="text-sm text-gray-600 mb-2">
                    Points used: {draft.points}
                  </p>
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