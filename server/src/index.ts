import { env } from './config.ts';
import { log } from './log.ts';
import { closeDb, connectDb } from './db.ts';
import { createApp } from './app.ts';

try {
  await connectDb();
} catch (e) {
  // The driver's message names hosts, never credentials.
  log.fatal({ error: (e as Error).message }, 'startup failed: could not connect to MongoDB or create indexes');
  process.exit(1);
}
const server = createApp().listen(env.PORT, () => log.info({ port: env.PORT, env: env.NODE_ENV, ai: env.AI_PROVIDER }, 'ShadeLoop listening'));

function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await closeDb();
    log.info('shutdown complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
