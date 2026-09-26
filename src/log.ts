import pino from 'pino';

// Secrets never reach the logs: passwords and tokens anywhere a caller might
// put them, and request URLs (camera URLs carry the session token).
const REDACT = [
  'password', 'token', 'authorization', 'url',
  '*.password', '*.token', '*.authorization', '*.url',
  'req.headers.authorization', 'req.url',
];

export function createLogger(level: string, dest?: pino.DestinationStream): pino.Logger {
  return pino({ level, redact: { paths: REDACT, censor: '[redacted]' } }, dest);
}
