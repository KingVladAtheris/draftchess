// src/auth.ts
import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
// import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/app/lib/prisma.server";
import bcrypt from "bcrypt";
import type { DefaultSession } from "next-auth";

// Type augmentations (keep yours)
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
  }
}

export const authConfig = {
  // adapter: PrismaAdapter(prisma),  // ← this line enables DB sessions

  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email:    { label: "Email",    type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        try {
          const user = await prisma.user.findUnique({
            where: { email: credentials.email as string },
          });

          if (!user || !user.passwordHash) return null;

          const isValid = await bcrypt.compare(
            credentials.password as string,
            user.passwordHash
          );

          if (!isValid) return null;

          return {
            id:   user.id.toString(),
            email: user.email,
            name: user.username,
          };
        } catch (error) {
          console.error("Authorize error:", error);
          return null;
        }
      },
    }),
    // Add more providers later (Google, etc.) if wanted
  ],

  session: {
    strategy: "jwt",  
    // Optional: maxAge: 30 * 24 * 60 * 60, // 30 days
  },

  pages: {
    signIn: "/login",
  },

  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },

    async session({ session, token }) {  
      if (token?.id) {
        session.user.id = token.id as string;
      }
      return session;
    },
  },

  // Required for security
  secret: process.env.AUTH_SECRET,  // rename from NEXTAUTH_SECRET if needed
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);