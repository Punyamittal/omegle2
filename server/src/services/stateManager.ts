import type { WebSocket } from 'ws';
import { UserState, Session, UserRecord } from '../types';
import { logger } from '../utils/logger';

export interface IStateManager {
  addUser(userId: string, ws: WebSocket): Promise<void>;
  removeUser(userId: string): Promise<void>;
  getUser(userId: string): UserRecord | undefined;
  getWs(userId: string): WebSocket | undefined;
  updateUserState(userId: string, newState: UserState): Promise<boolean>;
  updateLastPong(userId: string): Promise<void>;
  setMode(userId: string, mode: 'video' | 'audio' | 'text'): Promise<void>;
  canEnqueue(userId: string): Promise<{ allowed: boolean; reason?: string }>;
  enqueueUser(userId: string): Promise<boolean>;
  dequeueUser(userId: string): Promise<boolean>;
  canCreateSession(userAId: string, userBId: string): Promise<{ allowed: boolean; reason?: string }>;
  createSession(userAId: string, userBId: string, initiator: string): Promise<string | null>;
  acknowledgeSession(userId: string): Promise<boolean>;
  getSession(sessionId: string): Promise<Session | undefined>;
  getUserSession(userId: string): Promise<Session | undefined>;
  getSessionPartner(userId: string): Promise<string | undefined>;
  endSession(sessionId: string, initiatedBy?: string): Promise<{ partner?: string; reason: string }>;
  handleSkip(userId: string): Promise<{ success: boolean; partner?: string; reason?: string }>;
  getSearchingUsers(mode: 'video' | 'audio' | 'text'): Promise<UserRecord[]>;
  getQueuePosition(userId: string): Promise<number>;
  validateState(): Promise<{ valid: boolean; issues: string[] }>;
  getStats(): Promise<{
    totalUsers: number;
    activeSessions: number;
    states: Record<string, number>;
    searchingVideo: number;
    searchingAudio: number;
    searchingText: number;
    searchingUsers: number;
  }>;
}

export class StateManager implements IStateManager {
  private users = new Map<string, UserRecord>();
  private sessions = new Map<string, Session>();
  private userSessions = new Map<string, string>();

  private readonly MAX_SKIPS_PER_MINUTE = 50;
  private readonly SKIP_COOLDOWN_MS = 60000;

  async addUser(userId: string, ws: WebSocket): Promise<void> {
    const existing = this.users.get(userId);
    if (existing) {
      await this.removeUser(userId);
    }

    const user: UserRecord = {
      userId,
      ws,
      state: UserState.IDLE,
      lastPong: Date.now(),
      skipCount: 0,
      lastSkipTime: 0,
      mode: 'video',
    };

    this.users.set(userId, user);
    logger.info(`User added: ${userId} (state: ${user.state})`);
  }

  async removeUser(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;

    if (user.sessionId) {
      await this.endSession(user.sessionId, userId);
    }

    this.users.delete(userId);
    this.userSessions.delete(userId);
    logger.info(`User removed: ${userId}`);
  }

  getUser(userId: string): UserRecord | undefined {
    return this.users.get(userId);
  }

  getWs(userId: string): WebSocket | undefined {
    return this.users.get(userId)?.ws;
  }

  async updateUserState(userId: string, newState: UserState): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user) return false;
    user.state = newState;
    return true;
  }

  async updateLastPong(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (user) user.lastPong = Date.now();
  }

  async setMode(userId: string, mode: 'video' | 'audio' | 'text'): Promise<void> {
    const user = this.users.get(userId);
    if (user) {
      user.mode = mode;
      logger.info(`Set mode for ${userId} to ${mode}`);
    }
  }

  async canEnqueue(userId: string): Promise<{ allowed: boolean; reason?: string }> {
    const user = this.users.get(userId);
    if (!user) return { allowed: false, reason: 'User not found' };
    if (user.state === UserState.CONNECTED) return { allowed: false, reason: 'Already in session' };
    if (user.state === UserState.SEARCHING) return { allowed: false, reason: 'Already searching' };
    if (this.isRateLimited(userId)) return { allowed: false, reason: 'Rate limited - too many skips' };
    return { allowed: true };
  }

  async enqueueUser(userId: string): Promise<boolean> {
    const validation = await this.canEnqueue(userId);
    if (!validation.allowed) {
      logger.warn(`Enqueue blocked: ${userId} - ${validation.reason}`);
      return false;
    }

    const user = this.users.get(userId)!;
    user.state = UserState.SEARCHING;
    user.enqueuedAt = Date.now();

    const queuePosition = await this.getQueuePosition(userId);
    logger.info(`User enqueued: ${userId} (mode: ${user.mode}, position: ${queuePosition})`);
    return true;
  }

  async dequeueUser(userId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user || user.state !== UserState.SEARCHING) return false;

    user.state = UserState.IDLE;
    user.enqueuedAt = undefined;
    logger.info(`User dequeued: ${userId}`);
    return true;
  }

  async canCreateSession(userAId: string, userBId: string): Promise<{ allowed: boolean; reason?: string }> {
    const userA = this.users.get(userAId);
    const userB = this.users.get(userBId);

    if (!userA || !userB) return { allowed: false, reason: 'One or both users not found' };
    if (userA.state !== UserState.SEARCHING || userB.state !== UserState.SEARCHING)
      return { allowed: false, reason: 'Users not in searching state' };
    if (userAId === userBId) return { allowed: false, reason: 'Cannot match with self' };
    if (userA.sessionId || userB.sessionId)
      return { allowed: false, reason: 'One or both users already in session' };
    if (userA.mode !== userB.mode)
      return { allowed: false, reason: `Mode mismatch: ${userA.mode} vs ${userB.mode}` };
    return { allowed: true };
  }

  async createSession(userAId: string, userBId: string, _initiator: string): Promise<string | null> {
    const validation = await this.canCreateSession(userAId, userBId);
    if (!validation.allowed) {
      logger.warn(`Session creation blocked: ${userAId} <-> ${userBId} - ${validation.reason}`);
      return null;
    }

    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const userA = this.users.get(userAId)!;
    const userB = this.users.get(userBId)!;

    const session: Session = {
      sessionId,
      userA: userAId,
      userB: userBId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      acknowledgedBy: new Set(),
      state: 'pending',
      mode: userA.mode,
    };

    userA.state = UserState.CONNECTED;
    userA.sessionId = sessionId;
    userA.enqueuedAt = undefined;
    userB.state = UserState.CONNECTED;
    userB.sessionId = sessionId;
    userB.enqueuedAt = undefined;

    this.sessions.set(sessionId, session);
    this.userSessions.set(userAId, sessionId);
    this.userSessions.set(userBId, sessionId);

    logger.info(`Session created: ${sessionId} (${userAId} <-> ${userBId}) [${session.mode}]`);
    return sessionId;
  }

  async acknowledgeSession(userId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user?.sessionId) return false;

    const session = this.sessions.get(user.sessionId);
    if (!session) return false;

    session.acknowledgedBy.add(userId);
    session.lastActivity = Date.now();

    if (session.acknowledgedBy.size === 2) {
      session.state = 'active';
      logger.info(`Session activated: ${session.sessionId}`);
      return true;
    }
    return false;
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.sessions.get(sessionId);
  }

  async getUserSession(userId: string): Promise<Session | undefined> {
    const sessionId = this.userSessions.get(userId);
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  async getSessionPartner(userId: string): Promise<string | undefined> {
    const session = await this.getUserSession(userId);
    if (!session) return undefined;
    return session.userA === userId ? session.userB : session.userA;
  }

  async endSession(sessionId: string, initiatedBy?: string): Promise<{ partner?: string; reason: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { reason: 'Session not found' };

    const { userA, userB } = session;
    const partner = initiatedBy === userA ? userB : userA;

    this.sessions.delete(sessionId);
    this.userSessions.delete(userA);
    this.userSessions.delete(userB);

    const userARecord = this.users.get(userA);
    const userBRecord = this.users.get(userB);
    if (userARecord) {
      userARecord.state = UserState.IDLE;
      userARecord.sessionId = undefined;
    }
    if (userBRecord) {
      userBRecord.state = UserState.IDLE;
      userBRecord.sessionId = undefined;
    }

    logger.info(`Session ended: ${sessionId}`);
    return { partner, reason: 'ended' };
  }

  async handleSkip(userId: string): Promise<{ success: boolean; partner?: string; reason?: string }> {
    const user = this.users.get(userId);
    if (!user) return { success: false, reason: 'User not found' };
    if (user.state !== UserState.CONNECTED || !user.sessionId)
      return { success: false, reason: 'Not in active session' };
    if (this.isRateLimited(userId)) return { success: false, reason: 'Rate limited - too many skips' };

    user.skipCount++;
    user.lastSkipTime = Date.now();

    const result = await this.endSession(user.sessionId, userId);
    return { success: true, partner: result.partner, reason: 'skipped' };
  }

  async getSearchingUsers(mode: 'video' | 'audio' | 'text' = 'video'): Promise<UserRecord[]> {
    return Array.from(this.users.values())
      .filter((u) => u.state === UserState.SEARCHING && u.mode === mode)
      .sort((a, b) => (a.enqueuedAt || 0) - (b.enqueuedAt || 0));
  }

  async getQueuePosition(userId: string): Promise<number> {
    const user = this.users.get(userId);
    if (!user) return -1;
    const searching = await this.getSearchingUsers(user.mode);
    const idx = searching.findIndex((u) => u.userId === userId);
    return idx === -1 ? -1 : idx + 1;
  }

  private isRateLimited(userId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;
    const elapsed = Date.now() - user.lastSkipTime;
    if (elapsed < this.SKIP_COOLDOWN_MS && user.skipCount >= this.MAX_SKIPS_PER_MINUTE) return true;
    if (elapsed >= this.SKIP_COOLDOWN_MS) user.skipCount = 0;
    return false;
  }

  async validateState(): Promise<{ valid: boolean; issues: string[] }> {
    const issues: string[] = [];
    this.sessions.forEach((session, sessionId) => {
      const userA = this.users.get(session.userA);
      const userB = this.users.get(session.userB);
      if (!userA || !userB) {
        issues.push(`Orphaned session: ${sessionId}`);
        this.sessions.delete(sessionId);
      }
    });
    this.users.forEach((user) => {
      if (user.sessionId && !this.sessions.has(user.sessionId)) {
        issues.push(`User ${user.userId} references non-existent session ${user.sessionId}`);
        user.sessionId = undefined;
        user.state = UserState.IDLE;
      }
    });
    return { valid: issues.length === 0, issues };
  }

  async getStats() {
    const states = Array.from(this.users.values()).reduce((acc, user) => {
      acc[user.state] = (acc[user.state] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const video = (await this.getSearchingUsers('video')).length;
    const audio = (await this.getSearchingUsers('audio')).length;
    const text = (await this.getSearchingUsers('text')).length;

    return {
      totalUsers: this.users.size,
      activeSessions: this.sessions.size,
      states,
      searchingVideo: video,
      searchingAudio: audio,
      searchingText: text,
      searchingUsers: video + audio + text,
    };
  }
}
