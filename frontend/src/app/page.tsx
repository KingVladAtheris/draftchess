// src/app/page.tsx
import { auth } from "@/auth";  // your auth export from auth.ts
import Link from "next/link";

export default async function Home() {
  const session = await auth();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-8">
      <h1 className="text-5xl font-bold mb-12 text-center">Chess Draft Arena</h1>

      {session?.user ? (
        <div className="flex flex-col items-center gap-8">
          <p className="text-2xl">Welcome back, {session.user.name || session.user.email}</p>
          <div className="flex gap-6">
            <Link
              href="/drafts"
              className="px-10 py-5 bg-blue-600 text-white text-xl rounded-lg hover:bg-blue-700 transition"
            >
              Draft
            </Link>
            <Link
              href="/play/select"
              className="px-10 py-5 bg-green-600 text-white text-xl rounded-lg hover:bg-green-700 transition"
            >
              Play
            </Link>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-8">
          <p className="text-2xl mb-4">Sign in to start drafting and playing</p>
          <div className="flex gap-6">
            <Link href="/login" className="px-10 py-5 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
              Log In
            </Link>
            <Link href="/signup" className="px-10 py-5 bg-gray-600 text-white rounded-lg hover:bg-gray-700">
              Sign Up
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}