import { env } from './config.ts';
import { log } from './log.ts';
import { closeDb, connectDb } from './db.ts';
import { createApp } from './app.ts';

await connectDb();
const server = createApp().listen(env.PORT, () => log.info({ port: env.PORT, env: env.NODE_ENV, ai: env.AI_PROVIDER }, 'ShadeLoop listening'));

function shutdown(signal: string) {
  log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
