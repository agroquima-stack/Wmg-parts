import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { authenticate, HttpError } from './auth.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { productRoutes } from './routes/products.js';
import { adminRoutes } from './routes/admin.js';
import { searchRoutes } from './routes/search.js';
import { stockRoutes } from './routes/stock.js';
import { pricingRoutes } from './routes/pricing.js';
import { salesRoutes } from './routes/sales.js';
import { quoteRoutes } from './routes/quotes.js';
import { b2bRoutes } from './routes/b2b.js';
import { purchasingRoutes } from './routes/purchasing.js';
import { financeRoutes } from './routes/finance.js';
import { fiscalRoutes } from './routes/fiscal.js';
import { accountingRoutes } from './routes/accounting.js';
import { biRoutes } from './routes/bi.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { shareRoutes } from './routes/share.js';
import { returnsRoutes } from './routes/returns.js';
import { closingRoutes } from './routes/closing.js';

export async function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' && { level: 'info' }, trustProxy: true, bodyLimit: 1_000_000 });
  await app.register(helmet);
  await app.register(cors, { origin: config.corsOrigin, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  // Autenticação por Bearer token (sem cookies => sem superfície de CSRF).
  app.addHook('preHandler', async (req) => {
    const cfg = req.routeOptions.config as { public?: boolean };
    if (cfg?.public || req.url === '/health') return;
    req.auth = await authenticate(req);
    // senha provisória: só libera troca de senha, perfil e logout
    if (req.auth.mustChangePassword && !req.url.startsWith('/auth/'))
      throw new HttpError(403, 'Troque a senha provisória para continuar.', 'password_change_required');
  });

  app.get('/health', async () => ({ ok: true }));

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; constraint?: string }, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code, ...err.extra });
    if (err instanceof ZodError) {
      return reply.code(422).send({ error: 'Dados inválidos.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err.message?.startsWith('PERIODO_FECHADO:')) return reply.code(409).send({ error: `O período contábil ${err.message.split(':')[1]} está fechado: não aceita novos lançamentos. Peça a um gestor para reabri-lo ou use uma data/competência de período aberto.`, code: 'period_closed' });
    if (err.code === '23505') return reply.code(409).send({ error: 'Já existe um registro com este valor único.', constraint: err.constraint });
    if (err.code === '23503') return reply.code(409).send({ error: 'Registro relacionado inexistente ou em uso.' });
    if (err.code === '22P02') return reply.code(400).send({ error: 'Identificador inválido.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err); if (process.env.DEBUG_ERR) console.error('ERR>', err.message);
    return reply.code(500).send({ error: 'Erro interno.' });
  });

  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(productRoutes);
  await app.register(adminRoutes);
  await app.register(searchRoutes);
  await app.register(stockRoutes);
  await app.register(pricingRoutes);
  await app.register(salesRoutes);
  await app.register(quoteRoutes);
  await app.register(b2bRoutes);
  await app.register(purchasingRoutes);
  await app.register(financeRoutes);
  await app.register(fiscalRoutes);
  await app.register(accountingRoutes);
  await app.register(biRoutes);
  await app.register(intelligenceRoutes);
  await app.register(marketplaceRoutes);
  await app.register(shareRoutes);
  await app.register(returnsRoutes);
  await app.register(closingRoutes);
  return app;
}
