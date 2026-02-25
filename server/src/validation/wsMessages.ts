import { z } from 'zod';

const modeSchema = z.enum(['video', 'audio', 'text']);
const signalTypeSchema = z.enum(['offer', 'answer', 'ice']);

export function validateClientMessage(raw: unknown): { valid: boolean; message?: object; error?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, error: 'Message must be an object' };
  }

  const msg = raw as Record<string, unknown>;
  const type = msg.type;

  if (typeof type !== 'string') {
    return { valid: false, error: 'Missing type field' };
  }

  switch (type) {
    case 'join': {
      const modeResult = modeSchema.safeParse(msg.mode ?? 'video');
      if (!modeResult.success) return { valid: false, error: 'Invalid mode' };
      return { valid: true, message: { type: 'join', mode: modeResult.data } };
    }
    case 'signal': {
      const signalTypeResult = signalTypeSchema.safeParse(msg.signalType);
      if (!signalTypeResult.success) return { valid: false, error: 'Invalid signalType' };
      if (msg.data === undefined) return { valid: false, error: 'Missing signal data' };
      return { valid: true, message: { type: 'signal', signalType: signalTypeResult.data, data: msg.data } };
    }
    case 'fun-request':
    case 'fun-accept': {
      const game = typeof msg.game === 'string' ? msg.game.slice(0, 50) : 'chess';
      return { valid: true, message: { type, game } as { type: 'fun-request' | 'fun-accept'; game: string } };
    }
    case 'fun-reject':
    case 'fun-exit':
      return { valid: true, message: { type } };
    case 'cancel':
    case 'acknowledge':
    case 'skip':
    case 'leave':
    case 'pong':
      return { valid: true, message: { type } };
    default:
      return { valid: false, error: `Unknown message type: ${type}` };
  }
}
