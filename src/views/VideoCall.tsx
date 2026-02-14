/**
 * Video Call - SFU-based WebRTC with WebSocket presence.
 * Flow: Login → Join room → Publish tracks → WebSocket JOIN_ROOM → Receive USER_JOINED/USER_LEFT.
 */
import {useRef, useState, useEffect, createRef} from 'react';
import {API_CONFIG} from '../constants/api';
import sfuApiService from '../services/sfuApiService';

const API_BASE = API_CONFIG.BASE_URL;
const AUTH_BASE = API_CONFIG.BASE_URL_AUTH;
const STORAGE_KEY = API_CONFIG.STORAGE_TOKEN_KEY;
const MUTE_DATA_CHANNEL_NAME = 'mute-signal';
const CHAT_DATA_CHANNEL_NAME = 'chat';

/**
 * Returns auth headers for API requests.
 * Step: Build object with Bearer token and JSON content-type.
 */
function getHeader(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
}

/** Returns JWT from localStorage, or null if not found / SSR. */
function getStoredToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
}

/** Saves JWT to localStorage. */
function saveToken(token: string): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, token);
    }
}

/** Removes JWT from localStorage. */
function clearToken(): void {
    if (typeof window !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
    }
}

/**
 * Signs in via auth API.
 * Steps: POST /signin → parse response → return token or throw.
 */
async function signIn(username: string, password: string): Promise<string> {
    const res = await fetch(`${AUTH_BASE}/signin`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'USER-DOMAIN': 'sharenest.io'},
        body: JSON.stringify({username, password}),
    }).then((r) => r.json());
    if (!res.token) {
        throw new Error(res.description || res.message || 'Login failed');
    }
    return res.token;
}

/**
 * Joins room and creates SFU session.
 * mediaConstraints: user-selected { video: boolean, audio: boolean }.
 */
async function createCallsSession(
    token: string,
    roomToken: string,
    mediaConstraints: { video: boolean; audio: boolean }
): Promise<string> {
    const res = await fetch(`${API_BASE}/rooms/${roomToken}/join`, {
        method: 'POST',
        headers: getHeader(token),
        body: JSON.stringify({ mediaConstraints }),
    }).then((r) => r.json());
    return res.data.sessionId;
}

/** Creates RTCPeerConnection with STUN and bundle policy. */
function createPeerConnection(): RTCPeerConnection {
    return new RTCPeerConnection({
        iceServers: [{urls: 'stun:stun.cloudflare.com:3478'}],
        bundlePolicy: 'max-bundle',
    });
}

interface RemoteParticipant {
    sessionId: string;
    displayName: string;
    muted: boolean;
    videoRef: React.RefObject<HTMLVideoElement>;
}

export default function VideoCall() {
    const [token, setToken] = useState<string | null>(() => getStoredToken());
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loginLoading, setLoginLoading] = useState(false);
    const [loginError, setLoginError] = useState<string | null>(null);
    const [inCall, setInCall] = useState(false);

    const mySessionIdRef = useRef<string | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const remotePeerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const subscribedSessionIdsRef = useRef<Set<string>>(new Set());
    const localStreamRef = useRef<MediaStream | null>(null);
    const muteDataChannelRef = useRef<RTCDataChannel | null>(null);
    const chatDataChannelRef = useRef<RTCDataChannel | null>(null);
    const roomWsRef = useRef<WebSocket | null>(null);
    const mutedRef = useRef(false);
    const chatMessagesEndRef = useRef<HTMLDivElement>(null);
    const remoteParticipantsRef = useRef<Map<string, RemoteParticipant>>(new Map());
    const remoteVideoRefsRef = useRef<Map<string, React.RefObject<HTMLVideoElement>>>(new Map());
    const subscriptionQueueRef = useRef<Array<{
        sessionId: string;
        displayName: string;
        tracks: { audio?: string; video?: string };
        videoRef: React.RefObject<HTMLVideoElement>;
    }>>([]);
    const isProcessingQueueRef = useRef(false);
    const subscriptionQueueDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [roomToken, setRoomToken] = useState('0GYwPJut');
    const [joinWithVideo, setJoinWithVideo] = useState(true);
    const [joinWithAudio, setJoinWithAudio] = useState(true);
    const [muted, setMuted] = useState(false);
    const [videoMuted, setVideoMuted] = useState(false);
    const [chatOpen, setChatOpen] = useState(false);
    const [chatMessages, setChatMessages] = useState<Array<{
        id: string;
        text: string;
        sender: 'me' | 'other';
        timestamp: number
    }>>([]);
    const [chatInput, setChatInput] = useState('');
    const [notifications, setNotifications] = useState<Array<{
        id: string;
        message: string;
        type: 'join' | 'leave';
        timestamp: number
    }>>([]);
    const [remoteParticipants, setRemoteParticipants] = useState<Map<string, RemoteParticipant>>(new Map());
    const joinNotificationReadyRef = useRef(false);
    const chatDcOpenBeforeReadyRef = useRef(false);
    const preJoinStreamRef = useRef<MediaStream | null>(null);
    const roomTokenRef = useRef<string>('');
    const streamHandedOffToCallRef = useRef(false);

    /** In-call: attach local stream to video element (new element mounts when switching views). */
    useEffect(() => {
        if (inCall && localVideoRef.current && localStreamRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
        }
    }, [inCall]);

    /** Pre-join: get user media for preview when logged in and not yet in call. */
    useEffect(() => {
        if (!token || inCall) return;
        streamHandedOffToCallRef.current = false;
        let stream: MediaStream | null = null;
        navigator.mediaDevices.getUserMedia({ audio: true, video: true })
            .then((s) => {
                stream = s;
                preJoinStreamRef.current = s;
                if (localVideoRef.current) localVideoRef.current.srcObject = s;
            })
            .catch((e) => console.warn('Pre-join media:', e));
        return () => {
            if (streamHandedOffToCallRef.current) return;
            stream?.getTracks().forEach((t) => t.stop());
            preJoinStreamRef.current = null;
            if (localVideoRef.current) localVideoRef.current.srcObject = null;
        };
    }, [token, inCall]);

    /**
     * Handles login form submit.
     * Steps: Prevent default → signIn → save token → set token state.
     */
    async function handleLogin(e: React.FormEvent) {
        e.preventDefault();
        setLoginError(null);
        setLoginLoading(true);
        try {
            const t = await signIn(username, password);
            saveToken(t);
            setToken(t);
        } catch (e) {
            setLoginError(e instanceof Error ? e.message : 'Login failed');
        } finally {
            setLoginLoading(false);
        }
    }

    /**
     * Handles logout.
     * Steps: Clear token → clear API auth → reset all refs/state → stop media tracks.
     */
    function handleLogout() {
        if (roomWsRef.current) {
            roomWsRef.current.close();
            roomWsRef.current = null;
        }
        clearToken();
        sfuApiService.clearAuthToken();
        setToken(null);
        setInCall(false);
        setError(null);
        mySessionIdRef.current = null;
        peerConnectionRef.current = null;
        localStreamRef.current = null;
        muteDataChannelRef.current = null;
        chatDataChannelRef.current = null;
        if (subscriptionQueueDebounceRef.current) {
            clearTimeout(subscriptionQueueDebounceRef.current);
            subscriptionQueueDebounceRef.current = null;
        }
        setChatMessages([]);
        setChatInput('');
        const localVideo = localVideoRef.current;
        if (localVideo?.srcObject) {
            (localVideo.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
            localVideo.srcObject = null;
        }
        // Clean up all remote participants
        remoteParticipantsRef.current.forEach((participant) => {
            const video = participant.videoRef.current;
            if (video?.srcObject) {
                (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
                video.srcObject = null;
            }
        });
        remoteParticipantsRef.current.clear();
        remoteVideoRefsRef.current.clear();
        subscriptionQueueRef.current = [];
        isProcessingQueueRef.current = false;
        setRemoteParticipants(new Map());
    }

    /**
     * Pre-join: toggles camera on/off. Stops the track when off (camera light goes off).
     */
    async function handlePreJoinCameraToggle() {
        const stream = preJoinStreamRef.current || localStreamRef.current;
        if (!stream) return;
        const videoTrack = stream.getVideoTracks()[0];
        if (joinWithVideo && videoTrack) {
            videoTrack.stop();
            stream.removeTrack(videoTrack);
            setJoinWithVideo(false);
        } else if (!joinWithVideo) {
            try {
                const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
                const newTrack = newStream.getVideoTracks()[0];
                stream.addTrack(newTrack);
                setJoinWithVideo(true);
            } catch (e) {
                console.warn('Could not turn camera on:', e);
            }
        }
    }

    /**
     * In-call: toggles local video (camera on/off).
     * When turning off: stops the video track to turn off the camera (camera light goes off).
     * When turning on: gets a new video track and replaces it in the stream and peer connection.
     */
    async function handleVideoMute() {
        const stream = localStreamRef.current;
        const pc = peerConnectionRef.current;
        if (!stream || !pc) return;
        const videoTrack = stream.getVideoTracks()[0];
        if (videoMuted) {
            // Turn camera ON: get new track, replace in stream and peer connection
            try {
                const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
                const newTrack = newStream.getVideoTracks()[0];
                if (videoTrack) stream.removeTrack(videoTrack);
                stream.addTrack(newTrack);
                const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
                if (videoSender) await videoSender.replaceTrack(newTrack);
                setVideoMuted(false);
            } catch (e) {
                console.warn('Could not turn camera on:', e);
            }
        } else if (videoTrack) {
            // Turn camera OFF: stop the track (turns off camera hardware, light goes off)
            videoTrack.stop();
            const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
            if (videoSender) await videoSender.replaceTrack(null);
            stream.removeTrack(videoTrack);
            setVideoMuted(true);
        }
    }

    /**
     * Toggles local audio mute.
     * Steps: Flip audioTrack.enabled → update state → send mute state over mute data channel.
     */
    function handleMute() {
        const stream = localStreamRef.current;
        if (!stream) return;
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            const newMuted = !audioTrack.enabled;
            mutedRef.current = newMuted;
            setMuted(newMuted);
            const dc = muteDataChannelRef.current;
            if (dc?.readyState === 'open') {
                try {
                    dc.send(JSON.stringify({muted: newMuted}));
                } catch (e) {
                    console.warn('Send mute state:', e);
                }
            }
        }
    }

    /**
     * Leaves chat gracefully.
     * Steps: Send leave notification → wait 300ms → leaveChatSession API → doLeaveCleanup.
     */
    async function handleLeaveChat() {
        const sessionId = mySessionIdRef.current;
        const pc = peerConnectionRef.current;
        if (!sessionId || !pc) return;
        sendNotificationEvent('leave');
        await new Promise((r) => setTimeout(r, 300));
        try {
            const transceivers = pc.getTransceivers();
            const tracks = transceivers
                .filter((t) => t.mid != null && t.sender.track)
                .map((t) => ({mid: t.mid!}));

            let sessionDescription: { type: string; sdp: string };
            if (pc.localDescription?.sdp) {
                sessionDescription = {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp,
                };
            } else {
                const offer = await pc.createOffer();
                // @ts-ignore
                sessionDescription = {type: offer.type, sdp: offer.sdp};
            }

            await sfuApiService.leaveChatSession(sessionId, {
                tracks,
                sessionDescription,
                force: false,
            });
        } catch (e) {
            console.warn('Leave chat:', e);
        }
        doLeaveCleanup();
    }

    /**
     * Leaves room.
     * Steps: Send leave notification → doLeaveCleanup → leaveRoom API.
     */
    async function handleLeaveRoom() {
        sendNotificationEvent('leave');
        doLeaveCleanup();
        try {
            await sfuApiService.leaveRoom(roomTokenRef.current);
        } catch (e) {
            console.warn('Leave room:', e);
        }
    }

    /**
     * Cleans up call state and resources.
     * Steps: Close WebSocket → clear refs → close peer connection → stop tracks → reset state.
     */
    function doLeaveCleanup() {
        streamHandedOffToCallRef.current = false;
        if (roomWsRef.current) {
            roomWsRef.current.close();
            roomWsRef.current = null;
        }
        subscribedSessionIdsRef.current.clear();
        const pc = peerConnectionRef.current;
        if (pc) {
            pc.close();
            peerConnectionRef.current = null;
        }
        mySessionIdRef.current = null;
        const localVideo = localVideoRef.current;
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
        }
        if (localVideo?.srcObject) {
            localVideo.srcObject = null;
        }
        // Clean up all remote participants
        remoteParticipantsRef.current.forEach((participant) => {
            const video = participant.videoRef.current;
            if (video?.srcObject) {
                (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
                video.srcObject = null;
            }
        });
        remoteParticipantsRef.current.clear();
        remoteVideoRefsRef.current.clear();
        subscriptionQueueRef.current = [];
        isProcessingQueueRef.current = false;
        if (subscriptionQueueDebounceRef.current) {
            clearTimeout(subscriptionQueueDebounceRef.current);
            subscriptionQueueDebounceRef.current = null;
        }
        setRemoteParticipants(new Map());
        setInCall(false);
        setMuted(false);
        setVideoMuted(false);
        muteDataChannelRef.current = null;
        chatDataChannelRef.current = null;
        setChatMessages([]);
        setChatInput('');
        joinNotificationReadyRef.current = false;
        chatDcOpenBeforeReadyRef.current = false;
        setNotifications([]);
    }

    /**
     * Publishes all data channels (mute + chat) to SFU in one API call.
     * Uses array in request; iterates response to create each negotiated DC and wire handlers.
     */
    async function establishAndPublishDataChannels(
        pc: RTCPeerConnection,
        sessionId: string
    ) {
        const response = await sfuApiService.publishDataChannels(sessionId, {
            dataChannels: [
                {location: 'local', dataChannelName: MUTE_DATA_CHANNEL_NAME},
                {location: 'local', dataChannelName: CHAT_DATA_CHANNEL_NAME},
            ],
        });
        const channels = response.data?.dataChannels ?? [];
        for (const info of channels) {
            const channelId = info.id;
            const name = info.dataChannelName;
            if (channelId == null) continue;
            const dc = pc.createDataChannel(name, {
                negotiated: true,
                id: channelId,
            });
            if (name === MUTE_DATA_CHANNEL_NAME) {
                muteDataChannelRef.current = dc;
                dc.onopen = () => {
                    try {
                        dc.send(JSON.stringify({muted: mutedRef.current}));
                    } catch (_) {}
                };
            } else if (name === CHAT_DATA_CHANNEL_NAME) {
                chatDataChannelRef.current = dc;
                dc.onopen = () => {
                    if (joinNotificationReadyRef.current) {
                        sendJoinNotificationWhenReady();
                    } else {
                        chatDcOpenBeforeReadyRef.current = true;
                    }
                };
            }
        }
    }

    /**
     * Shows toast notification (join/leave).
     * Steps: Add to state → auto-remove after 5s.
     */
    function showNotification(message: string, type: 'join' | 'leave') {
        const id = `notif-${Date.now()}-${Math.random()}`;
        setNotifications((prev) => [...prev, {id, message, type, timestamp: Date.now()}]);
        setTimeout(() => {
            setNotifications((prev) => prev.filter((n) => n.id !== id));
        }, 5000);
    }

    /**
     * Sends join/leave notification over chat data channel.
     * Steps: Build payload → send JSON if chat DC is open.
     */
    function sendNotificationEvent(event: 'join' | 'leave', displayName?: string) {
        const dc = chatDataChannelRef.current;
        if (dc?.readyState === 'open') {
            try {
                const payload: Record<string, unknown> = {
                    type: 'notification',
                    event,
                    timestamp: Date.now(),
                };
                if (displayName) payload.displayName = displayName;
                dc.send(JSON.stringify(payload));
            } catch (e) {
                console.warn('Send notification event:', e);
            }
        }
    }

    /**
     * Sends join notification when chat DC is open.
     * Called after publish or when chat DC opens (if ready).
     */
    function sendJoinNotificationWhenReady() {
        const dc = chatDataChannelRef.current;
        if (!dc || dc.readyState !== 'open') return;
        sendNotificationEvent('join', 'User');
    }

    /**
     * Connects to room WebSocket for presence.
     * Steps: Open WS → onopen send JOIN_ROOM with track info → onmessage handle USER_JOINED/USER_LEFT.
     * USER_JOINED: subscribe to that user (doRemoteUserFlow). USER_LEFT: cleanup remote.
     */
    function connectRoomWebSocket() {

        const userToken = getStoredToken();
        // const wsUrl = API_CONFIG.WS_ROOM_URL + `?token=${userToken}`;
        const wsUrl = `wss://test-service.sharenest.io/ws/room?token=${userToken}`;
        if (!wsUrl) {
            console.warn('WS_ROOM_URL not configured');
            return;
        }

        const ws = new WebSocket(wsUrl);
        roomWsRef.current = ws;

        ws.onopen = () => {
            const mySessionId = mySessionIdRef.current;
            const stream = localStreamRef.current;
            const videoTrack = stream?.getVideoTracks()[0]?.id ?? '';
            const audioTrack = stream?.getAudioTracks()[0]?.id ?? '';
            ws.send(JSON.stringify({
                type: 'JOIN_ROOM',
                roomToken: roomTokenRef.current,
                userId: mySessionId,
                userName: username || 'User',
                sessionId: mySessionId,
                videoTrack,
                audioTrack,
                dataChannel: MUTE_DATA_CHANNEL_NAME,
            }));
        };

        ws.onmessage = (event: MessageEvent) => {
            try {
                const data = JSON.parse(event.data as string) as {
                    type?: string;
                    userId?: string;
                    userName?: string;
                    sessionId?: string;
                    videoTrack?: string;
                    audioTrack?: string;
                    dataChannel?: string;
                };
                if (data.type === 'USER_JOINED' && data.sessionId && data.sessionId !== mySessionIdRef.current) {
                    if (subscribedSessionIdsRef.current.has(data.sessionId)) return;
                    subscribedSessionIdsRef.current.add(data.sessionId);

                    // Create a new video ref for this participant
                    const videoRef = createRef<HTMLVideoElement>();
                    remoteVideoRefsRef.current.set(data.sessionId, videoRef);

                    const displayName = data.userName ?? 'User';
                    const msg = `${displayName} joined the call`;
                    showNotification(msg, 'join');

                    // Create participant entry
                    const participant: RemoteParticipant = {
                        sessionId: data.sessionId,
                        displayName,
                        muted: false,
                        videoRef,
                    };
                    remoteParticipantsRef.current.set(data.sessionId, participant);
                    setRemoteParticipants(new Map(remoteParticipantsRef.current));

                    // Add to subscription queue instead of calling directly
                    subscriptionQueueRef.current.push({
                        sessionId: data.sessionId,
                        displayName,
                        tracks: { audio: data.audioTrack, video: data.videoTrack },
                        videoRef,
                    });

                    // Debounce processing so multiple USER_JOINED in quick succession get batched into one API call
                    if (subscriptionQueueDebounceRef.current) clearTimeout(subscriptionQueueDebounceRef.current);
                    subscriptionQueueDebounceRef.current = setTimeout(() => {
                        subscriptionQueueDebounceRef.current = null;
                        processSubscriptionQueue();
                    }, 50);
                } else if (data.type === 'USER_LEFT') {
                    if (data.sessionId) {
                        subscribedSessionIdsRef.current.delete(data.sessionId);
                        const participant = remoteParticipantsRef.current.get(data.sessionId);
                        if (participant) {
                            const video = participant.videoRef.current;
                            if (video?.srcObject) {
                                (video.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
                                video.srcObject = null;
                            }
                            remoteParticipantsRef.current.delete(data.sessionId);
                            remoteVideoRefsRef.current.delete(data.sessionId);
                            setRemoteParticipants(new Map(remoteParticipantsRef.current));
                            showNotification(`${participant.displayName} left the call`, 'leave');
                        }
                    }
                }
            } catch (e) {
                console.warn('WebSocket message parse error:', e);
            }
        };

        ws.onerror = () => console.warn('Room WebSocket error');
        ws.onclose = () => { roomWsRef.current = null; };
    }

    /**
     * Sends chat message.
     * Steps: Trim input → send over chat DC → add to local messages state.
     */
    function handleSendChatMessage() {
        if (!chatInput.trim() || !chatDataChannelRef.current) return;
        const message = chatInput.trim();
        const messageData = {
            type: 'chat',
            text: message,
            timestamp: Date.now(),
        };
        try {
            chatDataChannelRef.current.send(JSON.stringify(messageData));
            setChatMessages((prev) => [
                ...prev,
                {
                    id: `msg-${Date.now()}-${Math.random()}`,
                    text: message,
                    sender: 'me',
                    timestamp: Date.now(),
                },
            ]);
            setChatInput('');
        } catch (e) {
            console.warn('Send chat message:', e);
        }
    }

    /**
     * Processes the subscription queue in batch.
     * Drains all queued users at once, then one subscribeTracks + one subscribeDataChannels API call.
     * When multiple USER_JOINED arrive at once, all are subscribed in a single round-trip.
     */
    async function processSubscriptionQueue() {
        if (isProcessingQueueRef.current) return;
        if (subscriptionQueueRef.current.length === 0) return;

        isProcessingQueueRef.current = true;
        const batch = subscriptionQueueRef.current.splice(0, subscriptionQueueRef.current.length);

        try {
            await doBatchRemoteUsersFlow(batch);
        } catch (e) {
            console.warn('Batch subscribe failed:', e);
            for (const u of batch) {
                subscribedSessionIdsRef.current.delete(u.sessionId);
                remoteParticipantsRef.current.delete(u.sessionId);
                remoteVideoRefsRef.current.delete(u.sessionId);
            }
            setRemoteParticipants(new Map(remoteParticipantsRef.current));
        } finally {
            isProcessingQueueRef.current = false;
            // Process any users added while we were working (e.g. second USER_JOINED arrived during batch)
            if (subscriptionQueueRef.current.length > 0) {
                processSubscriptionQueue();
            }
        }
    }

    /**
     * Subscribes to multiple remote users in one API call each for tracks and data channels.
     * Uses arrays: one subscribeTracks with all tracks, one subscribeDataChannels with all data channels.
     * When multiple USER_JOINED arrive at once, response order matches request order.
     */
    async function doBatchRemoteUsersFlow(
        users: Array<{
            sessionId: string;
            displayName: string;
            tracks: { audio?: string; video?: string };
            videoRef: React.RefObject<HTMLVideoElement>;
        }>
    ) {
        const tracksToPull: Array<{ location: 'remote'; sessionId: string; trackName: string }> = [];
        const dataChannelsToSubscribe: Array<{
            location: 'remote';
            sessionId: string;
            dataChannelName: string;
        }> = [];

        for (const u of users) {
            if (u.tracks.audio) {
                tracksToPull.push({ location: 'remote', sessionId: u.sessionId, trackName: u.tracks.audio });
            }
            if (u.tracks.video) {
                tracksToPull.push({ location: 'remote', sessionId: u.sessionId, trackName: u.tracks.video });
            }
            dataChannelsToSubscribe.push(
                { location: 'remote', sessionId: u.sessionId, dataChannelName: MUTE_DATA_CHANNEL_NAME },
                { location: 'remote', sessionId: u.sessionId, dataChannelName: CHAT_DATA_CHANNEL_NAME }
            );
        }

        if (tracksToPull.length === 0) return;

        const remotePeerConnection = peerConnectionRef.current;
        const mySessionId = mySessionIdRef.current;
        if (!remotePeerConnection || !mySessionId) return;
        remotePeerConnectionRef.current = remotePeerConnection;

        const localSdp = remotePeerConnection.localDescription;
        if (!localSdp) throw new Error('Peer connection has no local description');

        // 1. Single subscribeTracks API with all users' tracks
        const pullResponse = await sfuApiService.subscribeTracks(mySessionId, {
            tracks: tracksToPull,
            // sessionDescription: { type: localSdp.type as 'offer' | 'answer', sdp: localSdp.sdp },
        });

        const resolvingTracks = Promise.all(
            pullResponse.data.tracks.map(
                ({mid}/*: { mid: string }*/) =>
                    new Promise<MediaStreamTrack>((res, rej) => {
                        setTimeout(
                            () => rej(new Error(`Track with mid ${mid} not received in time`)),
                            10000
                        );
                        const handleTrack = (e: RTCTrackEvent) => {
                            const {transceiver, track} = e;
                            if (String(transceiver.mid) !== String(mid)) return;
                            remotePeerConnection.removeEventListener('track', handleTrack);
                            res(track);
                        };
                        remotePeerConnection.addEventListener('track', handleTrack);
                    })
            )
        );

        if (pullResponse.data.requiresImmediateRenegotiation) {
            await remotePeerConnection.setRemoteDescription(
                pullResponse.data.sessionDescription
            );
            const remoteAnswer = await remotePeerConnection.createAnswer();
            await remotePeerConnection.setLocalDescription(remoteAnswer);
            const renegotiateResponse = await sfuApiService.renegotiate(mySessionId, {
                sessionDescription: {sdp: remoteAnswer.sdp, type: 'answer'},
            });
            if ((renegotiateResponse as { errorCode?: string; errorDescription?: string }).errorCode) {
                throw new Error((renegotiateResponse as { errorDescription?: string }).errorDescription);
            }
        }

        const pulledTracks = await resolvingTracks;
        const trackIndexToSessionId = tracksToPull.map((t) => t.sessionId);
        const userMap = new Map(users.map((u) => [u.sessionId, u]));

        const streamsBySession = new Map<string, MediaStream>();
        for (let i = 0; i < pulledTracks.length; i++) {
            const sessionId = trackIndexToSessionId[i];
            if (!streamsBySession.has(sessionId)) streamsBySession.set(sessionId, new MediaStream());
            streamsBySession.get(sessionId)!.addTrack(pulledTracks[i]);
        }

        for (const [sessionId, stream] of streamsBySession) {
            const u = userMap.get(sessionId);
            if (!u) continue;
            let videoElement = u.videoRef.current;
            let attempts = 0;
            while (!videoElement && attempts < 10) {
                await new Promise((r) => setTimeout(r, 100));
                videoElement = u.videoRef.current;
                attempts++;
            }
            if (videoElement) videoElement.srcObject = stream;
            else console.warn(`Video element not available for participant ${sessionId}`);
        }

        // 2. Single subscribeDataChannels API with all users' data channels
        const dcResponse = await sfuApiService.subscribeDataChannels(mySessionId, {
            dataChannels: dataChannelsToSubscribe,
        });
        const channels = dcResponse.data?.dataChannels ?? [];
        const dcIndexToMeta = dataChannelsToSubscribe.map((d) => ({ sessionId: d.sessionId, name: d.dataChannelName }));

        for (let i = 0; i < channels.length; i++) {
            const info = channels[i];
            const channelId = info.id;
            const meta = dcIndexToMeta[i];
            if (channelId == null || !meta) continue;
            const { sessionId: otherSessionId, name } = meta;
            const dc = remotePeerConnection.createDataChannel(`${name}-subscribed`, {
                negotiated: true,
                id: channelId,
            });
            if (name === MUTE_DATA_CHANNEL_NAME) {
                dc.onmessage = (ev: MessageEvent) => {
                    try {
                        const {muted} = JSON.parse(ev.data as string) as { muted?: boolean };
                        if (typeof muted === 'boolean') {
                            const participant = remoteParticipantsRef.current.get(otherSessionId);
                            if (participant) {
                                participant.muted = muted;
                                setRemoteParticipants(new Map(remoteParticipantsRef.current));
                            }
                        }
                    } catch (_) {}
                };
            } else if (name === CHAT_DATA_CHANNEL_NAME) {
                dc.onmessage = (ev: MessageEvent) => {
                    try {
                        const data = JSON.parse(ev.data as string) as {
                            type?: string;
                            text?: string;
                            event?: 'join' | 'leave';
                            timestamp?: number;
                            displayName?: string;
                        };
                        if (data.type === 'chat' && data.text) {
                            setChatMessages((prev) => [
                                ...prev,
                                {
                                    id: `msg-${data.timestamp || Date.now()}-${Math.random()}`,
                                    text: data.text!,
                                    sender: 'other',
                                    timestamp: data.timestamp || Date.now(),
                                },
                            ]);
                        } else if (data.type === 'notification' && data.event) {
                            if (data.event === 'join') {
                                const msg = data.displayName ? `${data.displayName} joined the call` : 'User joined the call';
                                showNotification(msg, 'join');
                            } else if (data.event === 'leave') {
                                const msg = data.displayName ? `${data.displayName} left the call` : 'User left the call';
                                showNotification(msg, 'leave');
                            }
                        }
                    } catch (_) {}
                };
            }
        }

    }

    /**
     * Joins the call.
     * Uses user-selected mediaConstraints (joinWithVideo, joinWithAudio).
     * Publishes only the tracks user selected.
     */
    async function handleJoinCall() {
        const userToken = getStoredToken();
        if (!userToken) {
            setError('Not logged in');
            return;
        }
        if (!roomToken.trim()) {
            setError('Enter a room code');
            return;
        }
        roomTokenRef.current = roomToken.trim();

        const localVideo = localVideoRef.current;
        if (!localVideo) return;

        const mediaConstraints = { video: joinWithVideo, audio: joinWithAudio };
        setError(null);
        setLoading(true);

        try {
            let media = preJoinStreamRef.current;
            if (!media) {
                media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            }
            localStreamRef.current = media;
            localVideo.srcObject = media;

            const mySessionId = await createCallsSession(userToken, roomTokenRef.current, mediaConstraints);
            mySessionIdRef.current = mySessionId;

            const localPeerConnection = createPeerConnection();
            peerConnectionRef.current = localPeerConnection;

            /**
             * Handles incoming data channels (chat from remote subscribers).
             * Chat: handle chat messages and join/leave notifications.
             * Note: Mute state is handled per-participant in doBatchRemoteUsersFlow.
             */
            localPeerConnection.ondatachannel = (e: RTCDataChannelEvent) => {
                const ch = e.channel;
                if (ch.label === CHAT_DATA_CHANNEL_NAME || ch.label === `${CHAT_DATA_CHANNEL_NAME}-subscribed`) {
                    ch.onmessage = (ev: MessageEvent) => {
                        try {
                            const data = JSON.parse(ev.data as string) as {
                                type?: string;
                                text?: string;
                                event?: 'join' | 'leave';
                                timestamp?: number;
                                displayName?: string;
                            };
                            if (data.type === 'chat' && data.text) {
                                setChatMessages((prev) => [
                                    ...prev,
                                    {
                                        id: `msg-${data.timestamp || Date.now()}-${Math.random()}`,
                                        text: data.text!,
                                        sender: 'other',
                                        timestamp: data.timestamp || Date.now(),
                                    },
                                ]);
                            } else if (data.type === 'notification' && data.event) {
                                if (data.event === 'join') {
                                    const msg = data.displayName ? `${data.displayName} joined the call` : 'User joined the call';
                                    showNotification(msg, 'join');
                                } else if (data.event === 'leave') {
                                    const msg = data.displayName ? `${data.displayName} left the call` : 'User left the call';
                                    showNotification(msg, 'leave');
                                }
                            }
                        } catch (_) {
                        }
                    };
                }
            };

            const tracksToPublish = media.getTracks().filter((t) =>
                (t.kind === 'audio' && joinWithAudio) || (t.kind === 'video' && joinWithVideo)
            );
            const transceivers = tracksToPublish.map((track) =>
                localPeerConnection.addTransceiver(track, { direction: 'sendonly' })
            );

            const localOffer = await localPeerConnection.createOffer();
            await localPeerConnection.setLocalDescription(localOffer);

            const pushTracksResponse = await fetch(
                `${API_BASE}/sessions/${mySessionId}/tracks/publish`,
                {
                    method: 'POST',
                    headers: getHeader(userToken),
                    body: JSON.stringify({
                        sessionDescription: {sdp: localOffer.sdp, type: 'offer'},
                        tracks: transceivers.map(({mid, sender}) => ({
                            location: 'local',
                            mid,
                            kind: sender.track?.kind,
                            trackName: sender.track?.id,
                        })),
                    }),
                }
            ).then((r) => r.json());


            const connected = new Promise<void>((res, rej) => {
                setTimeout(() => rej(new Error('ICE timeout')), 5000);
                const handler = () => {
                    if (localPeerConnection.iceConnectionState === 'connected') {
                        localPeerConnection.removeEventListener(
                            'iceconnectionstatechange',
                            handler
                        );
                        res();
                    }
                };
                localPeerConnection.addEventListener(
                    'iceconnectionstatechange',
                    handler
                );
            });

            await localPeerConnection.setRemoteDescription(
                new RTCSessionDescription(pushTracksResponse.data.sessionDescription)
            );
            await connected;

            await establishAndPublishDataChannels(
                localPeerConnection,
                mySessionId
            ).catch((e) => console.warn('Data channels setup:', e));

            joinNotificationReadyRef.current = true;
            if (chatDcOpenBeforeReadyRef.current) {
                await sendJoinNotificationWhenReady();
            }

            setMuted(!joinWithAudio);
            mutedRef.current = !joinWithAudio;
            setVideoMuted(!joinWithVideo);
            streamHandedOffToCallRef.current = true;
            setInCall(true);

            connectRoomWebSocket();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    /** Scroll chat to bottom when new messages arrive. */
    useEffect(() => {
        if (chatMessagesEndRef.current) {
            chatMessagesEndRef.current.scrollIntoView({behavior: 'smooth'});
        }
    }, [chatMessages]);

    if (!token) {
        return (
            <div className="max-w-sm mx-auto p-6">
                <h1 className="text-xl font-normal mb-4">Video Call</h1>
                <form onSubmit={handleLogin} className="space-y-3">
                    <input
                        type="text"
                        placeholder="Username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="w-full border rounded px-3 py-2"
                        required
                    />
                    <input
                        type="password"
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full border rounded px-3 py-2"
                        required
                    />
                    {loginError && <p className="text-red-600 text-sm">{loginError}</p>}
                    <button
                        type="submit"
                        disabled={loginLoading}
                        className="w-full bg-green-600 text-white rounded px-3 py-2 disabled:opacity-50"
                    >
                        {loginLoading ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>
            </div>
        );
    }

    return (
        <div className="flex flex-col min-h-screen relative">
            <div className="absolute top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm">
                {notifications.map((notif) => (
                    <div
                        key={notif.id}
                        className={`pointer-events-auto rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur-sm transition-all duration-300 ${
                            notif.type === 'join'
                                ? 'bg-green-600/95 text-white'
                                : 'bg-gray-700/95 text-white'
                        }`}
                    >
                        <div className="flex items-center gap-2">
                            {notif.type === 'join' ? (
                                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor"
                                     viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                          d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"/>
                                </svg>
                            ) : (
                                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor"
                                     viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                          d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                                </svg>
                            )}
                            <span>{notif.message}</span>
                        </div>
                    </div>
                ))}
            </div>
            <div className="flex justify-between items-center gap-3 px-4 py-3 shrink-0 border-b border-white/10">
                <h1 className="text-xl font-normal">Video Call</h1>
                <div className="flex items-center gap-2">
                    {!inCall && (
                        <input
                            id="room-token"
                            type="text"
                            value={roomToken}
                            onChange={(e) => setRoomToken(e.target.value)}
                            placeholder="Enter room code"
                            className="w-40 sm:w-52 min-w-[140px] bg-white border-2 border-gray-300 rounded-lg px-4 py-2 text-base text-gray-900 placeholder-gray-500 focus:outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/30 shadow-md"
                        />
                    )}
                    <button
                        type="button"
                        onClick={handleLogout}
                        className="text-red-500 hover:text-red-400 text-sm font-medium transition-colors shrink-0"
                    >
                        Logout
                    </button>
                </div>
            </div>

            {!inCall ? (
                <div className="flex-1 flex flex-col items-center justify-center px-4 gap-6 max-w-md mx-auto w-full">
                    <div className="w-full relative">
                        <div className="relative w-full bg-black rounded-xl aspect-video overflow-hidden">
                            <video
                                ref={localVideoRef}
                                autoPlay
                                playsInline
                                muted
                                className="w-full h-full object-cover"
                            />
                            {!joinWithVideo && (
                                <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                                    <span className="rounded-full bg-gray-700 p-4">
                                        <svg className="w-10 h-10 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                                        </svg>
                                    </span>
                                </div>
                            )}
                            <span className="absolute bottom-2 left-2 px-2 py-1 rounded text-xs font-medium bg-black/60 text-white">You</span>
                        </div>
                        <div className="flex justify-center gap-3 mt-3">
                            <button
                                type="button"
                                onClick={() => setJoinWithAudio(!joinWithAudio)}
                                className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors ${
                                    joinWithAudio
                                        ? 'bg-white/10 border border-white/20 hover:bg-white/15'
                                        : 'bg-red-500/20 border border-red-400/50 text-red-400'
                                }`}
                                title={joinWithAudio ? 'Mic on' : 'Mic off'}
                            >
                                {joinWithAudio ? (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
                                    </svg>
                                ) : (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
                                    </svg>
                                )}
                                {joinWithAudio ? 'Microphone' : 'Mic off'}
                            </button>
                            <button
                                type="button"
                                onClick={handlePreJoinCameraToggle}
                                className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors ${
                                    joinWithVideo
                                        ? 'bg-white/10 border border-white/20 hover:bg-white/15'
                                        : 'bg-red-500/20 border border-red-400/50 text-red-400'
                                }`}
                                title={joinWithVideo ? 'Camera on' : 'Camera off'}
                            >
                                {joinWithVideo ? (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M18 10.48V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4.48l4 3.98v-11l-4 3.98zm-2-.79V18H4V6h12v3.69z"/>
                                    </svg>
                                ) : (
                                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                        <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/>
                                    </svg>
                                )}
                                {joinWithVideo ? 'Camera' : 'Camera off'}
                            </button>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleJoinCall}
                        disabled={loading || !roomToken.trim()}
                        className="w-full rounded-full px-6 py-3 text-base font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                    >
                        {loading ? (
                            <>
                                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                                </svg>
                                Joining…
                            </>
                        ) : (
                            <>
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                                    <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
                                </svg>
                                Join now
                            </>
                        )}
                    </button>
                    {error && <p className="text-red-400 text-sm">{error}</p>}
                </div>
            ) : (
            <div className="flex-1 flex relative overflow-hidden">
                <div className={`flex-1 flex flex-col transition-all duration-300 ${chatOpen ? 'mr-0' : ''}`}>
                    <div className="flex-1 grid gap-4 p-4 relative" style={{
                        gridTemplateColumns: `repeat(auto-fit, minmax(280px, 1fr))`
                    }}>
                        {Array.from(remoteParticipants.values()).map((participant) => (
                            <div key={participant.sessionId} className="relative">
                                <h2 className="text-base font-normal mb-2">Remote stream</h2>
                                <div className="relative w-full bg-black rounded-lg aspect-video">
                                    <video
                                        ref={participant.videoRef}
                                        autoPlay
                                        playsInline
                                        className="w-full h-full rounded-lg object-cover"
                                    />
                                    <span
                                        className="absolute bottom-2 right-2 px-2 py-1 rounded text-xs font-medium bg-black/60 text-white">
                                        {participant.displayName}
                                    </span>
                                    {participant.muted && (
                                        <div
                                            className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-lg pointer-events-none"
                                            aria-hidden
                                        >
                                            <span className="rounded-full bg-red-500/90 p-2" title="Remote muted">
                                                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24"
                                                     aria-hidden>
                                                    <path
                                                        d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
                                                </svg>
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                        <div className="absolute bottom-4 left-4 z-30 w-40 h-28 sm:w-48 sm:h-32 rounded-lg overflow-hidden border-2 border-white/30 shadow-xl bg-black">
                            <video
                                ref={localVideoRef}
                                autoPlay
                                playsInline
                                muted
                                className="w-full h-full object-cover"
                            />
                            {(!joinWithVideo || videoMuted) && (
                                <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
                                    <span className="rounded-full bg-gray-700 p-2">
                                        <svg className="w-6 h-6 text-white/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                                        </svg>
                                    </span>
                                </div>
                            )}
                            <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded text-xs font-medium bg-black/60 text-white">You</span>
                        </div>
                    </div>
                </div>
                {chatOpen && (
                    <div className="absolute top-0 right-0 w-80 sm:w-96 h-full flex flex-col bg-gray-900/95 border-l border-white/10 shadow-xl z-40">
                        <div className="flex items-center justify-between p-3 border-b border-white/10">
                            <h3 className="text-sm font-medium">Chat</h3>
                            <button
                                type="button"
                                onClick={() => setChatOpen(false)}
                                className="text-white/60 hover:text-white"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                          d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-3 space-y-2">
                            {chatMessages.length === 0 ? (
                                <p className="text-white/40 text-sm text-center py-8">No messages yet</p>
                            ) : (
                                chatMessages.map((msg) => (
                                    <div
                                        key={msg.id}
                                        className={`flex ${msg.sender === 'me' ? 'justify-end' : 'justify-start'}`}
                                    >
                                        <div
                                            className={`max-w-[80%] rounded-lg px-3 py-2 ${
                                                msg.sender === 'me'
                                                    ? 'bg-green-600 text-white'
                                                    : 'bg-white/10 text-white'
                                            }`}
                                        >
                                            <p className="text-sm">{msg.text}</p>
                                            <p className={`text-xs mt-1 ${msg.sender === 'me' ? 'text-green-100' : 'text-white/60'}`}>
                                                {new Date(msg.timestamp).toLocaleTimeString([], {
                                                    hour: '2-digit',
                                                    minute: '2-digit'
                                                })}
                                            </p>
                                        </div>
                                    </div>
                                ))
                            )}
                            <div ref={chatMessagesEndRef}/>
                        </div>
                        <div className="p-3 border-t border-white/10">
                            <form
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    handleSendChatMessage();
                                }}
                                className="flex gap-2"
                            >
                                <input
                                    type="text"
                                    value={chatInput}
                                    onChange={(e) => setChatInput(e.target.value)}
                                    placeholder="Type a message..."
                                    className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/20"
                                />
                                <button
                                    type="submit"
                                    disabled={!chatInput.trim()}
                                    className="px-4 py-2 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    Send
                                </button>
                            </form>
                        </div>
                    </div>
                )}
            </div>
            )}
            {inCall && chatOpen && (
                <div className="lg:hidden fixed inset-0 z-50 bg-black/60 flex justify-end" onClick={() => setChatOpen(false)}>
                    <div className="w-full max-w-sm flex flex-col bg-gray-900 shadow-xl" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between p-4 border-b border-white/10">
                        <h3 className="text-lg font-medium">Chat</h3>
                        <button
                            type="button"
                            onClick={() => setChatOpen(false)}
                            className="text-white/60 hover:text-white"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                      d="M6 18L18 6M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-2">
                        {chatMessages.length === 0 ? (
                            <p className="text-white/40 text-sm text-center py-8">No messages yet</p>
                        ) : (
                            chatMessages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`flex ${msg.sender === 'me' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[80%] rounded-lg px-3 py-2 ${
                                            msg.sender === 'me'
                                                ? 'bg-green-600 text-white'
                                                : 'bg-white/10 text-white'
                                        }`}
                                    >
                                        <p className="text-sm">{msg.text}</p>
                                        <p className={`text-xs mt-1 ${msg.sender === 'me' ? 'text-green-100' : 'text-white/60'}`}>
                                            {new Date(msg.timestamp).toLocaleTimeString([], {
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            })}
                                        </p>
                                    </div>
                                </div>
                            ))
                        )}
                        <div ref={chatMessagesEndRef}/>
                    </div>
                    <div className="p-4 border-t border-white/10">
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                handleSendChatMessage();
                            }}
                            className="flex gap-2"
                        >
                            <input
                                type="text"
                                value={chatInput}
                                onChange={(e) => setChatInput(e.target.value)}
                                placeholder="Type a message..."
                                className="flex-1 bg-white/5 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-white/40 focus:outline-none focus:border-white/20"
                            />
                            <button
                                type="submit"
                                disabled={!chatInput.trim()}
                                className="px-4 py-2 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                Send
                            </button>
                        </form>
                    </div>
                    </div>
                </div>
            )}
            <div className="flex justify-center items-center gap-2 py-4 px-4 shrink-0">
                {inCall && (
                    <>
                        <button
                            type="button"
                            onClick={handleMute}
                            className={`rounded-full p-2.5 text-sm font-medium border transition-colors ${
                                muted
                                    ? 'bg-red-500/20 border-red-400/50 text-red-400'
                                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                            }`}
                            title={muted ? 'Unmute mic' : 'Mute mic'}
                        >
                            {muted ? (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg>
                            ) : (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
                            )}
                        </button>
                        {joinWithVideo && (
                        <button
                            type="button"
                            onClick={handleVideoMute}
                            className={`rounded-full p-2.5 text-sm font-medium border transition-colors ${
                                videoMuted
                                    ? 'bg-red-500/20 border-red-400/50 text-red-400'
                                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                            }`}
                            title={videoMuted ? 'Turn camera on' : 'Turn camera off'}
                        >
                            {videoMuted ? (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/></svg>
                            ) : (
                                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18 10.48V6c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4.48l4 3.98v-11l-4 3.98zm-2-.79V18H4V6h12v3.69z"/></svg>
                            )}
                        </button>
                        )}
                        <button
                            type="button"
                            onClick={() => setChatOpen(!chatOpen)}
                            className={`rounded-full p-2.5 text-sm font-medium border transition-colors ${
                                chatOpen
                                    ? 'bg-green-600/20 border-green-400/50 text-green-400'
                                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                            }`}
                            title="Chat"
                        >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                            </svg>
                        </button>
                        <button
                            type="button"
                            onClick={handleLeaveChat}
                            className="rounded-full px-4 py-2 text-sm font-medium border border-white/10 bg-white/5 hover:bg-white/10 transition-colors"
                        >
                            Leave chat
                        </button>
                        <button
                            type="button"
                            onClick={handleLeaveRoom}
                            className="rounded-full px-4 py-2 text-sm font-medium border border-red-400/40 bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
                        >
                            Leave room
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
