// ─────────────────────────────────────────────────────────────────────────────
// EditFrame Backend — server.js
// Express app bootstrap: middleware, route mounting, WebSocket server init.
// ─────────────────────────────────────────────────────────────────────────────
import videoRoutes from './src/routes/video.routes.js';


import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';

// Config
import { connectDatabase, disconnectDatabase } from './src/config/db.js';
import { connectRedis, disconnectRedis } from './src/config/redis.js';
import { initCloudinary } from './src/config/cloudinary.js';
import { configureFfmpeg } from './src/config/ffmpeg.js';

// Middleware
import { errorHandler, notFoundHandler } from './src/middleware/error.middleware.js';
import { globalRateLimiter } from './src/middleware/rateLimit.middleware.js';

// Routes
import authRoutes     from './src/routes/auth.routes.js';
import userRoutes     from './src/routes/user.routes.js';
import projectRoutes  from './src/routes/project.routes.js';
import mediaRoutes    from './src/routes/media.routes.js';
import timelineRoutes from './src/routes/timeline.routes.js';
import exportRoutes   from './src/routes/export.routes.js';
import aiRoutes       from './src/routes/ai.routes.js';

// WebSocket server
import { initWsServer } from './src/websocket/ws.server.js';

// Workers run as separate processes via:
//   npm run workers:video
//   npm run workers:export
//   npm run workers:ai
// They are NOT imported here to keep the API server lightweight and avoid
// crashing on missing credentials (Redis, Cloudinary) during early development.

// ─── App factory ─────────────────────────────────────────────────────────────

const app = express();

// ── Security headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false, // handled by frontend
  })
);

// ── CORS
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173'];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Refresh-Token'],
    exposedHeaders: ['X-Total-Count', 'X-Page', 'X-Per-Page'],
  })
);

// ── Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ── HTTP request logger (skip in test)
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── Global rate limiter
app.use(globalRateLimiter);

// ── Health check (unauthenticated, before routes)
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV,
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────

app.use('/api/auth',      authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/projects',  projectRoutes);
app.use('/api/media',     mediaRoutes);
app.use('/api/timeline',  timelineRoutes);
app.use('/api/export',    exportRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/video', videoRoutes);



// ── 404 handler (must come after all routes)
app.use(notFoundHandler);

// ── Global error handler (must be last)
app.use(errorHandler);

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────

const httpServer = http.createServer(app);

// Attach native ws WebSocket server to the same HTTP server
initWsServer(httpServer);

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '4000', 10);

async function bootstrap() {
  try {
    // 1. Connect to PostgreSQL via Prisma
    await connectDatabase();
    console.log('[DB]    PostgreSQL connected');

    // 2. Connect to Redis
    await connectRedis();
    console.log('[Redis] Connected');

    // 3. Initialise Cloudinary SDK
    initCloudinary();
    console.log('[CDN]   Cloudinary initialised');

    // 4. Configure fluent-ffmpeg paths
    configureFfmpeg();
    console.log('[FFmpeg] Configured');

    // 5. Start listening
    httpServer.listen(PORT, () => {
      console.log(`[Server] EditFrame backend running on http://localhost:${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV}`);
      console.log(`[WS]    WebSocket server attached at ws://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('[Bootstrap] Fatal startup error:', err);
    process.exit(1);
  }
}

bootstrap();

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
  console.log(`\n[Server] Received ${signal} — shutting down gracefully…`);
  httpServer.close(async () => {
    try {
      await disconnectDatabase();
      await disconnectRedis();
      console.log('[Server] Clean shutdown complete');
      process.exit(0);
    } catch (err) {
      console.error('[Server] Error during shutdown:', err);
      process.exit(1);
    }
  });

  // Force-exit after 15 seconds if connections haven't drained
  setTimeout(() => {
    console.error('[Server] Forcing exit after timeout');
    process.exit(1);
  }, 15_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection:', reason);
  process.exit(1);
});

export default app;