// src/app/api/notifications/route.ts
// GET — returns pending friend requests for the current user.
// Shaped as a generic notifications array so other types can be added later.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/app/lib/prisma.server";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ notifications: [] });
  }

  const userId = parseInt(session.user.id);

  const pendingRequests = await prisma.friendRequest.findMany({
    where:   { receiverId: userId, status: "pending" },
    orderBy: { createdAt: "desc" },
    select: {
      id:        true,
      createdAt: true,
      sender: { select: { id: true, username: true, image: true } },
    },
  });

  const notifications = pendingRequests.map(r => ({
    id:        `friend-${r.id}`,
    type:      "friend_request" as const,
    requestId: r.id,
    sender:    r.sender,
    createdAt: r.createdAt.toISOString(),
  }));

  return NextResponse.json({ notifications });
}
