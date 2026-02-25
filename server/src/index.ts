import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { env } from './config/env';
import { verifyToken } from './config/jwt';
import { getRedis, closeRedis } from './config/redis';
import authRoutes from './routes/auth';
import iceRoutes from './routes/ice';
import { MatchmakingService } from './services/matchmaking';
import { StateManager } from './services/stateManager';
import { RedisStateManager } from './services/redisStateManager';
import type { IStateManager } from './services/stateManager';
import { ClientMessage, ServerMessage } from './types';
import { logger } from './utils/logger';
import { checkWsRateLimit } from './middleware/wsRateLimit';
import { validateClientMessage } from './validation/wsMessages';

// ═══════════════════════════════════════════════════════════════
// 🏗️ APP SETUP
// ═══════════════════════════════════════════════════════════════

const app = express();

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());

// CORS
const corsOptions = {
  origin: env.corsOrigin ? env.corsOrigin.split(',').map((o) => o.trim()) : '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.use(express.json());

// Rate limiting
app.use(
  rateLimit({
    windowMs: env.rateLimitWindowMs,
    max: env.rateLimitMax,
    message: { error: 'Too many requests' },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Static files
const buildPath = path.join(__dirname, '../../build');
app.use(express.static(buildPath));

// Health check
app.get('/health', async (_req, res) => {
  const redis = await getRedis();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    platform: 'unitalks',
    redis: redis ? 'connected' : 'disabled',
    uptime: process.uptime(),
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/ice', iceRoutes);

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(buildPath, 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
// 🚀 HTTP(S) SERVER
// ═══════════════════════════════════════════════════════════════

let httpServer: import('http').Server | import('https').Server;

if (env.httpsEnabled && env.sslCertPath && env.sslKeyPath) {
  try {
    const cert = fs.readFileSync(env.sslCertPath);
    const key = fs.readFileSync(env.sslKeyPath);
    httpServer = https.createServer({ cert, key }, app);
    logger.info('HTTPS enabled');
  } catch (err) {
    logger.error('HTTPS failed, falling back to HTTP:', err);
    httpServer = createServer(app);
  }
} else {
  httpServer = createServer(app);
}

// ═══════════════════════════════════════════════════════════════
// 🔌 WEBSOCKET - verifyClient
// ═══════════════════════════════════════════════════════════════

function verifyClient(
  info: { req: import('http').IncomingMessage },
  callback: (verified: boolean, code?: number) => void
) {
  try {
    const pathname = (info.req.url || '').split('?')[0];
    if (pathname !== '/ws' && pathname !== '/ws/') {
      logger.warn('WS reject: wrong path %s', pathname);
      return callback(false, 404);
    }

    const url = new URL(info.req.url || '', `http://${info.req.headers.host}`);
    const token = url.searchParams.get('token') || info.req.headers.authorization?.replace('Bearer ', '') || '';
    if (!token) {
      logger.warn('WS reject: no token');
      return callback(false, 401);
    }

    const payload = verifyToken(token);
    const userId = payload.userId;

    const rateLimitResult = checkWsRateLimit(userId);
    if (!rateLimitResult.allowed) {
      logger.warn('WS reject: rate limited %s', userId);
      return callback(false, 429);
    }

    callback(true);
  } catch (err) {
    logger.warn('WS reject: invalid token - %s', err instanceof Error ? err.message : String(err));
    callback(false, 401);
  }
}

const wss = new WebSocketServer({ server: httpServer, verifyClient });

// ═══════════════════════════════════════════════════════════════
// 🏗️ STATE INIT (async)
// ═══════════════════════════════════════════════════════════════

let stateManager: IStateManager;
let matchmaking: MatchmakingService;

async function initState() {
  const redis = await getRedis();
  if (redis && env.useRedis) {
    stateManager = new RedisStateManager(redis);
    logger.info('Using Redis state manager');
  } else {
    stateManager = new StateManager();
    logger.info('Using in-memory state manager');
  }
  matchmaking = new MatchmakingService(stateManager);
}

const HEARTBEAT_INTERVAL = 15000;
const MAINTENANCE_INTERVAL = 30000;

// ═══════════════════════════════════════════════════════════════
// 📡 MESSAGING
// ═══════════════════════════════════════════════════════════════

function send(userId: string, message: ServerMessage): boolean {
  const ws = stateManager.getWs(userId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    logger.error(`Failed to send to ${userId}:`, error);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 🎯 MATCHMAKING
// ═══════════════════════════════════════════════════════════════

async function attemptMatch(): Promise<void> {
  let videoMatched = true;
  while (videoMatched) {
    const sessionId = await matchmaking.findMatch('video');
    if (sessionId) {
      const session = await stateManager.getSession(sessionId);
      if (session) handleMatchSuccess(session.userA, session.userB, sessionId, 'video');
    } else {
      videoMatched = false;
    }
  }

  let audioMatched = true;
  while (audioMatched) {
    const sessionId = await matchmaking.findMatch('audio');
    if (sessionId) {
      const session = await stateManager.getSession(sessionId);
      if (session) handleMatchSuccess(session.userA, session.userB, sessionId, 'audio');
    } else {
      audioMatched = false;
    }
  }

  let textMatched = true;
  while (textMatched) {
    const sessionId = await matchmaking.findMatch('text');
    if (sessionId) {
      const session = await stateManager.getSession(sessionId);
      if (session) handleMatchSuccess(session.userA, session.userB, sessionId, 'text');
    } else {
      textMatched = false;
    }
  }
}

function handleMatchSuccess(userA: string, userB: string, sessionId: string, mode: 'video' | 'audio' | 'text'): void {
  const userARecord = stateManager.getUser(userA);
  const userBRecord = stateManager.getUser(userB);

  if (!userARecord || !userBRecord) {
    stateManager.endSession(sessionId);
    return;
  }

  const initiator = (userARecord.enqueuedAt || 0) <= (userBRecord.enqueuedAt || 0) ? userA : userB;

  const sentA = send(userA, { type: 'matched', partnerId: userB, initiator: initiator === userA, sessionId });
  const sentB = send(userB, { type: 'matched', partnerId: userA, initiator: initiator === userB, sessionId });

  if (!sentA || !sentB) {
    logger.warn(`❌ Match notification failed for session ${sessionId} - rolling back`);
    stateManager.endSession(sessionId);
    if (sentA) {
      matchmaking.enqueueUser(userA);
      send(userA, { type: 'error', message: 'Partner connection failed, searching again...' });
    }
    if (sentB) {
      matchmaking.enqueueUser(userB);
      send(userB, { type: 'error', message: 'Partner connection failed, searching again...' });
    }
    return;
  }

  logger.info(`🎯 ${mode} Match sent: ${userA} <-> ${userB} (session: ${sessionId})`);
}

// ═══════════════════════════════════════════════════════════════
// 🧹 DISCONNECT
// ═══════════════════════════════════════════════════════════════

async function handleUserDisconnect(userId: string): Promise<void> {
  const user = stateManager.getUser(userId);
  if (!user) return;

  const partner = await stateManager.getSessionPartner(userId);
  if (partner) {
    send(partner, { type: 'partner-left' });
    if (user.sessionId) {
      await stateManager.endSession(user.sessionId, userId);
    }
    const partnerUser = stateManager.getUser(partner);
    if (partnerUser) {
      const enqueueResult = await matchmaking.enqueueUser(partner);
      if (enqueueResult.success) {
        send(partner, { type: 'queue', position: enqueueResult.queuePosition || 1 });
        logger.info(`🔄 Partner ${partner} requeued at END after disconnect`);
        await attemptMatch();
      }
    }
  }

  await stateManager.removeUser(userId);
  logger.info(`👋 User disconnected: ${userId}`);
}

// ═══════════════════════════════════════════════════════════════
// 🔌 WEBSOCKET CONNECTION HANDLING
// ═══════════════════════════════════════════════════════════════

wss.on('connection', (ws, request) => {
  let userId: string;

  (async () => {
    try {
      const url = new URL(request.url || '', `http://${request.headers.host}`);
      const token = url.searchParams.get('token') || request.headers.authorization?.replace('Bearer ', '') || '';
      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }

      const payload = verifyToken(token);
      userId = payload.userId;

      await stateManager.addUser(userId, ws);
      send(userId, { type: 'ready', userId });

      logger.info(`🔌 User connected: ${userId}`);

      ws.on('message', async (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          send(userId, { type: 'error', message: 'Invalid message format' });
          return;
        }

        const validation = validateClientMessage(parsed);
        if (!validation.valid) {
          send(userId, { type: 'error', message: validation.error || 'Invalid message' });
          return;
        }

        const message = (validation.message || parsed) as ClientMessage;
        await stateManager.updateLastPong(userId);

        switch (message.type) {
          case 'join': {
            const mode = message.mode || 'video';
            await stateManager.setMode(userId, mode);
            const result = await matchmaking.enqueueUser(userId);
            if (!result.success) {
              send(userId, { type: 'error', message: result.reason || 'Cannot join queue' });
              break;
            }
            send(userId, { type: 'queue', position: result.queuePosition || 1 });
            logger.info(`📥 ${userId} joined ${mode} queue (position: ${result.queuePosition})`);
            await attemptMatch();
            break;
          }

          case 'cancel': {
            const success = await matchmaking.cancelSearch(userId);
            if (success) {
              send(userId, { type: 'search-cancelled' });
              logger.info(`🚫 ${userId} cancelled search`);
            }
            break;
          }

          case 'acknowledge': {
            const sessionReady = await stateManager.acknowledgeSession(userId);
            if (sessionReady) {
              const partner = await stateManager.getSessionPartner(userId);
              if (partner) {
                send(userId, { type: 'session-ready' });
                send(partner, { type: 'session-ready' });
                logger.info(`✅ Session ready: ${userId} <-> ${partner}`);
              }
            }
            break;
          }

          case 'signal': {
            const session = await stateManager.getUserSession(userId);
            if (!session) {
              send(userId, { type: 'error', message: 'No active session for signaling' });
              break;
            }
            if (session.state !== 'pending' && session.state !== 'active') {
              send(userId, { type: 'error', message: 'Session not ready for signaling' });
              break;
            }
            const partner = await stateManager.getSessionPartner(userId);
            if (!partner) {
              send(userId, { type: 'error', message: 'Partner not found' });
              break;
            }
            send(partner, {
              type: 'signal',
              from: userId,
              signalType: message.signalType,
              data: message.data,
            });
            break;
          }

          case 'skip': {
            const skipResult = await stateManager.handleSkip(userId);
            if (!skipResult.success) {
              send(userId, { type: 'error', message: skipResult.reason || 'Cannot skip' });
              break;
            }
            if (skipResult.partner) {
              send(skipResult.partner, { type: 'partner-skipped' });
              const partnerEnqueue = await matchmaking.enqueueUser(skipResult.partner);
              if (partnerEnqueue.success) {
                send(skipResult.partner, { type: 'queue', position: partnerEnqueue.queuePosition || 1 });
              }
            }
            const userEnqueue = await matchmaking.enqueueUser(userId);
            if (userEnqueue.success) {
              send(userId, { type: 'queue', position: userEnqueue.queuePosition || 1 });
            }
            logger.info(`⏭️ ${userId} skipped partner ${skipResult.partner} (both requeued at end)`);
            await attemptMatch();
            break;
          }

          case 'leave': {
            await handleUserDisconnect(userId);
            break;
          }

          case 'pong': {
            await stateManager.updateLastPong(userId);
            break;
          }

          case 'fun-request': {
            const session = await stateManager.getUserSession(userId);
            const partner = session ? await stateManager.getSessionPartner(userId) : null;
            if (!partner) {
              send(userId, { type: 'error', message: 'No active session for fun request' });
              break;
            }
            const game = (message as { game?: string }).game || 'chess';
            send(partner, { type: 'fun-request', from: userId, game });
            break;
          }

          case 'fun-accept': {
            const session = await stateManager.getUserSession(userId);
            const partner = session ? await stateManager.getSessionPartner(userId) : null;
            if (!partner) break;
            const game = (message as { game?: string }).game || 'chess';
            send(partner, { type: 'fun-accept', from: userId, game });
            break;
          }

          case 'fun-reject': {
            const session = await stateManager.getUserSession(userId);
            const partner = session ? await stateManager.getSessionPartner(userId) : null;
            if (!partner) break;
            send(partner, { type: 'fun-reject', from: userId });
            break;
          }

          case 'fun-exit': {
            const session = await stateManager.getUserSession(userId);
            const partner = session ? await stateManager.getSessionPartner(userId) : null;
            if (!partner) break;
            send(partner, { type: 'fun-exit', from: userId });
            break;
          }

          default:
            send(userId, { type: 'error', message: `Unsupported message type: ${(message as { type: string }).type}` });
        }
      });

      ws.on('close', (code, reason) => {
        handleUserDisconnect(userId);
        logger.info(`🔌 Connection closed: ${userId} (${code}: ${reason})`);
      });

      ws.on('error', (error) => {
        logger.error(`🔌 WebSocket error for ${userId}:`, error);
        handleUserDisconnect(userId);
      });
    } catch (error) {
      logger.error('🔌 Connection setup failed:', error);
      ws.close(4002, 'Authentication failed');
    }
  })();
});

// ═══════════════════════════════════════════════════════════════
// ❤️ HEARTBEAT
// ═══════════════════════════════════════════════════════════════

const heartbeatTimer = setInterval(async () => {
  const stats = await stateManager.getStats();
  logger.info(
    `💓 Heartbeat: ${stats.totalUsers} users, ${stats.activeSessions} sessions, V:${stats.searchingVideo}/A:${stats.searchingAudio}/T:${stats.searchingText} searching`
  );

  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        // silent
      }
    }
  });
}, HEARTBEAT_INTERVAL);

// ═══════════════════════════════════════════════════════════════
// 🧹 MAINTENANCE
// ═══════════════════════════════════════════════════════════════

const maintenanceTimer = setInterval(async () => {
  try {
    await matchmaking.performMaintenance();
    const stats = await matchmaking.getStats();
    logger.debug(`📊 System stats:`, stats);
    if (stats.searchingUsers > 50) {
      logger.warn(`⚠️ Large queue detected: ${stats.searchingUsers} users waiting`);
    }
  } catch (error) {
    logger.error('🧹 Maintenance error:', error);
  }
}, MAINTENANCE_INTERVAL);

// ═══════════════════════════════════════════════════════════════
// 🔄 GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════

async function gracefulShutdown(signal: string) {
  logger.info(`📴 ${signal} received - shutting down gracefully`);

  clearInterval(heartbeatTimer);
  clearInterval(maintenanceTimer);

  const stats = await stateManager.getStats();
  logger.info(`📴 Disconnecting ${stats.totalUsers} users...`);

  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.close(1001, 'Server shutting down');
    }
  });

  await closeRedis();

  httpServer.close(() => {
    logger.info('📴 Server shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('📴 Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.error('💥 Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});

// ═══════════════════════════════════════════════════════════════
// 🚀 STARTUP
// ═══════════════════════════════════════════════════════════════

initState()
  .then(() => {
    httpServer.listen({ port: env.port, backlog: 2048 }, () => {
      logger.info(`🚀 UniTalks Server started`);
      logger.info(`📡 HTTP server: http${env.httpsEnabled ? 's' : ''}://localhost:${env.port}`);
      logger.info(`🔌 WebSocket: ws${env.httpsEnabled ? 's' : ''}://localhost:${env.port}/ws`);
      logger.info(`🧊 ICE config: /api/ice/config`);
      logger.info(`🎯 Environment: ${env.nodeEnv}`);
      logger.info(`❤️ Heartbeat: ${HEARTBEAT_INTERVAL}ms`);
      logger.info(`🧹 Maintenance: ${MAINTENANCE_INTERVAL}ms`);
      logger.info('');
      logger.info('🎉 Ready to match users following Omegle-like rules!');
    });
  })
  .catch((err) => {
    logger.error('Failed to start server:', err);
    process.exit(1);
  });
