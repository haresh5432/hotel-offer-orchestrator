import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Client } from '@temporalio/client';
import { WorkflowFailedError } from '@temporalio/client';
import type Redis from 'ioredis';
import { config } from '../config';
import { logger } from '../logger';
import { supplierRouter } from '../mock/suppliers';
import type { HotelWorkflowInput, SupplierName } from '../types';
import type { HotelWorkflowResult } from '../temporal/workflows';

const parsePrice = (v: unknown, label: string): number | undefined => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isFinite(n) || n < 0) throw new BadRequest(`${label} must be a non-negative number`);
  return n;
};

class BadRequest extends Error {}

const CITY_PATTERN = /^[\p{L}\p{N} .'-]{1,64}$/u;

/** `getTemporal` returns undefined until the Temporal connection is established. */
export function createApp(deps: { getTemporal: () => Client | undefined; redis: Redis }) {
  const app = express();

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => logger.info('http', { method: req.method, url: req.originalUrl, status: res.statusCode, ms: Date.now() - started }));
    next();
  });

  // Mock supplier endpoints (served by this same service).
  app.use(supplierRouter);

  app.get('/api/hotels', async (req, res) => {
    try {
      const city = typeof req.query.city === 'string' ? req.query.city.trim() : '';
      if (!city) throw new BadRequest('city query parameter is required');
      if (!CITY_PATTERN.test(city)) throw new BadRequest('city must be 1-64 letters, digits, spaces, dots, apostrophes or hyphens');
      const minPrice = parsePrice(req.query.minPrice, 'minPrice');
      const maxPrice = parsePrice(req.query.maxPrice, 'maxPrice');
      if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
        throw new BadRequest('minPrice must be <= maxPrice');
      }
      if (req.query.simulateDown !== undefined && !config.enableFailureInjection) {
        throw new BadRequest('simulateDown is disabled (set ENABLE_FAILURE_INJECTION=true)');
      }
      const simulateDown = String(req.query.simulateDown ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .flatMap((s): SupplierName[] => (s === 'A' ? ['Supplier A'] : s === 'B' ? ['Supplier B'] : []));

      const temporal = deps.getTemporal();
      if (!temporal) {
        res.status(503).json({ error: 'Temporal is not connected yet' });
        return;
      }
      const input: HotelWorkflowInput = { city, minPrice, maxPrice, simulateDown };
      const workflowId = `hotels-${city.toLowerCase()}-${randomUUID()}`;
      res.setHeader('X-Workflow-Id', workflowId);
      const result = (await temporal.workflow.execute('hotelOffersWorkflow', {
        taskQueue: config.taskQueue,
        workflowId,
        args: [input],
        workflowExecutionTimeout: config.workflowTimeoutMs,
      })) as HotelWorkflowResult;

      if (result.failedSuppliers.length) res.setHeader('X-Degraded-Suppliers', result.failedSuppliers.join(', '));
      res.json(result.offers);
    } catch (err) {
      if (err instanceof BadRequest) {
        res.status(400).json({ error: err.message });
        return;
      }
      const cause = err instanceof WorkflowFailedError ? err.cause : undefined;
      const type = (cause as { type?: string } | undefined)?.type;
      logger.error('Request failed', { error: String(err), type });
      if (type === 'AllSuppliersDown') res.status(502).json({ error: 'All suppliers are unavailable' });
      else res.status(500).json({ error: 'Internal error' });
    }
  });

  app.get('/health', async (_req, res) => {
    const probe = async (name: string, fn: () => Promise<unknown>) => {
      const t = Date.now();
      try {
        await Promise.race([
          fn(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), config.supplierTimeoutMs)),
        ]);
        return [name, { status: 'up', ms: Date.now() - t }] as const;
      } catch (e) {
        return [name, { status: 'down', error: String(e) }] as const;
      }
    };
    const supplierProbe = (path: string) => async () => {
      const r = await fetch(new URL(`${path}?city=delhi`, config.supplierBaseUrl), { signal: AbortSignal.timeout(config.supplierTimeoutMs) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    };
    const entries = await Promise.all([
      probe('supplierA', supplierProbe('/supplierA/hotels')),
      probe('supplierB', supplierProbe('/supplierB/hotels')),
      probe('redis', () => deps.redis.ping()),
      probe('temporal', async () => {
        const t = deps.getTemporal();
        if (!t) throw new Error('not connected');
        await t.connection.workflowService.getSystemInfo({});
      }),
    ]);
    const checks = Object.fromEntries(entries);
    const suppliersUp = checks.supplierA.status === 'up' && checks.supplierB.status === 'up';
    const allUp = entries.every(([, c]) => c.status === 'up');
    res.status(allUp ? 200 : 503).json({ status: allUp ? 'ok' : suppliersUp ? 'degraded' : 'unhealthy', checks });
  });

  return app;
}
