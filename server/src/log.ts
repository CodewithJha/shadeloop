import pino from 'pino';
import { env } from './config.ts';

/** Paths that may carry secrets or personal data. Never log them. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  'text',
  '*.text',
  'transcript',
  '*.transcript',
  'prompt',
  '*.prompt',
  'feedback',
  '*.feedback',
  'lat',
  'lon',
  '*.lat',
  '*.lon',
  'coords',
  '*.coords',
  'coarseLocation',
  '*.coarseLocation',
];

export function createLogger(destination?: pino.DestinationStream) {
  return pino(
    {
      level: env.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      base: { service: 'shadeloop' },
    },
    destination,
  );
}

export const log = createLogger();
