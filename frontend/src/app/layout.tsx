// src/app/layout.tsx

import type { Metadata } from "next";
import { Outfit, DM_Sans } from "next/font/google";
import "./globals.css";
import Nav from "@/components/Nav";
import SessionProvider from "@/components/SessionProvider";
import { auth } from "@/auth";

const outfit = Outfit({
  subsets:  ["latin"],
  variable: "--font-display",
  display:  "swap",
  weight:   ["400", "500", "600", "700", "800"],
});

const dmSans = DM_Sans({
  subsets:  ["latin"],
  variable: "--font-body",
  display:  "swap",
  weight:   ["300", "400", "500", "600"],
});

export const metadata: Metadata = {
  title:       "DraftChess",
  description: "Build your army. Outwit your opponent.",
  icons: { icon: "/favicon.ico" },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Fetch session on the server once and pass it to SessionProvider.
  // Client components (Nav, etc.) then read from the context via useSession()
  // which updates reactively — no server re-render needed on sign in/out.
  const session = await auth();

  return (
    <html lang="en" className={`${outfit.variable} ${dmSans.variable}`}>
      <body className="min-h-screen bg-[#0f1117] text-white antialiased">
        <SessionProvider session={session}>
          <Nav />
          <main>{children}</main>
        </SessionProvider>
      </body>
    </html>
  );
}
