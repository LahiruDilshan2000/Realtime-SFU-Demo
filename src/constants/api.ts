// Backend base URI (Java backend)
// const BACKEND_URI = 'http://localhost:8092';
const BACKEND_URI = 'https://test-service.sharenest.io';

// Helper function to get the base URL dynamically
// Uses relative URLs when accessed via ngrok (through Vite proxy)
// Uses BACKEND_URI when accessed directly on localhost
function getBaseUrl(): string {
  if (typeof window === 'undefined') {
    return BACKEND_URI;
  }

  const hostname = window.location.hostname;

  // If accessing via localhost, use backend URI directly
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return BACKEND_URI;
  }

  // For ngrok or any other domain, use relative URLs
  // Vite proxy will forward these to the backend
  return '';
}

// Helper function to get WebSocket URL dynamically
// Uses relative URLs when accessed via ngrok (through Vite proxy)
// Uses localhost URLs when accessed directly on localhost
function getWebSocketUrl(): string {
  if (typeof window === 'undefined') {
    return 'ws://localhost:1234/webrtc';
  }

  const hostname = window.location.hostname;
  const protocol = window.location.protocol;

  // If accessing via localhost, use localhost WebSocket directly
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'ws://localhost:1234/webrtc';
  }

  // For ngrok or HTTPS domains, use relative WebSocket URL
  // Vite proxy will forward this to ws://localhost:1234/webrtc
  const wsProtocol = protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${hostname}/webrtc`;
}

// Room presence WebSocket - derives from backend URI (e.g. ws://localhost:8092/ws/room)
function getRoomWebSocketUrl(): string {
  const base = getBaseUrl();
  if (!base) return '';
  const wsProtocol = base.startsWith('https') ? 'wss:' : 'ws:';
  const host = base.replace(/^https?:\/\//, '');
  return `${wsProtocol}//${host}/ws/room`;
}

// API Configuration Constants
export const API_CONFIG = {
  /** Backend base URI (e.g. http://localhost:8092) */
  BACKEND_URI,
  BASE_URL: getBaseUrl() ? `${getBaseUrl()}/share-nest/api/v1/talk` : '/share-nest/api/v1/talk',
  BASE_URL_AUTH: getBaseUrl() ? `${getBaseUrl()}/share-nest/api/v1/auth` : '/share-nest/api/v1/auth',
  STORAGE_TOKEN_KEY: 'auth_token', // JWT token storage key
  TIME_ZONE: 'Asia/Colombo',
  WS_BASE_URL: getWebSocketUrl(),
  WS_ROOM_URL: getRoomWebSocketUrl(),
} as const;

// Cloudflare SFU Configuration
export const SFU_CONFIG = {
  STUN_SERVER: 'stun:cloudflare-calls.com', // Updated to Cloudflare Calls STUN server
  // TURN servers for firewall/NAT traversal (REQUIRED when ICE_TRANSPORT_POLICY is 'relay')
  // CRITICAL: When iceTransportPolicy: 'relay' is set, browser MUST have TURN servers in iceServers
  // Cloudflare Calls API handles TURN server-side, but browser still needs TURN servers configured
  // to get relay candidates. Without TURN servers, you'll see "No relay candidates" error.
  //
  // Free public TURN servers (for testing) - Metered.ca Open Relay:
  // - 20 GB/month free
  // - Ports 80/443 (bypasses firewalls)
  // - For production, use paid TURN services (Twilio, Xirsys, Metered.ca paid plan)
  TURN_SERVERS: [
    // Metered.ca Open Relay - Free public TURN server
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    // Alternative: freeTURN.net (backup)
    { urls: 'turn:freeturn.net:3478', username: 'free', credential: 'free' },
    { urls: 'turns:freeturn.net:5349', username: 'free', credential: 'free' },
  ] as Array<{ urls: string; username?: string; credential?: string }>,
  // CRITICAL: Force TURN relay for strict firewalls (corporate/school networks)
  // Set to 'relay' to force media through TURN servers (bypasses UDP blocking)
  // Set to 'all' (default) to allow direct peer-to-peer when possible
  // Use 'relay' if UDP traffic is blocked but TCP/TLS works (data channels work but media doesn't)
  //
  // NOTE: If TURN servers are not accessible, 'relay' mode will fail.
  // Try 'all' first - Cloudflare's SFU may provide TURN server-side.
  // Only use 'relay' if you have working TURN servers configured.
  ICE_TRANSPORT_POLICY: 'all' as 'all' | 'relay', // 'all' | 'relay' - Changed back to 'all' (Cloudflare handles TURN server-side)
} as const;
