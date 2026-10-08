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
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      return reply.code(422).send({ error: 'Dados inválidos.', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err.code === '23505') return reply.code(409).send({ error: 'Já existe um registro com este valor único.', constraint: err.constraint });
    if (err.code === '23503') return reply.code(409).send({ error: 'Registro relacionado inexistente ou em uso.' });
    if (err.code === '22P02') return reply.code(400).send({ error: 'Identificador inválido.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Erro interno.' });
  });

  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(productRoutes);
  await app.register(adminRoutes);
  await app.register(searchRoutes);
  return app;
}
