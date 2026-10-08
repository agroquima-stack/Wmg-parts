export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://erp:erp@localhost:5432/wmg_erp',
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(','),
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  maxFailedAttempts: 5,
  lockMinutes: 15,
};
