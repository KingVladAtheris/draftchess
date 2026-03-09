// matchmaker/lib/logger.js
// Pino logger for the matchmaker process.
// CommonJS equivalent of src/app/lib/logger.ts.
//
// Usage:
//   const { logger } = require('./lib/logger');
//   const log = logger.child({ worker: 'timeout' });
//   log.info({ gameId }, 'timeout fired');

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(isDev
    ? {
        transport: {
          target:  'pino-pretty',
          options: { colorize: true, ignore: 'pid,hostname' },
        },
      }
    : {
        timestamp: pino.stdTimeFunctions.isoTime,
        redact: {
          paths: ['*.password', '*.passwordHash', '*.token', '*.secret'],
          censor: '[REDACTED]',
        },
      }
  ),
});

module.exports = { logger };
