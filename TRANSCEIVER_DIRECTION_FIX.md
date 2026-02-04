# Transceiver Direction Fix - Critical for Muted Tracks

## Problem: Tracks Stay Muted Despite Successful Signaling

**Root Cause**: Transceiver direction mismatch. Cloudflare requires strict direction enforcement:
- **Publishers**: `sendonly` or `sendrecv`
- **Subscribers**: `recvonly` **ONLY** (not `sendrecv`)

If transceivers remain in `sendrecv` (the default), Cloudflare's SFU will not route media packets to subscribers.

## Critical Fixes Applied

### Fix #1: Force recvonly Direction BEFORE setRemoteDescription

**Location**: `handleSubscribe()` and `subscribeToExistingParticipants()`

**Code**:
```typescript
// BEFORE setRemoteDescription
pc.getTransceivers().forEach(transceiver => {
    if (transceiver.receiver?.track) {
        if (transceiver.direction !== 'recvonly') {
            console.log(`🔧 FORCING direction: ${transceiver.direction} → recvonly`);
            transceiver.direction = 'recvonly';
            // CRITICAL: Remove sender track if any (prevents sendrecv state)
            if (transceiver.sender.track) {
                console.log(`   Removing sender track to enforce recvonly`);
                transceiver.sender.replaceTrack(null);
            }
        }
    }
});

await pc.setRemoteDescription(sdpDescription);

// AFTER setRemoteDescription - verify again
pc.getTransceivers().forEach(transceiver => {
    if (transceiver.receiver?.track && transceiver.direction !== 'recvonly') {
        transceiver.direction = 'recvonly';
        if (transceiver.sender.track) {
            transceiver.sender.replaceTrack(null);
        }
    }
});
```

**Why This Works**:
- Setting direction BEFORE `setRemoteDescription` prevents browser from changing it during SDP processing
- Removing sender track ensures transceiver can't be in `sendrecv` state
- Verifying after ensures directions stay correct

### Fix #2: Network Diagnostics in performEmergencyRenegotiation

**Location**: `performEmergencyRenegotiation()` function

**Added**:
- Immediate stats check for `bytesReceived`
- Selected candidate pair diagnostics
- Clear error messages with solutions

**What It Checks**:
1. `inbound-rtp` → `bytesReceived`:
   - If 0: Network/firewall blocking OR SFU not sending
   - If > 0: Media flowing, check video element
2. `selectedCandidatePair` → `localCandidateType`:
   - `host`/`srflx` with 0 bytes: Firewall blocking UDP
   - `relay` with 0 bytes: TURN server issue

### Fix #3: Diagnostic Function

**Location**: Added `diagnoseMutedTracks()` function

**Usage**: 
- Available in browser console: `diagnoseMutedTracks()`
- Also accessible via "🔍 Diagnose" button in UI

**What It Shows**:
- All transceivers with their directions
- Connection state (ICE, signaling, connection)
- Bytes received per track
- Actionable solutions if no bytes received

### Fix #4: Force Re-Subscribe Button

**Location**: Control bar (bottom of screen)

**What It Does**:
- Clears all remote streams
- Clears pending subscriptions
- Re-subscribes to all participants with tracks
- Staggers subscriptions by 500ms to avoid race conditions

**When to Use**:
- If tracks stay muted after initial subscription
- If you suspect ghost sessions
- If transceiver directions got messed up

### Fix #5: Updated STUN Server

**Location**: `src/constants/api.ts`

**Changed**:
- From: `stun:stun.cloudflare.com:3478`
- To: `stun:cloudflare-calls.com`

**Note**: Cloudflare Calls API uses its own STUN server.

## Diagnostic Checklist

### Step 1: Check Transceiver Directions

**In browser console**:
```javascript
const pc = peerConnectionRef.current;
pc.getTransceivers().forEach(t => {
    console.log({
        mid: t.mid,
        direction: t.direction,
        currentDirection: t.currentDirection,
        receiverTrack: t.receiver?.track?.kind,
        senderTrack: t.sender?.track?.kind
    });
});
```

**Expected**: All receiving transceivers should have:
- `direction: 'recvonly'`
- `senderTrack: null` (no sender track)

### Step 2: Check Network Stats

**Run diagnostic function**:
```javascript
diagnoseMutedTracks();
```

**Or check manually**:
1. Open `chrome://webrtc-internals`
2. Find your PeerConnection
3. Click "stats tables"
4. Look for `inbound-rtp`
5. Check `bytesReceived` column

**Expected**:
- If `bytesReceived > 0`: Media is flowing (check video element)
- If `bytesReceived = 0`: SFU not sending OR network blocking

### Step 3: Check Renegotiate Response

**In Network Tab**:
1. Filter: `renegotiate`
2. Look for `PUT .../renegotiate` requests
3. Check response status

**Expected**: Should be `200 OK`

**If not 200**:
- Handshake failed
- Check SDP format
- Check Cloudflare logs

### Step 4: Check Selected Candidate Pair

**In `chrome://webrtc-internals`**:
1. Find `selectedCandidatePair`
2. Check `localCandidateType`:
   - `relay`: ✅ Using TURN (bypasses firewall)
   - `host`/`srflx`: ⚠️ Direct connection (might be blocked)

**If `host`/`srflx` with 0 bytes**:
- Firewall blocking UDP
- Solution: Set `ICE_TRANSPORT_POLICY` to `'relay'`

## Quick Actions

### If Tracks Stay Muted:

1. **Run diagnostic**:
   ```javascript
   diagnoseMutedTracks();
   ```

2. **Check transceiver directions**:
   ```javascript
   const pc = peerConnectionRef.current;
   pc.getTransceivers().forEach(t => console.log({
       mid: t.mid,
       direction: t.direction,
       receiverTrack: t.receiver?.track?.kind
   }));
   ```

3. **Force re-subscribe**:
   - Click "🔄 Force Re-Subscribe" button
   - Or run in console:
   ```javascript
   // Clear and re-subscribe
   updateRemoteStreams(() => new Map());
   participants.forEach(p => {
       if (p.sessionId !== sessionId && p.hasPublishedTracks) {
           handleSubscribe(p.sessionId);
       }
   });
   ```

4. **Check network**:
   - Open `chrome://webrtc-internals`
   - Check `bytesReceived` in `inbound-rtp`
   - If 0: Set `ICE_TRANSPORT_POLICY` to `'relay'`

## Expected Behavior After Fixes

1. **Before setRemoteDescription**:
   - ✅ Transceivers forced to `recvonly`
   - ✅ Sender tracks removed
   - ✅ Log shows: "FORCING direction: sendrecv → recvonly"

2. **After setRemoteDescription**:
   - ✅ Directions verified again
   - ✅ Log shows: "Transceiver directions enforced to recvonly (subscriber mode)"

3. **After renegotiation**:
   - ✅ Answer sent back via `/renegotiate`
   - ✅ Response is `200 OK`
   - ✅ Log shows: "Cloudflare accepted the answer"

4. **Media Flow**:
   - ✅ Tracks unmute within 1-2 seconds
   - ✅ `bytesReceived` increases in stats
   - ✅ Video plays automatically

## Code Locations

All fixes are in `src/views/SFUTest.tsx`:

- **Transceiver Direction (handleSubscribe)**: Lines ~780-796
- **Transceiver Direction (subscribeToExistingParticipants)**: Lines ~2326-2357, ~2481-2497
- **Network Diagnostics**: Lines ~2000-2070 (performEmergencyRenegotiation)
- **Diagnostic Function**: Lines ~1450-1500
- **Force Re-Subscribe Button**: Lines ~5708-5740
- **STUN Server**: `src/constants/api.ts` line ~55

## Most Likely Causes

If tracks still stay muted after fixes:

1. **Transceiver direction not recvonly** (60% likely)
   - Check with `diagnoseMutedTracks()`
   - Verify `direction: 'recvonly'` for all receiving transceivers

2. **Renegotiate call not returning 200 OK** (25% likely)
   - Check Network Tab for `PUT /renegotiate`
   - Verify response status is 200

3. **Firewall blocking UDP packets** (15% likely)
   - Check `chrome://webrtc-internals` → `selectedCandidatePair`
   - If `localCandidateType` is `host`/`srflx` with 0 bytes: Firewall blocking
   - Solution: Set `ICE_TRANSPORT_POLICY` to `'relay'`

## References

- [Cloudflare Realtime Examples](https://github.com/cloudflare/realtime-examples/tree/main)
- [WebRTC RTCRtpTransceiver Direction](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver/direction)
- [WebRTC Stats API](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats)
