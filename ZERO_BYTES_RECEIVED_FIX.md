# Zero Bytes Received Fix - Critical Diagnostic

## Problem: NO BYTES RECEIVED ON ANY INBOUND RTP

**Error Message**: `❌❌❌ NO BYTES RECEIVED ON ANY INBOUND RTP!`

**What This Means**:
- ✅ Signaling handshake is complete (ICE connected, signaling stable)
- ✅ Tracks are created (they exist but are muted)
- ✅ Transceiver directions are correct (`recvonly`)
- ❌ **SFU is NOT sending media packets** OR network is blocking them

## Root Causes

### 1. Renegotiate Call Not Returning 200 OK (MOST LIKELY - 70%)

**Symptom**: `bytesReceived = 0` even though connection is stable

**Diagnosis**:
1. Open **Network Tab** in DevTools
2. Filter: `renegotiate`
3. Find `PUT .../renegotiate` request
4. Check **Response Status**:
   - ✅ **200 OK**: Renegotiate succeeded (check other causes)
   - ❌ **400/401/404/500**: Renegotiate failed - **THIS IS THE PROBLEM**

**Common Error Responses**:
- **400 Bad Request**: Invalid SDP format in answer
- **401 Unauthorized**: Authentication token expired
- **404 Not Found**: Session ID mismatch
- **500 Internal Server Error**: Backend API error

**Fix**: Check the error response body in Network Tab for details

### 2. Transceiver Direction Not recvonly (20%)

**Symptom**: Tracks exist but direction is `sendrecv` instead of `recvonly`

**Diagnosis**:
```javascript
const pc = peerConnectionRef.current;
pc.getTransceivers().forEach(t => {
    console.log({
        mid: t.mid,
        direction: t.direction,
        currentDirection: t.currentDirection,
        receiverTrack: t.receiver?.track?.kind
    });
});
```

**Expected**: All receiving transceivers should have `direction: 'recvonly'`

**Fix**: The code now enforces `recvonly` before and after `setRemoteDescription()`

### 3. Network/Firewall Blocking UDP (10%)

**Symptom**: `bytesReceived = 0` and `selectedCandidatePair` shows `host`/`srflx` with UDP

**Diagnosis**:
1. Open `chrome://webrtc-internals`
2. Find `selectedCandidatePair`
3. Check `localCandidateType`:
   - `relay`: ✅ Using TURN (should work)
   - `host`/`srflx`: ⚠️ Direct connection (might be blocked)

**Fix**: Set `ICE_TRANSPORT_POLICY` to `'relay'` in `SFU_CONFIG`

## Enhanced Diagnostics Added

### 1. Detailed Renegotiate Logging

**Before renegotiate call**:
```
📤 ABOUT TO CALL: PUT /renegotiate endpoint
   SessionId: xxx
   Answer SDP length: xxx
   Answer type: answer
```

**After renegotiate call**:
```
📥 RENEGOTIATE RESPONSE RECEIVED:
   Response status: 200 (or error status)
   Response keys: [...]
   Full response: {...}
```

**If error**:
```
❌❌❌ RENEGOTIATION ERROR - THIS IS WHY BYTES RECEIVED = 0!
   Error: ...
   Response status: 400/401/404/500
   Response data: {...}
```

### 2. Delayed Stats Check

**Changed**: Stats check now waits 2 seconds before checking `bytesReceived`

**Why**: Stats may not be populated immediately after renegotiation

**New behavior**:
- Waits 2 seconds after renegotiate completes
- Then checks `bytesReceived`
- Provides more accurate diagnosis

### 3. Enhanced Error Messages

**Added**:
- Clear indication that renegotiate failure = no media
- Instructions to check Network Tab
- Common error causes listed
- Actionable solutions

## Diagnostic Steps

### Step 1: Check Renegotiate Response Status

**In Network Tab**:
1. Filter: `renegotiate`
2. Find `PUT .../renegotiate` request
3. Check **Status** column:
   - ✅ **200 OK**: Renegotiate succeeded
   - ❌ **Other**: Renegotiate failed - **THIS IS THE PROBLEM**

**If NOT 200 OK**:
- Click on the request
- Go to **Response** tab
- Read the error message
- Common errors:
  - `Invalid SDP format`: Answer SDP is malformed
  - `Session not found`: Session ID mismatch
  - `Unauthorized`: Auth token expired

### Step 2: Check Browser Console

**Look for these logs**:
```
📥 RENEGOTIATE RESPONSE RECEIVED:
   Response status: 200 (or error)
```

**If status is NOT 200**:
- The renegotiate call failed
- Cloudflare rejected the answer
- Media will NOT flow
- **This is why bytesReceived = 0**

### Step 3: Check Transceiver Directions

**Run in console**:
```javascript
const pc = peerConnectionRef.current;
pc.getTransceivers().forEach(t => {
    if (t.receiver?.track) {
        console.log({
            mid: t.mid,
            direction: t.direction, // Should be 'recvonly'
            currentDirection: t.currentDirection,
            receiverTrack: t.receiver.track.kind,
            senderTrack: t.sender.track?.kind // Should be null
        });
    }
});
```

**Expected**: All receiving transceivers should have:
- `direction: 'recvonly'`
- `senderTrack: null` (no sender track)

### Step 4: Check chrome://webrtc-internals

**After 2-3 seconds**:
1. Open `chrome://webrtc-internals`
2. Find your PeerConnection
3. Click **stats tables**
4. Look for `inbound-rtp`
5. Check `bytesReceived`:
   - ✅ **> 0**: Media is flowing (check video element)
   - ❌ **= 0**: SFU not sending (check renegotiate status)

## Most Likely Fix

**If renegotiate returns non-200 status**:

1. **Check Network Tab** → `PUT .../renegotiate` → Response tab
2. **Read error message**:
   - Invalid SDP → Check Answer SDP format
   - Session not found → Check session ID
   - Unauthorized → Refresh auth token
3. **Fix the error** and re-subscribe

**If renegotiate returns 200 but still 0 bytes**:

1. **Wait 2-3 seconds** (media needs time to start)
2. **Check `chrome://webrtc-internals`** → `inbound-rtp` → `bytesReceived`
3. **If still 0**: Check publisher status (is publisher sending?)
4. **If publisher is sending**: Set `ICE_TRANSPORT_POLICY` to `'relay'`

## Code Changes

### 1. Enhanced Renegotiate Service

**Location**: `src/services/sfuApiService.ts`

**Change**: Returns full response with status code:
```typescript
return {
    ...response.data,
    _axiosStatus: response.status, // Include status code
    _axiosHeaders: response.headers,
} as any;
```

### 2. Enhanced Logging in subscribeToExistingParticipants

**Location**: `src/views/SFUTest.tsx` lines ~2541-2625

**Added**:
- Pre-call logging (sessionId, SDP length, type)
- Post-call logging (status, full response)
- Error handling with detailed diagnostics

### 3. Delayed Stats Check

**Location**: `src/views/SFUTest.tsx` lines ~2070-2130

**Changed**: Stats check now waits 2 seconds:
```typescript
setTimeout(async () => {
    // Check stats after delay
}, 2000);
```

## Quick Fix Checklist

When you see "NO BYTES RECEIVED":

1. ✅ **Check Network Tab** → `PUT .../renegotiate` → Status
   - If NOT 200: **THIS IS THE PROBLEM** - fix the error
   - If 200: Continue to step 2

2. ✅ **Wait 2-3 seconds** and check `chrome://webrtc-internals`
   - If `bytesReceived > 0`: Media flowing (check video element)
   - If `bytesReceived = 0`: Continue to step 3

3. ✅ **Check transceiver directions** (run `diagnoseMutedTracks()`)
   - If NOT `recvonly`: Code should fix this automatically
   - If `recvonly`: Continue to step 4

4. ✅ **Check publisher status**
   - Is publisher sending? (check publisher logs)
   - If publisher stopped: That's the problem

5. ✅ **Try TURN relay mode**
   - Set `ICE_TRANSPORT_POLICY` to `'relay'` in `SFU_CONFIG`
   - Re-subscribe

## Expected Behavior After Fix

1. **Renegotiate call**:
   - ✅ Logs show: "ABOUT TO CALL: PUT /renegotiate"
   - ✅ Logs show: "RENEGOTIATE RESPONSE RECEIVED: status 200"
   - ✅ Network Tab shows: `PUT .../renegotiate` → Status 200 OK

2. **After 2 seconds**:
   - ✅ Stats check runs
   - ✅ Logs show: "Inbound RTP video: bytesReceived = X" (X > 0)
   - ✅ Tracks unmute automatically

3. **If still 0 bytes**:
   - ✅ Error message clearly indicates renegotiate failure
   - ✅ Instructions point to Network Tab
   - ✅ Common causes listed

## References

- [Cloudflare Realtime Examples](https://github.com/cloudflare/realtime-examples/tree/main)
- [WebRTC Stats API](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats)
- [Axios Response Structure](https://axios-http.com/docs/res_schema)
