import dotenv from 'dotenv';

dotenv.config();

export interface EnvConfig {
  port: number;
  nodeEnv: string;
  jwtSecret: string;
  corsOrigin?: string;
  redisUrl?: string;
  useRedis: boolean;
  // HTTPS
  httpsEnabled: boolean;
  sslCertPath?: string;
  sslKeyPath?: string;
  // TURN / ICE
  turnHost?: string;
  turnPort: number;
  turnSecret?: string;
  turnTls: boolean;
  stunUrls: string[];
  // Rate limiting
  rateLimitWindowMs: number;
  rateLimitMax: number;
  wsRateLimitWindowMs: number;
  wsRateLimitMax: number;
  // Support
  supportEmail?: string;
}

function getEnvConfig(): EnvConfig {
  const port = parseInt(process.env.PORT || '8080', 10);
  const nodeEnv = process.env.NODE_ENV || 'development';
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  const corsOrigin = process.env.CORS_ORIGIN;
  const redisUrl = process.env.REDIS_URL;
  const useRedis = process.env.USE_REDIS === 'true' && !!redisUrl;

  const httpsEnabled = process.env.HTTPS_ENABLED === 'true';
  const sslCertPath = process.env.SSL_CERT_PATH;
  const sslKeyPath = process.env.SSL_KEY_PATH;

  const turnHost = process.env.TURN_HOST;
  const turnPort = parseInt(process.env.TURN_PORT || '3478', 10);
  const turnSecret = process.env.TURN_SECRET;
  const turnTls = process.env.TURN_TLS !== 'false';
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
  const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '100', 10);
  const wsRateLimitWindowMs = parseInt(process.env.WS_RATE_LIMIT_WINDOW_MS || '60000', 10);
  const wsRateLimitMax = parseInt(process.env.WS_RATE_LIMIT_MAX || '60', 10);

  const supportEmail = process.env.SUPPORT_EMAIL;

  return {
    port,
    nodeEnv,
    jwtSecret,
    corsOrigin,
    redisUrl,
    useRedis,
    httpsEnabled,
    sslCertPath,
    sslKeyPath,
    turnHost,
    turnPort,
    turnSecret,
    turnTls,
    stunUrls,
    rateLimitWindowMs,
    rateLimitMax,
    wsRateLimitWindowMs,
    wsRateLimitMax,
    supportEmail,
  };
}

export const env = getEnvConfig();
