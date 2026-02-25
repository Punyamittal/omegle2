import { Router, Request, Response } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const router = Router();

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function buildIceServers(): IceServer[] {
  const servers: IceServer[] = [];

  // STUN servers
  for (const url of env.stunUrls) {
    if (url.trim()) {
      servers.push({ urls: url.trim() });
    }
  }

  // TURN server (Coturn)
  if (env.turnHost && env.turnSecret) {
    const protocol = env.turnTls ? 'turns' : 'turn';
    const port = env.turnPort || 3478;
    const urls = [`${protocol}:${env.turnHost}:${port}`];
    servers.push({
      urls,
      username: 'unitalks',
      credential: env.turnSecret,
    });
  }

  return servers;
}

router.get('/config', (_req: Request, res: Response) => {
  try {
    const iceServers = buildIceServers();
    res.json({
      iceServers,
      iceTransportPolicy: 'all' as const,
    });
    logger.debug('ICE config served');
  } catch (error) {
    logger.error('ICE config error:', error);
    res.status(500).json({ error: 'Failed to get ICE config' });
  }
});

export default router;
