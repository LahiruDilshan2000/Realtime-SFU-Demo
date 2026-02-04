# Handshake Mismatch Fix - Transceiver Direction & Renegotiation Lock

## Problem: Handshake Mismatch During Subscribe Flow

**Symptoms**:
- ✅ Data channels work
- ✅ Signaling is successful
- ✅ Emergency unmute listeners are added
- ❌ `onunmute` never fires
- ❌ Tracks stay muted

**Root Cause**: Transceivers are in a "muddled" state because both local publishing and remote subscribing happen on the same PeerConnection without enforcing directional logic.

## Critical Fixes Applied

### Fix #1: Enforce Transceiver Direction BEFORE setRemoteDescription

**Problem**: If transceivers remain in `sendrecv` (the default), Cloudflare's SFU will not route media packets to you.

**Fix**: Force transceivers to `recvonly` **BEFORE** calling `setRemoteDescription()`:

```typescript
// BEFORE setRemoteDescription
pc.getTransceivers().forEach(transceiver => {
    // If the transceiver was created for a remote track (no sender track)
    // OR if it's a receiving transceiver, force it to recvonly
    if ((!transceiver.sender.track || transceiver.receiver?.track) && transceiver.direction !== 'recvonly') {
        console.log(`🔧 Enforcing recvonly on transceiver: ${transceiver.mid}`);
        transceiver.direction = 'recvonly';
    }
});

await pc.setRemoteDescription(sdpDescription);

// AFTER setRemoteDescription - verify directions are still correct
pc.getTransceivers().forEach(t => {
    if (t.receiver && t.receiver.track && t.direction !== 'recvonly') {
        t.direction = 'recvonly';
    }
});
```

**Location**: `handleSubscribe()` function, lines ~664-708

### Fix #2: Handle Renegotiation Lock Bug

**Problem**: Even if Cloudflare sends an Answer, if `requiresImmediateRenegotiation: true` is in the response, you MUST send the Answer back via `/renegotiate` to unlock media flow.

**Fix**: Check for `requiresImmediateRenegotiation` flag even when SDP type is "answer":

```typescript
const requiresRenegotiation = response.data?.requiresImmediateRenegotiation || 
                             (response as any)?.data?.requiresRenegotiation ||
                             (response as any)?.requiresImmediateRenegotiation;

if (requiresRenegotiation || sdpType === 'offer') {
    // Create answer and send back via /renegotiate
    const renegotiateAnswer = await pc.createAnswer();
    await pc.setLocalDescription(renegotiateAnswer);
    
    const renegotiateRequest: RenegotiateRequest = {
        sessionDescription: {
            sdp: renegotiateAnswer.sdp || '',
            type: renegotiateAnswer.type as 'answer',
        },
    };
    
    await sfuApiService.renegotiate(sessionId, renegotiateRequest);
}
```

**Location**: `handleSubscribe()` function, lines ~710-750

### Fix #3: Handle Late-Arriving Tracks

**Problem**: If a track is added to the stream after the component mounts, the `useEffect` might not catch the new track's `onunmute` event.

**Fix**: Add `addtrack` event listener to the stream:

```typescript
useEffect(() => {
    const onAddTrack = (e: RTCTrackEvent) => {
        console.log(`🆕 New track added to existing stream: ${e.track.kind}`);
        const track = e.track;
        
        // Set up unmute listener for late-arriving track
        track.onunmute = () => {
            console.log(`🎉 Late-arriving ${track.kind} track unmuted`);
            const video = videoRef.current;
            if (video && video.paused) {
                video.play().catch(console.error);
            }
        };
        
        // Ensure track is enabled
        if (!track.enabled) {
            track.enabled = true;
        }
    };

    stream.addEventListener('addtrack', onAddTrack);
    return () => stream.removeEventListener('addtrack', onAddTrack);
}, [stream, sessionId]);
```

**Location**: `RemoteVideoTile` component, lines ~193-220

### Fix #4: Ghost Session Cleanup

**Problem**: When User A refreshes the page, their old sessionId is still in participants state. User B subscribes to the dead session.

**Fix**: Remove old session for same userId before adding new one:

```typescript
// In handleParticipantJoined
setParticipants(prev => {
    // Remove old session for same userId before adding new one
    const existingParticipant = prev.find(p => p.userId === userId && p.sessionId !== newSessionId);
    if (existingParticipant) {
        console.log(`🧹 Removing ghost session: ${existingParticipant.sessionId}`);
        // Clean up old session's stream
        setRemoteStreams(prevStreams => {
            const newMap = new Map(prevStreams);
            if (newMap.has(existingParticipant.sessionId)) {
                const stream = newMap.get(existingParticipant.sessionId);
                if (stream) {
                    stream.getTracks().forEach(track => track.stop());
                }
                newMap.delete(existingParticipant.sessionId);
            }
            return newMap;
        });
        pendingSubscriptionsRef.current.delete(existingParticipant.sessionId);
    }
    
    // ... add new participant
});
```

**Location**: 
- `handleParticipantJoined()` function, lines ~494-538
- `handleParticipantLeft()` function, lines ~541-561

## Diagnostic Checklist

After applying fixes, check:

### 1. Transceiver Directions

**In browser console**:
```javascript
pc.getTransceivers().forEach(t => {
    console.log({
        mid: t.mid,
        direction: t.direction,
        currentDirection: t.currentDirection,
        hasReceiver: !!t.receiver?.track,
        hasSender: !!t.sender?.track
    });
});
```

**Expected**: All receiving transceivers should have `direction: 'recvonly'`

### 2. Renegotiation Response

**Check logs for**:
```
📋 Renegotiation check: {
    sdpType: 'answer',
    requiresImmediateRenegotiation: true,  // ← Should trigger renegotiation
    willRenegotiate: true
}
```

**Expected**: If `requiresImmediateRenegotiation: true`, Answer should be sent back via `/renegotiate`

### 3. bytesReceived in chrome://webrtc-internals

**Open `chrome://webrtc-internals`**:
1. Find your PeerConnection
2. Look for `inbound-rtp` section
3. Check `bytesReceived`:
   - **If increasing**: ✅ SFU is sending data - issue is React/Video element
   - **If 0**: ❌ SFU is not sending - handshake failed

### 4. Ghost Sessions

**Check logs for**:
```
🧹 Removing ghost session for userId X: old-session-id (replaced by new-session-id)
```

**Expected**: Old sessions should be cleaned up when user rejoins

## Expected Behavior After Fixes

1. **Before setRemoteDescription**:
   - ✅ Transceivers are forced to `recvonly`
   - ✅ Log shows: "Enforcing recvonly on transceiver"

2. **After setRemoteDescription**:
   - ✅ Directions are verified again
   - ✅ Log shows: "Transceiver directions verified after setRemoteDescription"

3. **Renegotiation**:
   - ✅ If `requiresImmediateRenegotiation: true`, Answer is sent back
   - ✅ Log shows: "Answer sent to Cloudflare via PUT /renegotiate"

4. **Track Arrival**:
   - ✅ `addtrack` event fires for late-arriving tracks
   - ✅ `onunmute` listener is attached to new tracks
   - ✅ Video plays when track unmutes

5. **Ghost Sessions**:
   - ✅ Old sessions are cleaned up when user rejoins
   - ✅ No subscriptions to dead sessions

## Code Locations

All fixes are in `src/views/SFUTest.tsx`:

- **Transceiver Direction**: Lines ~664-708 (handleSubscribe)
- **Renegotiation Lock**: Lines ~710-750 (handleSubscribe)
- **Late-Arriving Tracks**: Lines ~193-220 (RemoteVideoTile)
- **Ghost Session Cleanup**: Lines ~494-538 (handleParticipantJoined), Lines ~541-561 (handleParticipantLeft)

## References

- [Cloudflare Realtime Examples](https://github.com/cloudflare/realtime-examples/tree/main)
- [WebRTC RTCRtpTransceiver Direction](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver/direction)
- [WebRTC Renegotiation](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/currentRemoteDescription)
