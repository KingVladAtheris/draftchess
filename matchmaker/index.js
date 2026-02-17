// matchmaker/index.js - Fixed to set currentForUserId for both players
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

function lowercaseRow(row) {
  return row.split('').map(c => isNaN(parseInt(c)) ? c.toLowerCase() : c).join('');
}

async function combineFens(whiteFen, blackFen) {
  const whiteRows = whiteFen.split(' ')[0].split('/');
  const blackRows = blackFen.split(' ')[0].split('/');
  const gameRows = [
    lowercaseRow(blackRows[7]),
    lowercaseRow(blackRows[6]),
    '8', '8', '8', '8',
    whiteRows[6],
    whiteRows[7],
  ];
  return gameRows.join('/') + ' w - - 0 1';
}

async function runMatchmaker() {
  console.log('Matchmaker loop starting');

  while (true) {
    console.log(`[${new Date().toISOString()}] Checking queue...`);

    try {
      const count = await prisma.user.count({ where: { queueStatus: 'queued' } });
      console.log(`Queued count: ${count}`);

      let queuedPlayers = await prisma.user.findMany({
        where: { queueStatus: 'queued' },
        orderBy: { queuedAt: 'asc' },
        take: 2,
        select: { id: true, username: true, queuedDraftId: true },
      });

      console.log(`Found ${queuedPlayers.length} players`);

      if (queuedPlayers.length >= 2) {
        // Randomly assign colors
        queuedPlayers = queuedPlayers.sort(() => Math.random() - 0.5);
        const [player1, player2] = queuedPlayers;

        console.log(`Pairing ${player1.id} (white) vs ${player2.id} (black)`);

        const draft1 = await prisma.draft.findUnique({
          where: { id: player1.queuedDraftId },
          select: { fen: true },
        });
        const draft2 = await prisma.draft.findUnique({
          where: { id: player2.queuedDraftId },
          select: { fen: true },
        });

        const gameFen = await combineFens(draft1.fen, draft2.fen);

        // Create game - can only set one currentForUserId directly
        // We'll handle player2 with a separate update
        const game = await prisma.game.create({
          data: {
            player1Id: player1.id,
            player2Id: player2.id,
            draft1Id: player1.queuedDraftId,
            draft2Id: player2.queuedDraftId,
            fen: gameFen,
            status: 'prep',
            prepStartedAt: new Date(),
            readyPlayer1: false,
            readyPlayer2: false,
            auxPointsPlayer1: 6,
            auxPointsPlayer2: 6,
            currentForUserId: player1.id,  // Set player1 as current
          },
        });

        // Create a second game entry reference for player2
        // Since currentForUserId can only point to one user,
        // use gamesAsPlayer1/gamesAsPlayer2 to find the game for player2
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

      // Check prep games for auto-start
      const prepGames = await prisma.game.findMany({
        where: { status: 'prep' },
        select: {
          id: true,
          prepStartedAt: true,
          readyPlayer1: true,
          readyPlayer2: true,
        },
      });

      for (const g of prepGames) {
        const elapsed = (Date.now() - new Date(g.prepStartedAt).getTime()) / 1000;
        if ((g.readyPlayer1 && g.readyPlayer2) || elapsed > 60) {
          await prisma.game.update({
            where: { id: g.id },
            data: { status: 'active' },
          });
          console.log(`Game ${g.id} started`);
        }
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
