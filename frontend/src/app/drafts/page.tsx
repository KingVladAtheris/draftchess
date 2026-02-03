// src/app/drafts/page.tsx
import { auth } from "@/auth";
import prisma from "@/app/lib/prisma";
import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

// Define the shape of each draft item (now includes name)
type DraftOverviewItem = {
  id: number;
  name: string | null;     // ← added
  fen: string;
  points: number;
  updatedAt: Date;
  createdAt: Date;
};

async function createNewDraft() {
  "use server";

  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const userId = parseInt(session.user.id);

  const newDraft = await prisma.draft.create({
    data: {
      userId,
      fen: "8/8/8/8/8/8/8/4K3 w - - 0 1",
      points: 0,
      // name: null,  // optional – user sets it later
    },
  });

  revalidatePath("/drafts");
  redirect(`/drafts/${newDraft.id}`);
}

export default async function DraftsOverview() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const userId = parseInt(session.user.id);

  const drafts: DraftOverviewItem[] = await prisma.draft.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,          // ← added this
      fen: true,
      points: true,
      updatedAt: true,
      createdAt: true,
    },
  });

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <h1 className="text-4xl font-bold mb-8">My Drafts</h1>

      <div className="mb-10">
        <form action={createNewDraft}>
          <button
            type="submit"
            className="px-6 py-3 bg-green-600 text-white rounded hover:bg-green-700"
          >
            + New Draft
          </button>
        </form>
      </div>

      {drafts.length === 0 ? (
        <p className="text-gray-600">You don't have any saved drafts yet. Create one!</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {drafts.map((draft) => (
            <div key={draft.id} className="bg-white p-6 rounded-lg shadow">
              {/* Use name if available, fallback to ID */}
              <p className="font-semibold mb-2 text-lg">
                {draft.name || `Draft #${draft.id}`}
              </p>

              <p className="text-sm text-gray-600 mb-4">
                Last updated: {new Date(draft.updatedAt).toLocaleDateString()}
              </p>

              <p className="mb-4">Points used: {draft.points}</p>

              <div className="flex gap-4">
                <Link
                  href={`/drafts/${draft.id}`}
                  className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                >
                  Edit
                </Link>

                <form
                  action={async () => {
                    "use server";
                    await prisma.draft.delete({
                      where: { id: draft.id },
                    });
                    revalidatePath("/drafts");
                  }}
                >
                  <button
                    type="submit"
                    className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
                  >
                    Delete
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}