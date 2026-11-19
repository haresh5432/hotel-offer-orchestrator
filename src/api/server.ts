import { Client, Connection } from '@temporalio/client';
import { config } from '../config';
import { logger } from '../logger';
import { createRedis } from '../redis';
import { createApp } from './app';

async function main() {
  const redis = createRedis();
  let temporal: Client | undefined;
  let connection: Connection | undefined;

  // Listen immediately so /health can report what is (not) ready instead of dropping connections.
  const app = createApp({ getTemporal: () => temporal, redis });
  const server = app.listen(config.port, () => logger.info('API listening', { port: config.port }));

  connectWithRetry()
    .then((c) => {
      connection = c;
      temporal = new Client({ connection: c, namespace: config.temporalNamespace });
      logger.info('Connected to Temporal', { address: config.temporalAddress });
    })
    .catch((err) => {
      logger.error('Could not connect to Temporal, exiting', { error: String(err) });
      process.exit(1);
    });

  const shutdown = (signal: string) => {
    logger.info('Shutting down', { signal });
    server.close(async () => {
      await connection?.close().catch(() => undefined);
      redis.disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function connectWithRetry(attempts = 60): Promise<Connection> {
  for (let i = 1; ; i++) {
    try {
      return await Connection.connect({ address: config.temporalAddress, connectTimeout: '5s' });
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn('Temporal not ready, retrying', { attempt: i, error: String(err) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

main().catch((err) => {
  logger.error('API failed to start', { error: String(err) });
  process.exit(1);
});
