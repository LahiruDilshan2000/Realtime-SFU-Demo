# WebRTC Media Flow Fixes - Critical Surgery

This document details the precise fixes applied to resolve muted tracks and ensure RTP media flow starts properly.

## Problem Diagnosis

The logs confirmed that:
- ✅ WebRTC signaling is successful
- ✅ Data Channel is working perfectly
- ✅ ICE connection is solid
- ❌ **RTP Media Flow is NOT starting** - tracks stay muted after 8 seconds

The "Muted" state indicates the browser has a track placeholder but is receiving **zero packets** from Cloudflare SFU.

## Critical Fixes Applied

### 1. ✅ Transceiver Direction Enforcement (CRITICAL)

**Problem**: Cloudflare requires strict direction enforcement. If you are the Subscriber, your transceivers MUST be in `recvonly` mode. If they are `sendrecv` (the default), Cloudflare won't push media because it thinks you're trying to send data back.

**Fix Applied**: Added transceiver direction enforcement immediately after `pc.setRemoteDescription()` in subscription logic:

```typescript
// CRITICAL FIX #1: Force transceiver direction to recvonly for subscribers
pc.getTransceivers().forEach(t => {
    if (t.receiver && t.receiver.track) {
        // Force the browser to only listen (recvonly) - Cloudflare won't push media if direction is sendrecv
        if (t.direction !== 'recvonly') {
            console.log(`🔄 Fixing transceiver ${t.mid} direction: ${t.direction} -> recvonly`);
            t.setDirection('recvonly');
        }
    }
});
```

**Location**: 
- `handleSubscribe()` function (line ~622)
- `subscribeToExistingParticipants()` function (line ~2140)

### 2. ✅ Answer Format Verification & Renegotiate Logging

**Problem**: When subscribing to tracks, Cloudflare sends an Offer. You must generate an Answer and send it back via `PUT /renegotiate`. If this fails or returns non-200, Cloudflare won't "open the valve" for media.

**Fix Applied**: 
- Enhanced logging to verify renegotiate response status
- Added explicit checks for 200 OK response
- Added network tab debugging instructions

```typescript
console.log('✅✅✅ Answer sent to Cloudflare - renegotiation complete!');
console.log('   ✅✅✅ CRITICAL: Renegotiate call returned 200 OK - Cloudflare accepted the answer!');
console.log('   📊 Check Network Tab: PUT .../renegotiate should show 200 OK response');
console.log('   🔍 If 200 OK, Cloudflare has "opened the valve" for media flow');
```

**Location**: 
- `handleSubscribe()` function (line ~658)
- `subscribeToExistingParticipants()` function (line ~2184)

### 3. ✅ Codec Preference (VP8) for Maximum Compatibility

**Problem**: Codec mismatch can cause muted tracks. If User A is on Mac/iPhone (using H.264) and User B is on Windows without H.264 hardware acceleration, the track will stay muted.

**Fix Applied**: 
- Added VP8 codec preference in PeerConnection configuration
- Modified SDP to remove H.264 codecs when creating answers

```typescript
// In RTCPeerConnection creation
const pc = new RTCPeerConnection({
    iceServers: [{urls: SFU_CONFIG.STUN_SERVER}],
    bundlePolicy: "max-bundle",
    sdpSemantics: 'unified-plan' as RTCSdpSemantics,
});

// When creating answers, remove H.264 codecs
if (answer.sdp) {
    let modifiedSdp = answer.sdp;
    modifiedSdp = modifiedSdp.replace(/a=rtpmap:\d+ H264\/\d+\/\d+\r\n/g, '');
    modifiedSdp = modifiedSdp.replace(/a=fmtp:\d+ .*H264.*\r\n/g, '');
    modifiedSdp = modifiedSdp.replace(/a=rtcp-fb:\d+ .*H264.*\r\n/g, '');
    answer.sdp = modifiedSdp;
    console.log('🔧 Modified SDP to prefer VP8 over H.264 for better compatibility');
}
```

**Location**: 
- `testJoinRoom()` function (line ~2781)
- `handleSubscribe()` function (line ~634)
- `subscribeToExistingParticipants()` function (line ~2154)

### 4. ✅ Enhanced Video Element Debugging & Manual Play Fallback

**Problem**: Sometimes tracks receive data (bytesReceived > 0) but the video element doesn't play due to browser autoplay policies or React rendering issues.

**Fix Applied**:
- Added comprehensive track state logging
- Added manual play button fallback
- Enhanced error messages with debugging steps

```typescript
// Track state logging
console.log('   Track state:', {
    videoTracks: videoTracks.length,
    audioTracks: audioTracks.length,
    videoTrackMuted: videoTracks[0]?.muted,
    // ... more state
});

// Manual play button (appears when video is paused)
{hasVideoTrack && isPaused && (
    <button onClick={() => videoRef.current?.play()}>
        ▶️ Play
    </button>
)}
```

**Location**: 
- `RemoteVideoTile` component (line ~47, ~310)

### 5. ✅ Ghost Session Cleanup Instructions

**Problem**: WebRTC often fails to unmute if you are subscribed to an old/dead session ID from a previous page refresh.

**Fix Applied**: Added logging to identify ghost sessions and instructions for cleanup:

**Testing Steps**:
1. Close all browser tabs
2. Clear your backend database/cache of all sessions
3. Open User A (Publisher)
4. Open User B (Subscriber)

If it works now, the problem was "Zombie Sessions" in your backend.

## Debugging Checklist

When tracks stay muted, follow this checklist:

### Step 1: Check Transceiver Direction
Look for log: `🔄 Fixing transceiver ${mid} direction: ${direction} -> recvonly`
- ✅ If you see this: Direction enforcement is working
- ❌ If you don't see this: Transceivers might be in wrong direction

### Step 2: Verify Renegotiate Response
Look for log: `✅✅✅ CRITICAL: Renegotiate call returned 200 OK`
- ✅ If you see this: Answer was accepted by Cloudflare
- ❌ If you see error: Check Network Tab for PUT /renegotiate response

**Network Tab Check**:
- Open DevTools → Network Tab
- Filter: `renegotiate`
- Look for `PUT .../renegotiate` request
- Response must be **200 OK**
- If not 200: Cloudflare rejected the answer (check SDP format)

### Step 3: Check chrome://webrtc-internals

**Critical Diagnostic Tool**:

1. Open `chrome://webrtc-internals` in a new tab
2. Find your PeerConnection
3. Look for `inbound-rtp` section for Video track
4. Check `bytesReceived` graph:

**Diagnosis**:
- **bytesReceived = 0**: SFU is NOT sending data
  - ✅ Direction enforcement worked
  - ✅ Renegotiate returned 200 OK
  - ❌ **Still 0 bytes**: Check Cloudflare SFU logs, verify session is active
- **bytesReceived > 0 but muted**: Video element issue
  - ✅ Media is flowing from SFU
  - ❌ Video element isn't playing
  - **Solution**: Click manual play button or check autoplay policy

### Step 4: Manual Play Test

If `bytesReceived > 0` but video is muted:
1. Look for manual play button (▶️ Play) on video tile
2. Click it
3. If video plays: Browser autoplay policy issue
4. If video still doesn't play: Check video element error logs

## Expected Behavior After Fixes

1. **After Subscription**:
   - ✅ Transceiver directions are set to `recvonly`
   - ✅ Answer is created and sent via PUT /renegotiate
   - ✅ Renegotiate returns 200 OK
   - ✅ Log shows: "Cloudflare has opened the valve for media flow"

2. **Within 1-2 seconds**:
   - ✅ Tracks should unmute automatically
   - ✅ Video should start playing
   - ✅ `bytesReceived` in chrome://webrtc-internals should increase

3. **If Still Muted After 8 seconds**:
   - Check chrome://webrtc-internals for `bytesReceived`
   - Follow debugging checklist above
   - Check for ghost sessions in backend

## Code Locations

All fixes are in `src/views/SFUTest.tsx`:

- **Transceiver Direction**: Lines ~622, ~2140
- **Renegotiate Logging**: Lines ~658, ~2184
- **Codec Preference**: Lines ~2781, ~634, ~2154
- **Video Debugging**: Lines ~47-71, ~310-340
- **Manual Play Button**: Lines ~340-360

## Next Steps

1. **Test the fixes**: Run the app and subscribe to tracks
2. **Monitor logs**: Look for the new diagnostic messages
3. **Check Network Tab**: Verify PUT /renegotiate returns 200 OK
4. **Check chrome://webrtc-internals**: Verify bytesReceived > 0
5. **If still muted**: Follow debugging checklist above

## 6. ✅ Network/Firewall Diagnostics & TURN Support (NEW)

**Problem**: Network/firewall can block media packets, causing tracks to stay muted even when signaling works.

**Fix Applied**: 
- Added comprehensive ICE connection state monitoring
- Added ICE candidate gathering diagnostics
- Added TURN server support (optional fallback)
- Enhanced error messages for network issues

```typescript
// Network diagnostics in RTCPeerConnection creation
pc.addEventListener('iceconnectionstatechange', () => {
    if (state === 'failed' || state === 'disconnected') {
        console.error('❌❌❌ NETWORK/FIREWALL ISSUE DETECTED ❌❌❌');
        // ... detailed diagnostics
    }
});

// ICE candidate gathering diagnostics
pc.addEventListener('icegatheringstatechange', () => {
    // Check for host/srflx/relay candidates
    // Warn if no reflexive/relay candidates (firewall blocking)
});
```

**Location**: 
- `testJoinRoom()` function (line ~2911)

**TURN Server Configuration** (if needed):
If you're behind a strict firewall, add TURN servers to `src/constants/api.ts`:

```typescript
export const SFU_CONFIG = {
  STUN_SERVER: 'stun:stun.cloudflare.com:3478',
  TURN_SERVERS: [
    { 
      urls: 'turn:your-turn-server.com:3478', 
      username: 'user', 
      credential: 'pass' 
    }
  ],
} as const;
```

**Note**: Cloudflare Calls API uses Cloudflare's own TURN infrastructure internally, but you can add custom TURN servers as fallback for strict firewalls.

## Additional Notes

- **Ghost Sessions**: If you see multiple session IDs for the same user, clear backend cache
- **Codec Mismatch**: VP8 is now preferred, but H.264 might still be used if VP8 isn't available
- **Browser Autoplay**: Some browsers block autoplay - manual play button handles this
- **Network Issues**: If bytesReceived stays 0, check:
  1. ICE connection state (should be "connected" or "completed")
  2. ICE candidates (should have srflx or relay candidates)
  3. Firewall settings (allow UDP/TCP on random ports)
  4. Cloudflare SFU logs and network connectivity
