import { NativeConnection, Worker } from '@temporalio/worker';
import { config } from '../config';
import { logger } from '../logger';
import { createRedis } from '../redis';
import { createActivities } from './activities';

async function run() {
  const redis = createRedis();
  const connection = await connectWithRetry();
  const worker = await Worker.create({
    connection,
    namespace: config.temporalNamespace,
    taskQueue: config.taskQueue,
    workflowsPath: require.resolve('./workflows'),
    activities: createActivities(redis),
  });
  logger.info('Temporal worker started', { taskQueue: config.taskQueue, address: config.temporalAddress });
  await worker.run();
}

async function connectWithRetry(attempts = 30) {
  for (let i = 1; ; i++) {
    try {
      return await NativeConnection.connect({ address: config.temporalAddress });
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn('Temporal not ready, retrying', { attempt: i, error: String(err) });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

run().catch((err) => {
  logger.error('Worker crashed', { error: String(err) });
  process.exit(1);
});
