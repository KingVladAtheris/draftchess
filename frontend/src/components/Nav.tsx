// src/components/Nav.tsx
// Top navigation bar for Draft Chess.
//
// Uses useSession() from next-auth/react so the nav updates reactively
// when the user signs in or out — no server re-render required.

"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";

// ─── Icons ──────────────────────────────────────────────────────────────────
const ChevronDown = ({ className }: { className?: string }) => (
  <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none">
    <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SoonPill = () => (
  <span className="ml-auto text-[9px] font-bold tracking-widest uppercase px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/20">
    Soon
  </span>
);

// ─── Types ───────────────────────────────────────────────────────────────────
type DropdownItem =
  | { type: "link";   label: string; href: string;        soon?: boolean; danger?: boolean }
  | { type: "button"; label: string; onClick: () => void; soon?: boolean; danger?: boolean }
  | { type: "divider" };

// ─── Shared dropdown panel ───────────────────────────────────────────────────
function DropdownPanel({ items, isOpen, align = "left" }: {
  items: DropdownItem[];
  isOpen: boolean;
  align?: "left" | "right";
}) {
  return (
    <div className={`
      absolute top-[calc(100%+8px)] min-w-[190px] z-50
      bg-[#1a1d2e] border border-white/10 rounded-xl shadow-2xl shadow-black/60
      overflow-hidden transition-all duration-150
      ${align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left"}
      ${isOpen ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"}
    `}>
      {items.map((item, i) => {
        if (item.type === "divider") return <div key={i} className="h-px bg-white/8 my-1" />;

        const cls = `flex items-center gap-2 w-full px-4 py-2.5 text-sm text-left transition-colors duration-100
          ${item.soon
            ? "text-white/30 cursor-not-allowed"
            : item.danger
              ? "text-red-400 hover:bg-red-500/10 hover:text-red-300 cursor-pointer"
              : "text-white/75 hover:bg-white/6 hover:text-white cursor-pointer"
          }`;

        if (item.type === "link") {
          return item.soon
            ? <div key={i} className={cls}><span>{item.label}</span><SoonPill /></div>
            : <Link key={i} href={item.href} className={cls}>{item.label}</Link>;
        }

        return (
          <button key={i} onClick={item.soon ? undefined : item.onClick} disabled={!!item.soon} className={cls}>
            <span>{item.label}</span>
            {item.soon && <SoonPill />}
          </button>
        );
      })}
    </div>
  );
}

// ─── Generic nav dropdown trigger ────────────────────────────────────────────
function NavDropdown({ label, items }: { label: string; items: DropdownItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150
          ${open ? "text-white bg-white/8" : "text-white/60 hover:text-white hover:bg-white/6"}`}
      >
        {label}
        <ChevronDown className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      <DropdownPanel items={items} isOpen={open} />
    </div>
  );
}

// ─── User dropdown ────────────────────────────────────────────────────────────
function UserDropdown() {
  const { data: session } = useSession();
  const [open, setOpen]   = useState(false);
  const ref               = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!session?.user) return null;

  const user    = session.user;
  const initial = (user.name ?? user.email ?? "?")[0].toUpperCase();
  const userId  = (user as any).id;

  const items: DropdownItem[] = [
    { type: "link",   label: "Profile",  href: `/profile/${userId ?? "me"}`, soon: true },
    { type: "link",   label: "Settings", href: "/settings",                  soon: true },
    { type: "divider" },
    { type: "button", label: "Sign out", onClick: () => signOut({ callbackUrl: "/" }), danger: true },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2.5 pl-2 pr-3 py-1.5 rounded-lg transition-colors duration-150 group
          ${open ? "bg-white/8" : "hover:bg-white/6"}`}
      >
        <div className="w-7 h-7 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 text-xs font-bold flex-shrink-0">
          {initial}
        </div>
        <span className={`text-sm font-medium max-w-[120px] truncate transition-colors
          ${open ? "text-white" : "text-white/70 group-hover:text-white"}`}>
          {user.name ?? user.email}
        </span>
        <ChevronDown className={`text-white/40 flex-shrink-0 transition-transform duration-200
          ${open ? "rotate-180 text-white/60" : ""}`} />
      </button>

      <div className={`
        absolute top-[calc(100%+8px)] right-0 min-w-[210px] z-50
        bg-[#1a1d2e] border border-white/10 rounded-xl shadow-2xl shadow-black/60
        overflow-hidden transition-all duration-150 origin-top-right
        ${open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"}
      `}>
        {/* Identity header */}
        <div className="px-4 py-3 border-b border-white/8">
          <p className="text-sm font-semibold text-white truncate">{user.name}</p>
          {user.email && <p className="text-xs text-white/40 truncate mt-0.5">{user.email}</p>}
        </div>

        {items.map((item, i) => {
          if (item.type === "divider") return <div key={i} className="h-px bg-white/8 my-1" />;

          const cls = `flex items-center gap-2 w-full px-4 py-2.5 text-sm text-left transition-colors duration-100
            ${item.soon
              ? "text-white/30 cursor-not-allowed"
              : item.danger
                ? "text-red-400 hover:bg-red-500/10 hover:text-red-300 cursor-pointer"
                : "text-white/75 hover:bg-white/6 hover:text-white cursor-pointer"
            }`;

          if (item.type === "link") {
            return item.soon
              ? <div key={i} className={cls}><span>{item.label}</span><SoonPill /></div>
              : <Link key={i} href={item.href} className={cls}>{item.label}</Link>;
          }

          return <button key={i} onClick={item.onClick} className={cls}>{item.label}</button>;
        })}
      </div>
    </div>
  );
}

// ─── Nav ─────────────────────────────────────────────────────────────────────
export default function Nav() {
  const { status } = useSession();
  const isLoggedIn = status === "authenticated";

  const playItems: DropdownItem[] = [
    { type: "link", label: "Standard", href: "/play/select" },
    { type: "link", label: "Pauper",   href: "/play/select?mode=pauper", soon: true },
    { type: "link", label: "Royal",    href: "/play/select?mode=royal",  soon: true },
  ];

  const draftItems: DropdownItem[] = [
    { type: "link", label: "Standard drafts", href: "/drafts" },
    { type: "link", label: "Pauper drafts",   href: "/drafts?mode=pauper", soon: true },
    { type: "link", label: "Royal drafts",    href: "/drafts?mode=royal",  soon: true },
  ];

  return (
    <nav className="sticky top-0 z-40 w-full h-14 bg-[#0f1117]/95 backdrop-blur-md border-b border-white/8">
      <div className="max-w-7xl mx-auto h-full px-4 flex items-center gap-1">

        {/* Logo */}
        <Link href="/" className="mr-4 flex items-center gap-2 flex-shrink-0 group">
          <div className="w-7 h-7 grid grid-cols-2 grid-rows-2 gap-0.5 opacity-90 group-hover:opacity-100 transition-opacity">
            <div className="rounded-sm bg-amber-400" />
            <div className="rounded-sm bg-amber-400/30" />
            <div className="rounded-sm bg-amber-400/30" />
            <div className="rounded-sm bg-amber-400" />
          </div>
          <span className="text-base font-bold tracking-tight text-white">
            Draft<span className="text-amber-400">Chess</span>
          </span>
        </Link>

        {/* Left items */}
        {isLoggedIn && (
          <>
            <NavDropdown label="Play"   items={playItems}  />
            <NavDropdown label="Drafts" items={draftItems} />
            <div className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white/25 cursor-not-allowed select-none">
              Tournaments <SoonPill />
            </div>
          </>
        )}

        <div className="flex-1" />

        {/* Right items */}
        {isLoggedIn ? (
          <>
            <div className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white/25 cursor-not-allowed select-none mr-1">
              Leaderboard <SoonPill />
            </div>
            <UserDropdown />
          </>
        ) : status === "unauthenticated" ? (
          <div className="flex items-center gap-2">
            <Link href="/login" className="px-4 py-2 text-sm font-medium text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/6">
              Sign in
            </Link>
            <Link href="/signup" className="px-4 py-2 text-sm font-semibold text-[#0f1117] bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors">
              Sign up
            </Link>
          </div>
        ) : (
          // status === "loading" — skeleton to prevent layout shift
          <div className="w-32 h-8 rounded-lg bg-white/5 animate-pulse" />
        )}

      </div>
    </nav>
  );
}
