# UDP Hole Problem Fix - Data Channels Work But Media Doesn't

## The Problem

**Classic Symptom**: 
- ✅ Data channels work perfectly
- ✅ Signaling is successful
- ✅ ICE connection appears stable
- ❌ **Audio/Video tracks stay muted**

## Root Cause: UDP Hole Problem

**Why Data Channels Work But Media Doesn't**:

1. **Data Channels** can fall back to:
   - TURN-over-TCP (port 443)
   - TURN-over-TLS (port 443)
   - These look like regular HTTPS traffic to firewalls
   - Firewalls typically allow port 443 (HTTPS)

2. **Video and Audio** strictly prefer:
   - UDP on random ports (1024-65535)
   - Direct peer-to-peer when possible
   - Firewalls often block non-standard UDP ports
   - Result: Media packets are dropped

## The Fix: Force TURN Relay Mode

**Solution**: Set `iceTransportPolicy: 'relay'` to force all media through TURN servers (TCP/TLS), just like data channels.

### Configuration

**Edit `src/constants/api.ts`**:

```typescript
export const SFU_CONFIG = {
  STUN_SERVER: 'stun:stun.cloudflare.com:3478',
  TURN_SERVERS: [], // Optional: Custom TURN servers
  // CRITICAL: Force TURN relay for strict firewalls
  ICE_TRANSPORT_POLICY: 'relay', // Change from 'all' to 'relay'
} as const;
```

**What This Does**:
- Forces all media through TURN relay servers
- Uses TCP/TLS transport (like data channels)
- Bypasses UDP blocking
- Works through strict firewalls (corporate/school networks)

**Trade-offs**:
- ✅ Bypasses firewall blocking
- ✅ Works on restricted networks
- ⚠️ Slightly slower than direct connection (but usually acceptable)
- ⚠️ Uses more bandwidth (relay server in the middle)

## Diagnostics

### Check Selected Candidate Pair

**Open `chrome://webrtc-internals`**:

1. Find your PeerConnection
2. Look for **selectedCandidatePair**
3. Check **localCandidateType**:
   - `relay`: ✅ Using TURN relay - bypassing firewall
   - `host` or `srflx`: ⚠️ Using direct connection - might be blocked

4. Check **transportType**:
   - `tcp` or `tls`: ✅ Firewall-friendly
   - `udp`: ⚠️ Might be blocked

**What to Look For**:
- If `localCandidateType` is `host` or `srflx` AND `bytesReceived = 0`: Firewall blocking UDP
- **Solution**: Set `ICE_TRANSPORT_POLICY` to `'relay'`

### Check Publisher's Upload

**If you're the subscriber**, check if publisher is sending data:

1. Open `chrome://webrtc-internals`
2. Look for **outbound-rtp** section
3. Check **bytesSent**:
   - If `bytesSent = 0`: ❌ Publisher not sending (check publisher's network)
   - If `bytesSent > 0`: Publisher is sending, check your firewall

## Quick Test: 4G/LTE Swap

**To instantly prove if it's a firewall issue**:

1. Connect User A (Publisher) to mobile hotspot (4G/5G)
2. Connect User B (Subscriber) to different mobile hotspot
3. Test WebRTC connection

**Results**:
- ✅ **If video unmutes**: Your Wi-Fi/Office Network firewall is blocking WebRTC media ports
- ❌ **If still muted**: Issue is not firewall (check other fixes)

## When to Use This Fix

**Use `iceTransportPolicy: 'relay'` when**:
- ✅ Data channels work but media doesn't
- ✅ Testing on corporate/school networks
- ✅ Testing on restricted Wi-Fi
- ✅ UDP ports are blocked by firewall
- ✅ Direct peer-to-peer connection fails

**Don't use `iceTransportPolicy: 'relay'` when**:
- ❌ You want lowest latency (direct connection is faster)
- ❌ You want to minimize bandwidth usage
- ❌ Your network allows UDP (normal home networks)

## Code Changes

The fix is already implemented in `src/views/SFUTest.tsx`:

```typescript
const pc = new RTCPeerConnection({
    iceServers: iceServers,
    bundlePolicy: "max-bundle",
    iceTransportPolicy: SFU_CONFIG.ICE_TRANSPORT_POLICY, // 'all' | 'relay'
    rtcpMuxPolicy: 'require',
});
```

**To enable**: Change `ICE_TRANSPORT_POLICY` from `'all'` to `'relay'` in `src/constants/api.ts`

## Expected Behavior

### Before Fix (UDP Blocked):
```
Data Channels: ✅ Working (TCP/TLS on port 443)
Media: ❌ Muted (UDP blocked)
Selected Candidate: host/srflx
Transport: udp
bytesReceived: 0
```

### After Fix (Forced Relay):
```
Data Channels: ✅ Working (TCP/TLS on port 443)
Media: ✅ Working (TCP/TLS through TURN relay)
Selected Candidate: relay
Transport: tcp/tls
bytesReceived: > 0
```

## References

- [Cloudflare Realtime Examples](https://github.com/cloudflare/realtime-examples/tree/main)
- [WebRTC ICE Transport Policy](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/iceTransportPolicy)
- [WebRTC TURN Servers](https://webrtc.org/getting-started/turn-server)
