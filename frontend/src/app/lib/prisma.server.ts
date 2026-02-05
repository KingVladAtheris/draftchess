// src/lib/prisma.server.ts

import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

const connectionString = process.env.DATABASE_URL;

const globalForPrisma = global as unknown as {
  prismaServer?: PrismaClient;
};

let prisma: PrismaClient;

if (globalForPrisma.prismaServer) {
  prisma = globalForPrisma.prismaServer;
} else {
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);

  prisma = new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
  });

  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prismaServer = prisma;
  }
}

export { prisma };