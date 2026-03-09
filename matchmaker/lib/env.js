// matchmaker/lib/env.js
// Validates required environment variables at matchmaker startup.
// Required by matchmaker/index.js before anything else runs.

const REQUIRED = {
  DATABASE_URL: 'PostgreSQL connection string',
  REDIS_URL:    'Redis connection string',
};

const missing = Object.keys(REQUIRED).filter(k => !process.env[k]);

if (missing.length > 0) {
  console.error('\n[env] ✖ Missing required environment variables:\n');
  for (const key of missing) {
    console.error(`  ${key.padEnd(16)} — ${REQUIRED[key]}`);
  }
  console.error('\nFix these before starting the matchmaker.\n');
  process.exit(1);
}
