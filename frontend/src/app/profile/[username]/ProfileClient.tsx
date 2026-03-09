"use client";
// src/app/profile/[username]/ProfileClient.tsx

import { useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch } from "@/app/lib/api-fetch";

// ─── Types ─────────────────────────────────────────────────────────────────
type GameMode = "standard" | "pauper" | "royal";

type Token = {
  slug: string; label: string; description: string | null;
  icon: string | null; color: string | null; grantedAt: string;
};

type ModeStats = { played: number; wins: number; losses: number; draws: number };

type Profile = {
  id: number; username: string; name: string | null; image: string | null;
  createdAt: string;
  elo:   { standard: number; pauper: number; royal: number };
  stats: { standard: ModeStats; pauper: ModeStats; royal: ModeStats };
  tokens: Token[];
  followerCount: number; followingCount: number;
};

type Game = {
  id: number; mode: GameMode; createdAt: string;
  result: "win" | "loss" | "draw"; endReason: string | null;
  opponent: { id: number; username: string };
  eloBefore: number | null; eloAfter: number | null; eloChange: number | null;
};

type EloPoint = { date: string; elo: number };

type FriendStatus = "none" | "pending_sent" | "pending_received" | "friends";

type Props = {
  profile: Profile;
  games: Game[];
  eloHistory: { standard: EloPoint[]; pauper: EloPoint[]; royal: EloPoint[] };
  isOwnProfile: boolean;
  isFollowing: boolean;
  friendStatus: FriendStatus;
  friendRequestId: number | null;
  viewerId: number | null;
};

// ─── Helpers ───────────────────────────────────────────────────────────────
const MODE_LABEL: Record<GameMode, string> = { standard: "Standard", pauper: "Pauper", royal: "Royal" };
const MODE_COLOR: Record<GameMode, string> = {
  standard: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  pauper:   "text-sky-400 bg-sky-400/10 border-sky-400/20",
  royal:    "text-violet-400 bg-violet-400/10 border-violet-400/20",
};
const MODE_ELO_COLOR: Record<GameMode, string> = {
  standard: "#f59e0b",
  pauper:   "#38bdf8",
  royal:    "#a78bfa",
};

function timeAgo(iso: string) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function winRate(stats: ModeStats) {
  if (stats.played === 0) return 0;
  return Math.round((stats.wins / stats.played) * 100);
}

// ─── Mini ELO Sparkline ────────────────────────────────────────────────────
function EloSparkline({ points, color, height = 40 }: { points: EloPoint[]; color: string; height?: number }) {
  if (points.length < 2) return <div className="text-white/20 text-xs">No data</div>;
  const elos  = points.map(p => p.elo);
  const min   = Math.min(...elos);
  const max   = Math.max(...elos);
  const range = max - min || 1;
  const w     = 120;
  const h     = height;
  const xs    = points.map((_, i) => (i / (points.length - 1)) * w);
  const ys    = elos.map(e => h - ((e - min) / range) * (h - 4) - 2);
  const d     = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const fill  = `${d} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <defs>
        <linearGradient id={`grad-${color.replace("#","")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#grad-${color.replace("#","")})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r="2.5" fill={color} />
    </svg>
  );
}

// ─── Full ELO Chart ────────────────────────────────────────────────────────
function EloChart({ points, color, mode }: { points: EloPoint[]; color: string; mode: string }) {
  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center h-40 rounded-xl border border-white/8 bg-white/[0.02]">
        <p className="text-white/30 text-sm">No {mode} games played yet</p>
      </div>
    );
  }
  const elos  = points.map(p => p.elo);
  const min   = Math.min(...elos) - 20;
  const max   = Math.max(...elos) + 20;
  const range = max - min;
  const w     = 600;
  const h     = 140;
  const pad   = { l: 48, r: 16, t: 12, b: 24 };
  const iw    = w - pad.l - pad.r;
  const ih    = h - pad.t - pad.b;

  const xs = points.map((_, i) => pad.l + (i / (points.length - 1)) * iw);
  const ys = elos.map(e => pad.t + ih - ((e - min) / range) * ih);
  const d  = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const fill = `${d} L${pad.l + iw},${pad.t + ih} L${pad.l},${pad.t + ih} Z`;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => min + (range / ticks) * i);

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 overflow-x-auto">
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id={`chart-grad-${mode}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {yTicks.map((tick, i) => {
          const y = pad.t + ih - ((tick - min) / range) * ih;
          return (
            <g key={i}>
              <line x1={pad.l} y1={y} x2={pad.l + iw} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              <text x={pad.l - 6} y={y + 4} textAnchor="end" fontSize="10" fill="rgba(255,255,255,0.3)">
                {Math.round(tick)}
              </text>
            </g>
          );
        })}
        {/* Area fill */}
        <path d={fill} fill={`url(#chart-grad-${mode})`} />
        {/* Line */}
        <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {/* End dot */}
        <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r="3.5" fill={color} />
        <circle cx={xs[xs.length-1]} cy={ys[ys.length-1]} r="6" fill={color} fillOpacity="0.2" />
      </svg>
    </div>
  );
}

// ─── Token Badge ───────────────────────────────────────────────────────────
function TokenBadge({ token, size = "sm" }: { token: Token; size?: "sm" | "lg" }) {
  const color = token.color ?? "#f59e0b";
  if (size === "sm") {
    return (
      <div className="relative group">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center text-base border cursor-default"
          style={{ background: `${color}18`, borderColor: `${color}35`, color }}
        >
          {token.icon ?? "🏅"}
        </div>
        {/* Tooltip */}
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 rounded-md bg-[#1a1d2e] border border-white/10 text-xs text-white/80 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 shadow-xl">
          {token.label}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4 p-4 rounded-xl border bg-white/[0.02]"
      style={{ borderColor: `${color}25` }}>
      <div
        className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl flex-shrink-0 border"
        style={{ background: `${color}18`, borderColor: `${color}35`, color }}
      >
        {token.icon ?? "🏅"}
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-white text-sm" style={{ color }}>{token.label}</p>
        {token.description && <p className="text-white/50 text-xs mt-0.5">{token.description}</p>}
        <p className="text-white/25 text-xs mt-1">Granted {timeAgo(token.grantedAt)}</p>
      </div>
    </div>
  );
}

// ─── Stat Bar ──────────────────────────────────────────────────────────────
function StatBar({ stats, mode }: { stats: ModeStats; mode: GameMode }) {
  const total = stats.played;
  const wr    = winRate(stats);
  const winPct   = total ? (stats.wins   / total) * 100 : 0;
  const lossPct  = total ? (stats.losses / total) * 100 : 0;
  const drawPct  = total ? (stats.draws  / total) * 100 : 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-white/40 uppercase tracking-wider font-semibold">{MODE_LABEL[mode]}</span>
        <span className="text-white/60">{total} games · {wr}% WR</span>
      </div>
      {total > 0 ? (
        <div className="flex h-2 rounded-full overflow-hidden gap-px">
          <div className="bg-emerald-500 rounded-l-full" style={{ width: `${winPct}%` }} />
          <div className="bg-white/20" style={{ width: `${drawPct}%` }} />
          <div className="bg-red-500/70 rounded-r-full" style={{ width: `${lossPct}%` }} />
        </div>
      ) : (
        <div className="h-2 rounded-full bg-white/8" />
      )}
      <div className="flex gap-4 text-xs text-white/40">
        <span className="text-emerald-400">{stats.wins}W</span>
        <span className="text-white/30">{stats.draws}D</span>
        <span className="text-red-400/70">{stats.losses}L</span>
      </div>
    </div>
  );
}

// ─── Game Row ──────────────────────────────────────────────────────────────
function GameRow({ game }: { game: Game }) {
  const resultColor = game.result === "win" ? "text-emerald-400" : game.result === "loss" ? "text-red-400/80" : "text-white/40";
  const resultLabel = game.result === "win" ? "Win" : game.result === "loss" ? "Loss" : "Draw";
  const eloColor    = game.eloChange === null ? "" : game.eloChange > 0 ? "text-emerald-400" : game.eloChange < 0 ? "text-red-400/80" : "text-white/40";
  const eloStr      = game.eloChange === null ? "—" : game.eloChange > 0 ? `+${game.eloChange}` : `${game.eloChange}`;

  return (
    <div className="flex items-center gap-3 py-3 px-4 rounded-xl border border-white/6 bg-white/[0.015] hover:bg-white/[0.03] transition-colors">
      <span className={`w-10 text-sm font-bold ${resultColor}`}>{resultLabel}</span>
      <span className={`text-xs px-2 py-0.5 rounded-md border font-medium ${MODE_COLOR[game.mode]}`}>
        {MODE_LABEL[game.mode]}
      </span>
      <Link href={`/profile/${game.opponent.username}`} className="flex-1 text-sm text-white/70 hover:text-white transition-colors truncate min-w-0">
        vs <span className="font-medium">{game.opponent.username}</span>
      </Link>
      <span className="text-xs text-white/30 flex-shrink-0">{game.endReason?.replace("_", " ") ?? ""}</span>
      <span className={`text-sm font-semibold w-12 text-right flex-shrink-0 ${eloColor}`}>{eloStr}</span>
      <span className="text-xs text-white/25 flex-shrink-0 w-16 text-right">{timeAgo(game.createdAt)}</span>
      <Link href={`/game/${game.id}/replay`} className="text-xs text-amber-400/60 hover:text-amber-400 transition-colors flex-shrink-0">
        Replay →
      </Link>
    </div>
  );
}

// ─── Tab: Overview ─────────────────────────────────────────────────────────
function OverviewTab({ profile, games, eloHistory }: { profile: Profile; games: Game[]; eloHistory: Props["eloHistory"] }) {
  const modes: GameMode[] = ["standard", "pauper", "royal"];
  return (
    <div className="space-y-8">
      {/* ELO cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {modes.map(mode => (
          <div key={mode} className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between mb-3">
              <span className={`text-xs font-semibold uppercase tracking-wider px-2 py-0.5 rounded-md border ${MODE_COLOR[mode]}`}>
                {MODE_LABEL[mode]}
              </span>
              <EloSparkline points={eloHistory[mode]} color={MODE_ELO_COLOR[mode]} />
            </div>
            <p className="text-2xl font-bold text-white">{profile.elo[mode]}</p>
            <p className="text-xs text-white/35 mt-0.5">{profile.stats[mode].played} games · {winRate(profile.stats[mode])}% WR</p>
          </div>
        ))}
      </div>

      {/* Tokens */}
      {profile.tokens.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-white/35 mb-3">Tokens</p>
          <div className="flex flex-wrap gap-2">
            {profile.tokens.map(t => <TokenBadge key={t.slug} token={t} size="sm" />)}
          </div>
        </div>
      )}

      {/* Recent games */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-white/35 mb-3">Recent games</p>
        {games.length === 0 ? (
          <p className="text-white/30 text-sm">No games played yet.</p>
        ) : (
          <div className="space-y-2">
            {games.slice(0, 5).map(g => <GameRow key={g.id} game={g} />)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tab: Games ────────────────────────────────────────────────────────────
function GamesTab({ games }: { games: Game[] }) {
  const [filter, setFilter] = useState<GameMode | "all">("all");
  const filtered = filter === "all" ? games : games.filter(g => g.mode === filter);
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["all", "standard", "pauper", "royal"] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              filter === f ? "border-amber-500/50 bg-amber-500/10 text-amber-400" : "border-white/8 text-white/40 hover:text-white/60"
            }`}>
            {f === "all" ? "All" : MODE_LABEL[f]}
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <p className="text-white/30 text-sm py-8 text-center">No games found.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map(g => <GameRow key={g.id} game={g} />)}
        </div>
      )}
    </div>
  );
}

// ─── Tab: Stats ────────────────────────────────────────────────────────────
function StatsTab({ profile, eloHistory }: { profile: Profile; eloHistory: Props["eloHistory"] }) {
  const [activeMode, setActiveMode] = useState<GameMode>("standard");
  const modes: GameMode[] = ["standard", "pauper", "royal"];
  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {modes.map(m => (
          <button key={m} onClick={() => setActiveMode(m)}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              activeMode === m ? "border-amber-500/50 bg-amber-500/10 text-amber-400" : "border-white/8 text-white/40 hover:text-white/60"
            }`}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "ELO",     value: profile.elo[activeMode] },
          { label: "Games",   value: profile.stats[activeMode].played },
          { label: "Win rate",value: `${winRate(profile.stats[activeMode])}%` },
          { label: "Wins",    value: profile.stats[activeMode].wins },
        ].map(s => (
          <div key={s.label} className="rounded-xl border border-white/8 bg-white/[0.02] p-4">
            <p className="text-xs text-white/35 uppercase tracking-wider mb-1">{s.label}</p>
            <p className="text-2xl font-bold text-white">{s.value}</p>
          </div>
        ))}
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-white/35 mb-3">
          {MODE_LABEL[activeMode]} ELO over time
        </p>
        <EloChart points={eloHistory[activeMode]} color={MODE_ELO_COLOR[activeMode]} mode={activeMode} />
      </div>

      <div className="space-y-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-white/35">All modes</p>
        {modes.map(m => <StatBar key={m} stats={profile.stats[m]} mode={m} />)}
      </div>
    </div>
  );
}

// ─── Tab: Friends ──────────────────────────────────────────────────────────
function FriendsTab({ profile }: { profile: Profile }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 text-center">
          <p className="text-2xl font-bold text-white">{profile.followerCount}</p>
          <p className="text-xs text-white/35 mt-1">Followers</p>
        </div>
        <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 text-center">
          <p className="text-2xl font-bold text-white">{profile.followingCount}</p>
          <p className="text-xs text-white/35 mt-1">Following</p>
        </div>
      </div>
      <p className="text-white/25 text-sm text-center py-8">
        Detailed friends list coming soon.
      </p>
    </div>
  );
}

// ─── Tab: Tokens ───────────────────────────────────────────────────────────
function TokensTab({ tokens }: { tokens: Token[] }) {
  if (tokens.length === 0) {
    return <p className="text-white/30 text-sm py-8 text-center">No tokens yet.</p>;
  }
  return (
    <div className="space-y-3">
      {tokens.map(t => <TokenBadge key={t.slug} token={t} size="lg" />)}
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────
type Tab = "overview" | "games" | "stats" | "friends" | "tokens";

export default function ProfileClient({ profile, games, eloHistory, isOwnProfile, isFollowing, friendStatus: initialFriendStatus, friendRequestId: initialRequestId, viewerId }: Props) {
  const [activeTab, setActiveTab]     = useState<Tab>("overview");
  const [following, setFollowing]         = useState(isFollowing);
  const [followLoading, setFollowLoading]   = useState(false);
  const [friendStatus, setFriendStatus]     = useState<FriendStatus>(initialFriendStatus);
  const [friendRequestId, setFriendRequestId] = useState<number | null>(initialRequestId);
  const [friendLoading, setFriendLoading]   = useState(false);

  const handleFriend = useCallback(async () => {
    if (!viewerId || friendLoading) return;
    setFriendLoading(true);
    try {
      if (friendStatus === "friends" || friendStatus === "pending_sent") {
        // Remove friend or cancel request
        if (friendRequestId) {
          const res = await apiFetch(`/api/friends/${friendRequestId}`, { method: "DELETE" });
          if (res.ok) { setFriendStatus("none"); setFriendRequestId(null); }
        }
      } else if (friendStatus === "pending_received") {
        // Accept incoming request
        if (friendRequestId) {
          const res = await apiFetch(`/api/friends/${friendRequestId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "accept" }),
          });
          if (res.ok) { setFriendStatus("friends"); }
        }
      } else {
        // Send request
        const res = await apiFetch("/api/friends/request", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetUserId: profile.id }),
        });
        if (res.ok) {
          const data = await res.json();
          setFriendStatus(data.status === "accepted" ? "friends" : "pending_sent");
          setFriendRequestId(data.requestId);
        }
      }
    } finally {
      setFriendLoading(false);
    }
  }, [viewerId, friendLoading, friendStatus, friendRequestId, profile.id]);

  const handleFollow = useCallback(async () => {
    if (!viewerId || followLoading) return;
    setFollowLoading(true);
    try {
      const res = await apiFetch(`/api/profile/${profile.username}/follow`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setFollowing(data.following);
      }
    } finally {
      setFollowLoading(false);
    }
  }, [viewerId, followLoading, profile.username]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "games",    label: "Games" },
    { key: "stats",    label: "Stats" },
    { key: "friends",  label: "Friends" },
    { key: "tokens",   label: "Tokens" },
  ];

  const joinedYear = new Date(profile.createdAt).getFullYear();

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-8 py-10">

      {/* Header */}
      <div className="flex items-start gap-5 mb-8">
        {/* Avatar */}
        <div className="w-16 h-16 rounded-2xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-2xl font-bold text-amber-400 flex-shrink-0">
          {profile.image
            ? <img src={profile.image} alt={profile.username} className="w-full h-full rounded-2xl object-cover" />
            : profile.username[0].toUpperCase()
          }
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-display text-2xl font-800 text-white">{profile.username}</h1>
            {/* Token badges in header */}
            <div className="flex gap-1.5">
              {profile.tokens.slice(0, 4).map(t => <TokenBadge key={t.slug} token={t} size="sm" />)}
            </div>
          </div>
          {profile.name && <p className="text-white/45 text-sm mt-0.5">{profile.name}</p>}
          <p className="text-white/25 text-xs mt-1">Member since {joinedYear} · {profile.followerCount} followers</p>
        </div>

        {/* Action buttons */}
        {!isOwnProfile && viewerId && (
          <div className="flex gap-2 flex-shrink-0">
            {/* Friend button */}
            <button onClick={handleFriend} disabled={friendLoading}
              className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-all ${
                friendStatus === "friends"
                  ? "border-white/15 text-white/50 hover:border-red-500/30 hover:text-red-400/70"
                  : friendStatus === "pending_sent"
                    ? "border-white/15 text-white/40"
                    : friendStatus === "pending_received"
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                      : "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
              }`}>
              {friendLoading ? "..." :
                friendStatus === "friends" ? "Friends" :
                friendStatus === "pending_sent" ? "Request Sent" :
                friendStatus === "pending_received" ? "Accept Friend" :
                "Add Friend"}
            </button>
            {/* Follow button */}
            <button onClick={handleFollow} disabled={followLoading}
              className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-all ${
                following
                  ? "border-white/15 text-white/50 hover:border-red-500/30 hover:text-red-400/70"
                  : "border-white/15 text-white/40 hover:border-white/25 hover:text-white/60"
              }`}>
              {followLoading ? "..." : following ? "Following" : "Follow"}
            </button>
          </div>
        )}

      </div>

      {/* Tab nav */}
      <div className="flex flex-wrap gap-1 border-b border-white/8 mb-8">
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === t.key
                ? "border-amber-400 text-amber-400"
                : "border-transparent text-white/40 hover:text-white/60"
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "overview" && <OverviewTab profile={profile} games={games} eloHistory={eloHistory} />}
      {activeTab === "games"    && <GamesTab games={games} />}
      {activeTab === "stats"    && <StatsTab profile={profile} eloHistory={eloHistory} />}
      {activeTab === "friends"  && <FriendsTab profile={profile} />}
      {activeTab === "tokens"   && <TokensTab tokens={profile.tokens} />}
    </div>
  );
}
