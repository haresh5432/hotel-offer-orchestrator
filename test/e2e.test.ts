import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { Client } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { createApp } from '../src/api/app';
import { config } from '../src/config';
import { createActivities } from '../src/temporal/activities';

/** End-to-end: real Express app + real Temporal (local test server) + real Redis. */
let env: TestWorkflowEnvironment;
let redisProc: ChildProcess;
let redis: Redis;
let worker: Worker;
let workerRun: Promise<void>;
let server: import('node:http').Server;
let base: string;

beforeAll(async () => {
  redisProc = spawn('redis-server', ['--port', '6390', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  redis = new Redis('redis://localhost:6390', { retryStrategy: (n) => (n > 50 ? null : 100) });
  await redis.ping();

  const cli = process.env.TEMPORAL_CLI_PATH;
  env = await TestWorkflowEnvironment.createLocal(cli ? { server: { executable: { type: 'existing-path', path: cli } } } : undefined);
  const client = new Client({ connection: env.connection });

  // Start API on a random port, point suppliers (mocked in the same app) at it.
  const app = createApp({ getTemporal: () => client, redis });
  await new Promise<void>((r) => (server = app.listen(0, r)));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  (config as any).supplierBaseUrl = base;
  (config as any).enableFailureInjection = true;

  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: config.taskQueue,
    workflowsPath: path.resolve(__dirname, '../src/temporal/workflows.ts'),
    activities: createActivities(redis),
  });
  workerRun = worker.run();
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await workerRun;
  await env?.teardown();
  server?.close();
  redis?.disconnect();
  redisProc?.kill();
});

const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, headers: r.headers, body: await r.json() };
};

describe('GET /api/hotels', () => {
  it('returns deduplicated cheapest offers for delhi', async () => {
    const { status, body } = await get('/api/hotels?city=delhi');
    expect(status).toBe(200);
    const names = body.map((h: any) => h.name);
    expect(new Set(names).size).toBe(names.length);
    expect(body.find((h: any) => h.name === 'Holtin')).toEqual({ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 });
    expect(body.find((h: any) => h.name === 'Radison')).toEqual({ name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 });
    expect(body.find((h: any) => h.name === 'Bloom Suites').supplier).toBe('Supplier A'); // only in A
    expect(body.find((h: any) => h.name === 'Metro Inn').supplier).toBe('Supplier B'); // only in B
  });

  it('stores the list in Redis and filters by price inside Redis', async () => {
    expect(await redis.zcard('hotels:delhi:prices')).toBe(6);
    const { body } = await get('/api/hotels?city=delhi&minPrice=3000&maxPrice=6000');
    expect(body.map((h: any) => h.name)).toEqual(['Bloom Suites', 'Holtin', 'Radison']);
    expect(body.every((h: any) => h.price >= 3000 && h.price <= 6000)).toBe(true);
  });

  it('supports only minPrice / only maxPrice and inclusive bounds', async () => {
    expect((await get('/api/hotels?city=delhi&minPrice=12500')).body.map((h: any) => h.name)).toEqual(['Taj Palace']);
    expect((await get('/api/hotels?city=delhi&maxPrice=2100')).body.map((h: any) => h.name)).toEqual(['Metro Inn']);
  });

  it('returns [] for a city with no results and for an empty price range', async () => {
    expect((await get('/api/hotels?city=atlantis')).body).toEqual([]);
    expect((await get('/api/hotels?city=delhi&minPrice=100000')).body).toEqual([]);
  });

  it('validates input', async () => {
    expect((await get('/api/hotels')).status).toBe(400);
    expect((await get('/api/hotels?city=delhi&minPrice=abc')).status).toBe(400);
    expect((await get('/api/hotels?city=delhi&minPrice=9&maxPrice=1')).status).toBe(400);
    expect((await get('/api/hotels?city=' + encodeURIComponent('a:b*c'))).status).toBe(400);
    expect((await get('/api/hotels?city=' + 'x'.repeat(65))).status).toBe(400);
  });

  it('exposes the workflow id for tracing', async () => {
    const r = await get('/api/hotels?city=delhi');
    expect(r.headers.get('x-workflow-id')).toMatch(/^hotels-delhi-/);
  });

  it('rejects simulateDown when failure injection is disabled', async () => {
    (config as any).enableFailureInjection = false;
    try {
      expect((await get('/api/hotels?city=delhi&simulateDown=B')).status).toBe(400);
    } finally {
      (config as any).enableFailureInjection = true;
    }
  });

  it('degrades gracefully when one supplier is down', async () => {
    const r = await get('/api/hotels?city=delhi&simulateDown=B');
    expect(r.status).toBe(200);
    expect(r.headers.get('x-degraded-suppliers')).toBe('Supplier B');
    expect(r.body.every((h: any) => h.supplier === 'Supplier A')).toBe(true);
  });

  it('returns 502 when both suppliers are down', async () => {
    const r = await get('/api/hotels?city=delhi&simulateDown=A,B');
    expect(r.status).toBe(502);
  });
});

describe('GET /health', () => {
  it('reports each supplier, redis and temporal', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body.checks.supplierA.status).toBe('up');
    expect(body.checks.supplierB.status).toBe('up');
    expect(body.checks.redis.status).toBe('up');
    expect(body.checks.temporal.status).toBe('up');
  });
});
