// matchmaker/index.js - Updated for new schema
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL not set!');
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({ adapter });

console.log('PrismaClient initialized with adapter');

async function runMatchmaker() {
  console.log('Matchmaker loop starting');

  while (true) {
    console.log(`[${new Date().toISOString()}] Checking queue...`);

    try {
      const count = await prisma.user.count({ where: { queueStatus: 'queued' } });
      console.log(`Queued count: ${count}`);

      const queuedPlayers = await prisma.user.findMany({
        where: { queueStatus: 'queued' },
        orderBy: { queuedAt: 'asc' },
        take: 2,
        select: { id: true, username: true, queuedDraftId: true },
      });

      console.log(`Found ${queuedPlayers.length} players`);

      if (queuedPlayers.length >= 2) {
        const [player1, player2] = queuedPlayers;

        console.log(`Pairing ${player1.id} vs ${player2.id}`);

        const game = await prisma.game.create({
          data: {
            player1Id: player1.id,
            player2Id: player2.id,
            status: 'starting',
            draft1Id: player1.queuedDraftId,
            draft2Id: player2.queuedDraftId,
            // Set both players as having this game current
            currentForUserId: player1.id, // You can only set one, or handle differently
          },
        });

        // Update both players
        await prisma.user.updateMany({
          where: { id: { in: [player1.id, player2.id] } },
          data: {
            queueStatus: 'in_game',
            queuedAt: null,
            queuedDraftId: null,
          },
        });

        console.log(`Game created: ${game.id}`);
      }
    } catch (err) {
      console.error('Matchmaker error:', err);
    }

    await new Promise(r => setTimeout(r, 5000));
  }
}

runMatchmaker().catch(err => {
  console.error('Fatal crash:', err);
  process.exit(1);
});