// src/app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/auth";   

// Re-export the handlers
export const { GET, POST } = handlers;