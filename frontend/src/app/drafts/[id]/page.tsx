// src/app/drafts/[id]/page.tsx
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";
import { redirect } from "next/navigation";
import ClientDraftEditor from "./ClientDraftEditor";

export default async function DraftEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  // Await params before accessing its properties
  const { id } = await params;
  
  const userId = parseInt(session.user.id);
  const draftId = parseInt(id);

  const draft = await prisma.draft.findFirst({
    where: {
      id: draftId,
      userId,  // security filter
    },
    select: {
      id: true,
      fen: true,
      points: true,
      name: true,
    },
  });

  if (!draft) {
    redirect("/drafts");
  }

  return (
    <ClientDraftEditor
      initialFen={draft.fen}
      initialPoints={draft.points}
      draftId={draft.id}
      initialName={draft.name ?? ""}
    />
  );
}
