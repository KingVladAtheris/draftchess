// src/app/play/select/SelectClient.tsx
"use client";

import { useState, useEffect, useRef } from "react";

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
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const handleSelect = (id: number) => {
    setSelectedDraftId(id);
  };

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const handleQueue = async () => {
    if (!selectedDraftId) return;

    setIsQueuing(true);

    try {
      const res = await fetch("/api/queue/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: selectedDraftId }),
      });

      if (!res.ok) {
        throw new Error("Failed to join queue");
      }

      // Start polling for match
      pollIntervalRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch("/api/queue/status");
          const data = await statusRes.json();

          if (data.matched) {
            stopPolling();
            window.location.href = `/play/game/${data.gameId}`;
          }
        } catch (error) {
          console.error("Error checking queue status:", error);
        }
      }, 3000);

    } catch (err) {
      console.error(err);
      alert("Failed to join queue");
      setIsQueuing(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  const isQueueEnabled = selectedDraftId !== null && !isQueuing;

  return (
    <>
      {/* Queue Button */}
      <div className="mb-10 text-center">
        <button
          disabled={!isQueueEnabled}
          onClick={handleQueue}
          className={`px-12 py-5 text-white text-2xl rounded-lg transition ${
            isQueueEnabled
              ? "bg-purple-600 hover:bg-purple-700"
              : "bg-gray-400 cursor-not-allowed"
          }`}
        >
          {isQueuing ? "Searching for opponent..." : "Queue for Match"}
        </button>

        {isQueueEnabled && selectedDraftId && (
          <p className="mt-3 text-purple-700 font-medium">
            Selected: {drafts.find((d) => d.id === selectedDraftId)?.name || `Draft #${selectedDraftId}`}
          </p>
        )}
      </div>

      {/* Draft List */}
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
                      ? "border-purple-600 bg-purple-50 shadow-lg"
                      : "border-gray-200 hover:border-purple-400 hover:bg-gray-50"
                  }`}
                >
                  {isSelected && (
                    <div className="absolute top-2 right-2 text-purple-600 text-2xl">
                      ✓
                    </div>
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
