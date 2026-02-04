# TURN Server Configuration Fix

## Problem: No Relay Candidates Even With TURN Servers Configured

**Error**: `❌ ERROR: Forced relay mode but no relay candidates found!`

**Symptoms**:
- ✅ TURN servers are configured (5 servers)
- ✅ `ICE_TRANSPORT_POLICY` is set to `'relay'`
- ❌ No relay candidates in ICE gathering
- ❌ Tracks stay muted

## Root Cause Analysis

### Issue 1: Cloudflare Handles TURN Server-Side

**Important Discovery**: Cloudflare Calls API handles TURN infrastructure **server-side** through their SFU. The browser doesn't need to configure TURN servers directly - Cloudflare's SFU acts as the TURN relay.

**What This Means**:
- Cloudflare SFU receives media from publisher
- Cloudflare SFU relays media to subscriber
- Browser-to-SFU connection uses Cloudflare's TURN infrastructure automatically
- Custom TURN servers in browser config are only needed for **strict firewalls**

### Issue 2: TURN Servers May Be Blocked

If you configured TURN servers but still get no relay candidates:
1. **Firewall blocking TURN servers**: Even TCP connections to TURN servers might be blocked
2. **TURN server credentials wrong**: Free TURN servers may have changed credentials
3. **TURN servers rate-limited**: Free servers may have hit rate limits
4. **Timing issue**: Relay candidates take longer to gather (3-5 seconds)

## Solution Applied

### 1. Changed ICE_TRANSPORT_POLICY Back to 'all'

**Reason**: Cloudflare's SFU handles TURN server-side, so we don't need to force relay mode in the browser.

**File**: `src/constants/api.ts`

**Change**:
```typescript
// BEFORE:
ICE_TRANSPORT_POLICY: 'relay' as 'all' | 'relay',

// AFTER:
ICE_TRANSPORT_POLICY: 'all' as 'all' | 'relay', // Cloudflare handles TURN server-side
```

**Why This Works**:
- Cloudflare SFU acts as TURN relay automatically
- Browser can use direct connection when possible
- Falls back to Cloudflare's TURN when needed
- No need to configure custom TURN servers unless firewall blocks Cloudflare's TURN

### 2. Added Delayed Candidate Check

**Reason**: Relay candidates take longer to gather (3-5 seconds)

**Change**: Added 3-second delay before checking for relay candidates

**Location**: `src/views/SFUTest.tsx` lines ~3395-3440

### 3. Enhanced Diagnostics

**Added**:
- Detailed candidate type checking
- Count of relay/srflx candidates
- Better error messages with solutions

## Expected Behavior After Fix

### With ICE_TRANSPORT_POLICY: 'all':

1. **ICE Gathering**:
   ```
   🔍 ICE Gathering State: gathering
   🔍 ICE Gathering State: complete
   ```

2. **Candidates** (after 3 seconds):
   ```
   ICE Candidates gathered: {
     host: ✅,
     srflx: ✅ or ❌ (depends on NAT),
     relay: ✅ (Cloudflare provides via SFU)
   }
   ```

3. **Media Flow**:
   - Cloudflare SFU acts as TURN relay
   - Media flows: Publisher → Cloudflare SFU → Subscriber
   - Works even through firewalls (Cloudflare handles it)

## When to Use Custom TURN Servers

**Only use custom TURN servers if**:
- ✅ Cloudflare's TURN is blocked by firewall
- ✅ You're behind a very strict corporate firewall
- ✅ You need guaranteed TURN relay (not just fallback)

**How to Enable Custom TURN**:
1. Add TURN servers to `SFU_CONFIG.TURN_SERVERS`
2. Set `ICE_TRANSPORT_POLICY` to `'relay'`
3. Verify TURN servers are accessible from your network

## Testing Steps

### Step 1: Refresh Browser

**Important**: Configuration change requires new PeerConnection

1. **Refresh browser** (F5)
2. **Join room**
3. **Check logs**

### Step 2: Check ICE Candidates

**Look for logs** (after 3 seconds):
```
🔍 ICE Gathering State: complete
   ICE Candidates gathered: {
     host: ✅,
     srflx: ✅ or ❌,
     relay: ✅ (from Cloudflare SFU)
   }
```

**Expected**: Should have relay candidates (from Cloudflare SFU)

### Step 3: Check Media Flow

**After subscription**:
```
📊 Inbound RTP video: bytesReceived = X  (X > 0) ✅
📊 Inbound RTP audio: bytesReceived = Y  (Y > 0) ✅
```

**Expected**: `bytesReceived` should increase

## If Still No Relay Candidates

### Option 1: Use Cloudflare's TURN (Recommended)

**Keep `ICE_TRANSPORT_POLICY: 'all'`**:
- Cloudflare SFU handles TURN automatically
- No configuration needed
- Works through most firewalls

### Option 2: Add Working TURN Servers

**If Cloudflare's TURN is blocked**:

1. **Get TURN server credentials**:
   - Sign up for Metered.ca (free tier: 20 GB/month)
   - Or use Twilio TURN (free tier available)
   - Or use Xirsys (free tier available)

2. **Add to config**:
   ```typescript
   TURN_SERVERS: [
       {
           urls: 'turn:your-turn-server.com:3478',
           username: 'your-username',
           credential: 'your-credential'
       }
   ],
   ```

3. **Set policy**:
   ```typescript
   ICE_TRANSPORT_POLICY: 'relay',
   ```

4. **Test**: Refresh and check for relay candidates

## Summary

✅ **Changed**: `ICE_TRANSPORT_POLICY` back to `'all'` (Cloudflare handles TURN)
✅ **Added**: Delayed candidate check (3 seconds)
✅ **Enhanced**: Diagnostics for candidate gathering
✅ **Kept**: TURN servers as fallback (for strict firewalls)

**Expected**: Cloudflare SFU will provide TURN relay automatically, media should flow without custom TURN servers.

**If still not working**: Check if Cloudflare's TURN is blocked, then add custom TURN servers.
