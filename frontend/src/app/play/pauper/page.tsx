// src/app/play/pauper/page.tsx — server component
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { redirect } from "next/navigation";
import SelectClient from "@/app/play/select/SelectClient";
import { MODE_CONFIG } from "@/app/lib/game-modes";

export default async function PlayPauperPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = parseInt(session.user.id);

  const cfg    = MODE_CONFIG["pauper"];
  const drafts = await prisma.draft.findMany({
    where:   { userId, mode: "pauper" },
    orderBy: { updatedAt: "desc" },
    select:  { id: true, name: true, points: true, updatedAt: true },
  });

  return <SelectClient drafts={drafts} mode="pauper" budget={cfg.draftBudget} />;
}
