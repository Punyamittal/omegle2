/**
 * WebRTC ICE configuration.
 * Fetches from /api/ice/config when available (includes TURN), falls back to STUN-only.
 */
export const ESTABLISHMENT_DELAY_THRESHOLD_MS = 2500;

export const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'stun:stun.stunprotocol.org:3478' },
  { urls: 'stun:stun.ekiga.net' },
  { urls: 'stun:stun.ideasip.com' },
  { urls: 'stun:stun.schlund.de' },
  { urls: 'stun:stun.voip.blackberry.com:3478' },
  { urls: 'stun:stun.voipbuster.com' },
  { urls: 'stun:stun.voxgratia.org' },
  { urls: 'stun:stun.xten.com' },
  { urls: 'stun:stun.callwithus.com' },
  { urls: 'stun:stun.counterpath.com' },
  { urls: 'stun:stun.internet-call.com' },
  { urls: 'stun:stun.nextcloud.com:443' },
];

let cachedIceConfig = null;

/**
 * Fetch ICE config from backend (STUN + TURN when configured)
 */
export async function fetchIceConfig() {
  if (cachedIceConfig) return cachedIceConfig;
  const baseUrl = process.env.REACT_APP_API_URL || '';
  if (!baseUrl) {
    cachedIceConfig = { iceServers: STUN_SERVERS.slice(0, 3), iceTransportPolicy: 'all' };
    return cachedIceConfig;
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ice/config`);
    if (res.ok) {
      const data = await res.json();
      cachedIceConfig = {
        iceServers: data.iceServers || STUN_SERVERS.slice(0, 3),
        iceTransportPolicy: data.iceTransportPolicy || 'all',
      };
      return cachedIceConfig;
    }
  } catch (err) {
    console.warn('ICE config fetch failed, using fallback:', err);
  }
  cachedIceConfig = { iceServers: STUN_SERVERS.slice(0, 3), iceTransportPolicy: 'all' };
  return cachedIceConfig;
}

/**
 * @param {number} serverIndex - Current STUN server index (0-based). Rotate when establishment delay > threshold.
 * @returns {{ iceServers: Array<{ urls: string }> }}
 */
export function getRtcConfig(serverIndex) {
  const index = Math.abs(serverIndex || 0) % STUN_SERVERS.length;
  return {
    iceServers: [STUN_SERVERS[index]],
  };
}

/**
 * Get RTC config - prefers API config (with TURN) when available, else fallback
 */
export function getRtcConfigWithApi(serverIndex) {
  if (cachedIceConfig) {
    return { iceServers: cachedIceConfig.iceServers, iceTransportPolicy: cachedIceConfig.iceTransportPolicy };
  }
  return getRtcConfig(serverIndex);
}
