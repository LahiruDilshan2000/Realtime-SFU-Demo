# Network/Firewall Diagnostics for WebRTC Media Flow

## Problem: The "UDP Hole" Issue

**Classic Symptom**: Data channels work (TCP/TLS) but Audio/Video don't (UDP)

If network/firewall is blocking media packets, tracks will stay muted even when:
- ✅ Signaling is successful
- ✅ Data channels work (TCP/TLS on port 443 - looks like regular web traffic)
- ✅ ICE connection appears stable
- ❌ **RTP media packets are blocked** (UDP on random ports - blocked by firewall)

**Why Data Channels Work But Media Doesn't**:
- Data Channels can fall back to TURN-over-TCP or TURN-over-TLS (port 443)
- This looks like regular HTTPS traffic to firewalls
- Video and Audio strictly prefer UDP
- If firewall blocks non-standard UDP ports, media packets are dropped

## Detection

### 1. Check ICE Connection State

Look for these logs after creating PeerConnection:

```
🔌 ICE Connection State: checking
🔌 ICE Connection State: connected  ✅ (Good!)
🔌 ICE Connection State: failed     ❌ (Network issue!)
🔌 ICE Connection State: disconnected ❌ (Network issue!)
```

**If you see `failed` or `disconnected`**:
- Firewall is blocking UDP/TCP media packets
- NAT traversal failed
- Network restrictions preventing peer-to-peer connection

### 2. Check ICE Candidates

Look for these logs:

```
🔍 ICE Gathering State: complete
   ICE Candidates gathered: {
     host: ✅,
     srflx: ✅,  (Server reflexive - NAT traversal)
     relay: ✅   (TURN relay - firewall bypass)
   }
```

**If `srflx` and `relay` are both ❌**:
- Firewall is blocking STUN/TURN
- No NAT traversal possible
- **Solution**: Configure TURN servers

### 3. Check chrome://webrtc-internals

1. Open `chrome://webrtc-internals`
2. Find your PeerConnection
3. Check **ICE Connection State**:
   - `connected` or `completed`: ✅ Network is working
   - `failed` or `disconnected`: ❌ Network issue
4. Check **ICE Candidates**:
   - Look for `typ srflx` (server reflexive)
   - Look for `typ relay` (TURN relay)
   - If only `typ host`: Firewall blocking

## Solutions

### Solution 1: Check Firewall Settings

**Windows Firewall**:
1. Open Windows Defender Firewall
2. Allow UDP/TCP on random ports (WebRTC uses random ports)
3. Or temporarily disable firewall to test

**Corporate Firewall**:
- Contact IT to allow WebRTC traffic
- Ports: UDP 1024-65535 (random)
- STUN: UDP 3478
- TURN: UDP/TCP 3478, 5349

### Solution 2: Force TURN Relay Mode (RECOMMENDED)

**The Most Likely Software Fix**: Force media through TURN servers using `iceTransportPolicy: 'relay'`

This bypasses UDP blocking by forcing all media through TURN relay (TCP/TLS), similar to how data channels work.

**Edit `src/constants/api.ts`**:

```typescript
export const SFU_CONFIG = {
  STUN_SERVER: 'stun:stun.cloudflare.com:3478',
  TURN_SERVERS: [], // Optional: Add custom TURN servers if needed
  // CRITICAL: Force TURN relay for strict firewalls
  ICE_TRANSPORT_POLICY: 'relay', // Change from 'all' to 'relay'
} as const;
```

**When to Use**:
- ✅ Data channels work but media doesn't (UDP blocking)
- ✅ Corporate/school networks with strict firewalls
- ✅ Testing on restricted networks
- ⚠️ Note: Slower than direct connection, but bypasses firewall

**Note**: Cloudflare Calls API uses Cloudflare's own TURN infrastructure, so you don't need to configure custom TURN servers unless you want additional fallback options.

### Solution 3: Configure Custom TURN Servers (Optional)

If you want additional TURN servers as fallback:

**Edit `src/constants/api.ts`**:

```typescript
export const SFU_CONFIG = {
  STUN_SERVER: 'stun:stun.cloudflare.com:3478',
  TURN_SERVERS: [
    // Example: Twilio TURN (requires account)
    {
      urls: 'turn:global.turn.twilio.com:3478',
      username: 'your-twilio-username',
      credential: 'your-twilio-credential'
    },
    // Example: Custom TURN server
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'user',
      credential: 'pass'
    }
  ],
} as const;
```

**Free TURN Server Options**:
- [Xirsys](https://xirsys.com/) - Free tier available
- [Twilio](https://www.twilio.com/stun-turn) - Free tier available
- [Metered.ca](https://www.metered.ca/stun-turn) - Free tier available

### Solution 3: Test Network Connectivity

**Test STUN Server**:
```bash
# Test if STUN server is reachable
ping stun.cloudflare.com
```

**Test TURN Server** (if configured):
```bash
# Test if TURN server is reachable
ping your-turn-server.com
```

### Solution 4: Check Cloudflare SFU Logs

If ICE connection is `connected` but tracks are still muted:
1. Check Cloudflare dashboard logs
2. Verify session is active
3. Check if SFU is receiving media from publisher
4. Verify SFU is sending media to subscriber

## Debugging Checklist

When tracks stay muted, check in this order:

1. ✅ **Selected Candidate Pair** (chrome://webrtc-internals):
   - `localCandidateType = relay`: ✅ Using TURN - should work
   - `localCandidateType = host/srflx` with `bytesReceived = 0`: ❌ Firewall blocking UDP
   - **Solution**: Set `ICE_TRANSPORT_POLICY` to `'relay'`

2. ✅ **Transport Type**:
   - `tcp` or `tls`: ✅ Firewall-friendly (like data channels)
   - `udp`: ⚠️ Might be blocked by firewall

3. ✅ **Publisher's Upload** (chrome://webrtc-internals → outbound-rtp):
   - If `bytesSent = 0`: ❌ Publisher not sending (check publisher's network)
   - If `bytesSent > 0`: Publisher is sending, check your firewall

4. ✅ **ICE Connection State**: Should be `connected` or `completed`
   - If `failed`: Network/firewall issue
   - If `checking` > 10 seconds: Firewall blocking

5. ✅ **ICE Candidates**: Should have `srflx` or `relay`
   - If only `host`: Firewall blocking STUN/TURN
   - Solution: Set `ICE_TRANSPORT_POLICY` to `'relay'`

6. ✅ **chrome://webrtc-internals**: Check `bytesReceived` (inbound-rtp)
   - If `bytesReceived = 0`: SFU not sending OR network blocking
   - If `bytesReceived > 0`: Media flowing, check video element

7. ✅ **Network Tab**: Check `PUT /renegotiate` response
   - Should be `200 OK`
   - If not 200: Signaling issue (not network)

## Expected Behavior

### Normal Flow (No Firewall Issues):

```
1. Create PeerConnection
   → 🔍 ICE Gathering State: gathering
   → 🔌 ICE Connection State: new

2. Add tracks/create offer
   → 🔍 ICE Gathering State: complete
   → ✅ ICE Candidates: host ✅, srflx ✅, relay ✅ (if TURN configured)

3. Set remote description
   → 🔌 ICE Connection State: checking
   → 🔌 ICE Connection State: connected ✅

4. Media flows
   → ✅ Tracks unmute
   → ✅ bytesReceived increases in chrome://webrtc-internals
```

### Firewall Blocking Flow:

```
1. Create PeerConnection
   → 🔍 ICE Gathering State: gathering
   → 🔌 ICE Connection State: new

2. Add tracks/create offer
   → 🔍 ICE Gathering State: complete
   → ⚠️ ICE Candidates: host ✅, srflx ❌, relay ❌

3. Set remote description
   → 🔌 ICE Connection State: checking
   → ❌ ICE Connection State: failed (after timeout)
   → ❌ Tracks stay muted
   → ❌ bytesReceived = 0
```

## Quick Test: The 4G/LTE Swap

**To instantly prove if it's a network/firewall issue**:

1. **Connect User A (Publisher) to mobile hotspot (4G/5G)**
2. **Connect User B (Subscriber) to different mobile hotspot**
3. **Test WebRTC connection**

**Results**:
- ✅ **If video unmutes**: Your Wi-Fi/Office Network firewall is definitely blocking WebRTC media ports
- ❌ **If still muted**: Issue is not firewall (check other fixes like direction, renegotiate, etc.)

**Alternative Quick Test**:
1. **Temporarily disable firewall** (Windows Defender, corporate firewall)
2. **Test WebRTC connection**
3. **If it works**: Firewall is blocking - set `ICE_TRANSPORT_POLICY` to `'relay'`
4. **If it still doesn't work**: Issue is not firewall (check other fixes)

## References

- [Cloudflare Realtime Examples](https://github.com/cloudflare/realtime-examples/tree/main)
- [WebRTC ICE Connection States](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/iceConnectionState)
- [TURN Server Setup Guide](https://webrtc.org/getting-started/turn-server)
