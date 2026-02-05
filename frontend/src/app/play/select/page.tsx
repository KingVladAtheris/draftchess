// src/app/play/select/page.tsx (final)
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { redirect } from "next/navigation";
import SelectClient from "./SelectClient";

export default async function PlaySelectPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const userId = parseInt(session.user.id);

  const drafts = await prisma.draft.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      points: true,
      updatedAt: true,
    },
  });

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <h1 className="text-4xl font-bold mb-8 text-center">Select Draft to Play</h1>

      <div className="max-w-4xl mx-auto">
        <SelectClient drafts={drafts} />
      </div>
    </div>
  );
}