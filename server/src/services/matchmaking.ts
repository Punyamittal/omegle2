import type { IStateManager } from './stateManager';
import { UserRecord } from '../types';
import { logger } from '../utils/logger';

export class MatchmakingService {
  private stateManager: IStateManager;
  private readonly QUEUE_TIMEOUT_MS = 30000;

  constructor(stateManager: IStateManager) {
    this.stateManager = stateManager;
  }

  async findMatch(mode: 'video' | 'audio' | 'text'): Promise<string | null> {
    const searchingUsers = await this.stateManager.getSearchingUsers(mode);
    await this.pruneStaleUsers(searchingUsers);

    const users = await this.stateManager.getSearchingUsers(mode);
    if (users.length < 2) {
      if (users.length > 0) {
        logger.debug(`No ${mode} match possible: only ${users.length} users searching`);
      }
      return null;
    }

    const userA = users[0];
    const userB = users[1];

    logger.info(
      `🔍 FIFO ${mode} Match attempt: ${userA.userId}(${new Date(userA.enqueuedAt || 0).toISOString()}) <-> ${userB.userId}(${new Date(userB.enqueuedAt || 0).toISOString()})`
    );

    const initiator = (userA.enqueuedAt || 0) <= (userB.enqueuedAt || 0) ? userA.userId : userB.userId;
    const sessionId = await this.stateManager.createSession(userA.userId, userB.userId, initiator);

    if (sessionId) {
      const queueLen = await this.getQueueLength(mode);
      logger.info(`🎯 ✅ ${mode} Match created: ${userA.userId} <-> ${userB.userId} (session: ${sessionId}, queue now: ${queueLen})`);
    } else {
      logger.warn(`❌ ${mode} Match failed: ${userA.userId} <-> ${userB.userId} - will retry`);
    }

    return sessionId;
  }

  async enqueueUser(userId: string): Promise<{ success: boolean; queuePosition?: number; reason?: string }> {
    const success = await this.stateManager.enqueueUser(userId);

    if (!success) {
      const canEnqueue = await this.stateManager.canEnqueue(userId);
      return { success: false, reason: canEnqueue.reason };
    }

    const queuePosition = await this.stateManager.getQueuePosition(userId);
    logger.info(`📥 User enqueued: ${userId} (position: ${queuePosition})`);
    return { success: true, queuePosition };
  }

  async dequeueUser(userId: string): Promise<boolean> {
    const success = await this.stateManager.dequeueUser(userId);
    if (success) logger.info(`📤 User dequeued: ${userId}`);
    return success;
  }

  async cancelSearch(userId: string): Promise<boolean> {
    return this.dequeueUser(userId);
  }

  async getQueueLength(mode: 'video' | 'audio' | 'text' = 'video'): Promise<number> {
    const users = await this.stateManager.getSearchingUsers(mode);
    return users.length;
  }

  async getUserQueuePosition(userId: string): Promise<number> {
    return this.stateManager.getQueuePosition(userId);
  }

  private async pruneStaleUsers(searchingUsers: UserRecord[]): Promise<void> {
    const cutoff = Date.now() - this.QUEUE_TIMEOUT_MS;

    for (const user of searchingUsers) {
      if ((user.enqueuedAt || 0) < cutoff) {
        await this.stateManager.dequeueUser(user.userId);
        logger.info(`⏰ Pruned stale user: ${user.userId}`);
      }
    }
  }

  async performMaintenance(): Promise<void> {
    const [videoUsers, audioUsers, textUsers] = await Promise.all([
      this.stateManager.getSearchingUsers('video'),
      this.stateManager.getSearchingUsers('audio'),
      this.stateManager.getSearchingUsers('text'),
    ]);

    await this.pruneStaleUsers(videoUsers);
    await this.pruneStaleUsers(audioUsers);
    await this.pruneStaleUsers(textUsers);

    const validation = await this.stateManager.validateState();
    if (!validation.valid) {
      logger.warn('State validation issues:', validation.issues);
    }
  }

  async getStats() {
    return this.stateManager.getStats();
  }
}
