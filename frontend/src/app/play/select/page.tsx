// src/app/play/select/page.tsx (final)
// src/app/drafts/page.tsx
// Drafts index — shows all user drafts, lets them create new ones.
// Server component: fetches drafts, passes to client for interactivity.

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/app/lib/prisma.server";
import SelectClient from "./SelectClient";

export default async function DraftsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userId = parseInt(session.user.id);

  const drafts = await prisma.draft.findMany({
    where:   { userId },
    orderBy: { updatedAt: "desc" },
    select:  { id: true, name: true, points: true, updatedAt: true, fen: true },
  });

  return <SelectClient drafts={drafts} />;
}
