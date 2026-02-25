import type { WebSocket } from 'ws';
import Redis from 'ioredis';
import { UserState, Session, UserRecord } from '../types';
import { logger } from '../utils/logger';
import type { IStateManager } from './stateManager';

const USER_PREFIX = 'user:';
const SESSION_PREFIX = 'session:';
const QUEUE_PREFIX = 'queue:';
const USER_SESSION_PREFIX = 'user_session:';
const TTL_SEC = 86400; // 24h

interface UserMeta {
  userId: string;
  state: UserState;
  sessionId?: string;
  lastPong: number;
  skipCount: number;
  lastSkipTime: number;
  enqueuedAt?: number;
  mode: 'video' | 'audio' | 'text';
}

interface SessionData {
  sessionId: string;
  userA: string;
  userB: string;
  createdAt: number;
  lastActivity: number;
  acknowledgedBy: string[];
  state: 'pending' | 'active' | 'ended';
  mode: 'video' | 'audio' | 'text';
}

export class RedisStateManager implements IStateManager {
  private redis: Redis;
  private wsMap = new Map<string, WebSocket>();
  private metaCache = new Map<string, UserMeta>();
  private readonly MAX_SKIPS_PER_MINUTE = 50;
  private readonly SKIP_COOLDOWN_MS = 60000;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private userKey(userId: string) {
    return `${USER_PREFIX}${userId}`;
  }
  private sessionKey(sessionId: string) {
    return `${SESSION_PREFIX}${sessionId}`;
  }
  private queueKey(mode: 'video' | 'audio' | 'text') {
    return `${QUEUE_PREFIX}${mode}`;
  }
  private userSessionKey(userId: string) {
    return `${USER_SESSION_PREFIX}${userId}`;
  }

  async addUser(userId: string, ws: WebSocket): Promise<void> {
    const existing = this.wsMap.get(userId);
    if (existing) {
      await this.removeUser(userId);
    }

    this.wsMap.set(userId, ws);

    const meta: UserMeta = {
      userId,
      state: UserState.IDLE,
      lastPong: Date.now(),
      skipCount: 0,
      lastSkipTime: 0,
      mode: 'video',
    };

    await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
    this.metaCache.set(userId, meta);
    logger.info(`User added (Redis): ${userId}`);
  }

  async removeUser(userId: string): Promise<void> {
    const meta = await this.getUserMeta(userId);
    if (meta?.sessionId) {
      await this.endSession(meta.sessionId, userId);
    }

    this.wsMap.delete(userId);
    this.metaCache.delete(userId);
    await this.redis.del(this.userKey(userId));
    await this.redis.del(this.userSessionKey(userId));
    await this.redis.lrem(this.queueKey(meta?.mode || 'video'), 0, userId);
    logger.info(`User removed (Redis): ${userId}`);
  }

  getUser(userId: string): UserRecord | undefined {
    const ws = this.wsMap.get(userId);
    const meta = this.metaCache.get(userId);
    if (!ws || !meta) return undefined;
    return { ...meta, ws } as UserRecord;
  }

  getWs(userId: string): WebSocket | undefined {
    return this.wsMap.get(userId);
  }

  private async getUserMeta(userId: string): Promise<UserMeta | undefined> {
    const v = await this.redis.get(this.userKey(userId));
    return v ? (JSON.parse(v) as UserMeta) : undefined;
  }

  async updateUserState(userId: string, newState: UserState): Promise<boolean> {
    const meta = await this.getUserMeta(userId);
    if (!meta) return false;
    meta.state = newState;
    await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
    this.metaCache.set(userId, meta);
    return true;
  }

  async updateLastPong(userId: string): Promise<void> {
    const meta = await this.getUserMeta(userId);
    if (meta) {
      meta.lastPong = Date.now();
      await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
      this.metaCache.set(userId, meta);
    }
  }

  async setMode(userId: string, mode: 'video' | 'audio' | 'text'): Promise<void> {
    const meta = await this.getUserMeta(userId);
    if (meta) {
      meta.mode = mode;
      await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
      this.metaCache.set(userId, meta);
      logger.info(`Set mode for ${userId} to ${mode}`);
    }
  }

  async canEnqueue(userId: string): Promise<{ allowed: boolean; reason?: string }> {
    const meta = await this.getUserMeta(userId);
    if (!meta) return { allowed: false, reason: 'User not found' };
    if (meta.state === UserState.CONNECTED) return { allowed: false, reason: 'Already in session' };
    if (meta.state === UserState.SEARCHING) return { allowed: false, reason: 'Already searching' };
    if (await this.isRateLimited(userId)) return { allowed: false, reason: 'Rate limited - too many skips' };
    return { allowed: true };
  }

  async enqueueUser(userId: string): Promise<boolean> {
    const validation = await this.canEnqueue(userId);
    if (!validation.allowed) {
      logger.warn(`Enqueue blocked: ${userId} - ${validation.reason}`);
      return false;
    }

    const meta = (await this.getUserMeta(userId))!;
    meta.state = UserState.SEARCHING;
    meta.enqueuedAt = Date.now();
    await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
    this.metaCache.set(userId, meta);
    await this.redis.rpush(this.queueKey(meta.mode), userId);

    const pos = await this.getQueuePosition(userId);
    logger.info(`User enqueued (Redis): ${userId} mode=${meta.mode} position=${pos}`);
    return true;
  }

  async dequeueUser(userId: string): Promise<boolean> {
    const meta = await this.getUserMeta(userId);
    if (!meta || meta.state !== UserState.SEARCHING) return false;

    meta.state = UserState.IDLE;
    meta.enqueuedAt = undefined;
    await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
    this.metaCache.set(userId, meta);
    await this.redis.lrem(this.queueKey(meta.mode), 0, userId);
    logger.info(`User dequeued (Redis): ${userId}`);
    return true;
  }

  async canCreateSession(userAId: string, userBId: string): Promise<{ allowed: boolean; reason?: string }> {
    const [userA, userB] = await Promise.all([this.getUserMeta(userAId), this.getUserMeta(userBId)]);
    if (!userA || !userB) return { allowed: false, reason: 'One or both users not found' };
    if (userA.state !== UserState.SEARCHING || userB.state !== UserState.SEARCHING)
      return { allowed: false, reason: 'Users not in searching state' };
    if (userAId === userBId) return { allowed: false, reason: 'Cannot match with self' };
    if (userA.sessionId || userB.sessionId) return { allowed: false, reason: 'One or both users already in session' };
    if (userA.mode !== userB.mode) return { allowed: false, reason: `Mode mismatch: ${userA.mode} vs ${userB.mode}` };
    return { allowed: true };
  }

  async createSession(userAId: string, userBId: string, _initiator: string): Promise<string | null> {
    const validation = await this.canCreateSession(userAId, userBId);
    if (!validation.allowed) {
      logger.warn(`Session creation blocked: ${userAId} <-> ${userBId} - ${validation.reason}`);
      return null;
    }

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const userA = (await this.getUserMeta(userAId))!;

    const session: SessionData = {
      sessionId,
      userA: userAId,
      userB: userBId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      acknowledgedBy: [],
      state: 'pending',
      mode: userA.mode,
    };

    const userB = (await this.getUserMeta(userBId))!;
    userA.state = UserState.CONNECTED;
    userA.sessionId = sessionId;
    userA.enqueuedAt = undefined;
    userB.state = UserState.CONNECTED;
    userB.sessionId = sessionId;
    userB.enqueuedAt = undefined;

    this.metaCache.set(userAId, userA);
    this.metaCache.set(userBId, userB);
    await Promise.all([
      this.redis.setex(this.userKey(userAId), TTL_SEC, JSON.stringify(userA)),
      this.redis.setex(this.userKey(userBId), TTL_SEC, JSON.stringify(userB)),
      this.redis.setex(this.sessionKey(sessionId), TTL_SEC, JSON.stringify(session)),
      this.redis.set(this.userSessionKey(userAId), sessionId),
      this.redis.set(this.userSessionKey(userBId), sessionId),
    ]);
    await this.redis.lrem(this.queueKey(userA.mode), 0, userAId);
    await this.redis.lrem(this.queueKey(userA.mode), 0, userBId);

    logger.info(`Session created (Redis): ${sessionId} (${userAId} <-> ${userBId})`);
    return sessionId;
  }

  async acknowledgeSession(userId: string): Promise<boolean> {
    const meta = await this.getUserMeta(userId);
    if (!meta?.sessionId) return false;

    const sessRaw = await this.redis.get(this.sessionKey(meta.sessionId));
    if (!sessRaw) return false;

    const session = JSON.parse(sessRaw) as SessionData;
    if (!session.acknowledgedBy.includes(userId)) {
      session.acknowledgedBy.push(userId);
    }
    session.lastActivity = Date.now();

    if (session.acknowledgedBy.length === 2) {
      session.state = 'active';
      await this.redis.setex(this.sessionKey(meta.sessionId), TTL_SEC, JSON.stringify(session));
      logger.info(`Session activated (Redis): ${session.sessionId}`);
      return true;
    }

    await this.redis.setex(this.sessionKey(meta.sessionId), TTL_SEC, JSON.stringify(session));
    return false;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    const v = await this.redis.get(this.sessionKey(sessionId));
    if (!v) return undefined;
    const d = JSON.parse(v) as SessionData;
    return {
      ...d,
      acknowledgedBy: new Set(d.acknowledgedBy),
    } as Session;
  }

  async getUserSession(userId: string): Promise<Session | undefined> {
    const sessionId = await this.redis.get(this.userSessionKey(userId));
    if (!sessionId) return undefined;
    return this.getSession(sessionId);
  }

  async getSessionPartner(userId: string): Promise<string | undefined> {
    const session = await this.getUserSession(userId);
    if (!session) return undefined;
    return session.userA === userId ? session.userB : session.userA;
  }

  async endSession(sessionId: string, initiatedBy?: string): Promise<{ partner?: string; reason: string }> {
    const sessRaw = await this.redis.get(this.sessionKey(sessionId));
    if (!sessRaw) return { reason: 'Session not found' };

    const session = JSON.parse(sessRaw) as SessionData;
    const { userA, userB } = session;
    const partner = initiatedBy === userA ? userB : userA;

    await Promise.all([
      this.redis.del(this.sessionKey(sessionId)),
      this.redis.del(this.userSessionKey(userA)),
      this.redis.del(this.userSessionKey(userB)),
    ]);

    const [metaA, metaB] = await Promise.all([this.getUserMeta(userA), this.getUserMeta(userB)]);
    if (metaA) {
      metaA.state = UserState.IDLE;
      metaA.sessionId = undefined;
      await this.redis.setex(this.userKey(userA), TTL_SEC, JSON.stringify(metaA));
      this.metaCache.set(userA, metaA);
    }
    if (metaB) {
      metaB.state = UserState.IDLE;
      metaB.sessionId = undefined;
      await this.redis.setex(this.userKey(userB), TTL_SEC, JSON.stringify(metaB));
      this.metaCache.set(userB, metaB);
    }

    logger.info(`Session ended (Redis): ${sessionId}`);
    return { partner, reason: 'ended' };
  }

  async handleSkip(userId: string): Promise<{ success: boolean; partner?: string; reason?: string }> {
    const meta = await this.getUserMeta(userId);
    if (!meta) return { success: false, reason: 'User not found' };
    if (meta.state !== UserState.CONNECTED || !meta.sessionId)
      return { success: false, reason: 'Not in active session' };
    if (await this.isRateLimited(userId)) return { success: false, reason: 'Rate limited - too many skips' };

    meta.skipCount++;
    meta.lastSkipTime = Date.now();
    await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
    this.metaCache.set(userId, meta);

    const result = await this.endSession(meta.sessionId, userId);
    return { success: true, partner: result.partner, reason: 'skipped' };
  }

  async getSearchingUsers(mode: 'video' | 'audio' | 'text' = 'video'): Promise<UserRecord[]> {
    const userIds = await this.redis.lrange(this.queueKey(mode), 0, -1);
    const users: UserRecord[] = [];
    for (const id of userIds) {
      const meta = await this.getUserMeta(id);
      if (meta) this.metaCache.set(id, meta);
      const ws = this.wsMap.get(id);
      if (meta && ws && meta.state === UserState.SEARCHING) {
        users.push({ ...meta, ws } as UserRecord);
      }
    }
    users.sort((a, b) => (a.enqueuedAt || 0) - (b.enqueuedAt || 0));
    return users;
  }

  async getQueuePosition(userId: string): Promise<number> {
    const meta = await this.getUserMeta(userId);
    if (!meta) return -1;
    const userIds = await this.redis.lrange(this.queueKey(meta.mode), 0, -1);
    const idx = userIds.indexOf(userId);
    return idx === -1 ? -1 : idx + 1;
  }

  private async isRateLimited(userId: string): Promise<boolean> {
    const meta = await this.getUserMeta(userId);
    if (!meta) return false;
    const elapsed = Date.now() - meta.lastSkipTime;
    if (elapsed < this.SKIP_COOLDOWN_MS && meta.skipCount >= this.MAX_SKIPS_PER_MINUTE) return true;
    if (elapsed >= this.SKIP_COOLDOWN_MS) {
      meta.skipCount = 0;
      await this.redis.setex(this.userKey(userId), TTL_SEC, JSON.stringify(meta));
      this.metaCache.set(userId, meta);
    }
    return false;
  }

  async validateState(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    const keys = await this.redis.keys(`${SESSION_PREFIX}*`);
    for (const k of keys) {
      const sessRaw = await this.redis.get(k);
      if (!sessRaw) continue;
      const s = JSON.parse(sessRaw) as SessionData;
      const [a, b] = await Promise.all([this.getUserMeta(s.userA), this.getUserMeta(s.userB)]);
      if (!a || !b) {
        issues.push(`Orphaned session: ${s.sessionId}`);
        await this.redis.del(k);
      }
    }
    return { valid: issues.length === 0, issues };
  }

  async getStats(): Promise<{
    totalUsers: number;
    activeSessions: number;
    states: Record<string, number>;
    searchingVideo: number;
    searchingAudio: number;
    searchingText: number;
    searchingUsers: number;
  }> {
    const [video, audio, text] = await Promise.all([
      this.redis.llen(this.queueKey('video')),
      this.redis.llen(this.queueKey('audio')),
      this.redis.llen(this.queueKey('text')),
    ]);
    const sessionKeys = await this.redis.keys(`${SESSION_PREFIX}*`);
    const totalUsers = this.wsMap.size;

    return {
      totalUsers,
      activeSessions: sessionKeys.length,
      states: {},
      searchingVideo: video,
      searchingAudio: audio,
      searchingText: text,
      searchingUsers: video + audio + text,
    };
  }
}
