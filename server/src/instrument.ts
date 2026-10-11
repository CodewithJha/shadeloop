// Preloaded with `node --import` so Sentry patches http/express before they are imported.
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN && !Sentry.getClient()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1,
    environment: process.env.NODE_ENV ?? 'development',
  });
}
