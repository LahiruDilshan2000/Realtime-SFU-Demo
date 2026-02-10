/**
 * User must log in first; token in localStorage.
 * Join flow: get media, join room, publish video/audio/data channels.
 * After publish, connect WebSocket and send JOIN_ROOM with track info.
 * Backend broadcasts USER_JOINED (existing + new users) and USER_LEFT.
 * No presence data channel, no getRoomInfo polling.
 */
import {useRef, useState, useEffect} from 'react';
import {API_CONFIG} from '../constants/api';
import sfuApiService from '../services/sfuApiService';

const API_BASE = API_CONFIG.BASE_URL;
const AUTH_BASE = API_CONFIG.BASE_URL_AUTH;
const ROOM_ID = 'pmZYT4i4';
const STORAGE_KEY = API_CONFIG.STORAGE_TOKEN_KEY;
const MUTE_DATA_CHANNEL_NAME = 'mute-signal';
const CHAT_DATA_CHANNEL_NAME = 'chat';

function getHeader(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };
}

function getStoredToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(STORAGE_KEY);
}

function saveToken(token: string): void {
    if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, token);
    }
}

function clearToken(): void {
    if (typeof window !== 'undefined') {
        localStorage.removeItem(STORAGE_KEY);
    }
}

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

async function createCallsSession(
    token: string,
    withMedia: boolean
): Promise<string> {

    const res = await fetch(`${API_BASE}/rooms/${ROOM_ID}/join`, {
        method: 'POST',
        headers: getHeader(token),
        body: JSON.stringify({
            mediaConstraints: {video: withMedia, audio: withMedia},
        }),
    }).then((r) => r.json());
    return res.data.sessionId;
}

function createPeerConnection(): RTCPeerConnection {
    return new RTCPeerConnection({
        iceServers: [{urls: 'stun:stun.cloudflare.com:3478'}],
        bundlePolicy: 'max-bundle',
    });
}

export default function VideoCall() {
    const [token, setToken] = useState<string | null>(() => getStoredToken());
    const localVideoRef = useRef<HTMLVideoElement>(null);
    const remoteVideoRef = useRef<HTMLVideoElement>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [loginLoading, setLoginLoading] = useState(false);
    const [loginError, setLoginError] = useState<string | null>(null);
    const [inCall, setInCall] = useState(false);

    const mySessionIdRef = useRef<string | null>(null);
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const remoteSubscribedSessionIdRef = useRef<string | null>(null);
    const subscribedSessionIdsRef = useRef<Set<string>>(new Set());
    const localStreamRef = useRef<MediaStream | null>(null);
    const muteDataChannelRef = useRef<RTCDataChannel | null>(null);
    const chatDataChannelRef = useRef<RTCDataChannel | null>(null);
    const remotePeerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const roomWsRef = useRef<WebSocket | null>(null);
    const mutedRef = useRef(false);
    const chatMessagesEndRef = useRef<HTMLDivElement>(null);

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [muted, setMuted] = useState(false);
    const [remoteMuted, setRemoteMuted] = useState(false);
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
    const joinNotificationReadyRef = useRef(false);
    const chatDcOpenBeforeReadyRef = useRef(false);
    const [remoteParticipantDisplayName, setRemoteParticipantDisplayName] = useState('');

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

    function handleLogout() {
        clearToken();
        sfuApiService.clearAuthToken();
        setToken(null);
        setInCall(false);
        setError(null);
        mySessionIdRef.current = null;
        peerConnectionRef.current = null;
        remoteSubscribedSessionIdRef.current = null;
        localStreamRef.current = null;
        muteDataChannelRef.current = null;
        chatDataChannelRef.current = null;
        remotePeerConnectionRef.current = null;
        setRemoteMuted(false);
        setRemoteParticipantDisplayName('');
        setChatMessages([]);
        setChatInput('');
        const localVideo = localVideoRef.current;
        const remoteVideo = remoteVideoRef.current;
        if (localVideo?.srcObject) {
            (localVideo.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
            localVideo.srcObject = null;
        }
        if (remoteVideo?.srcObject) {
            remoteVideo.srcObject = null;
        }
    }

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

    async function handleLeaveRoom() {
        sendNotificationEvent('leave');
        doLeaveCleanup();
        try {
            await sfuApiService.leaveRoom(ROOM_ID);
        } catch (e) {
            console.warn('Leave room:', e);
        }
    }

    function doLeaveCleanup() {
        if (roomWsRef.current) {
            roomWsRef.current.close();
            roomWsRef.current = null;
        }
        remoteSubscribedSessionIdRef.current = null;
        subscribedSessionIdsRef.current.clear();
        const pc = peerConnectionRef.current;
        if (pc) {
            pc.close();
            peerConnectionRef.current = null;
        }
        mySessionIdRef.current = null;
        const localVideo = localVideoRef.current;
        const remoteVideo = remoteVideoRef.current;
        if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
        }
        if (localVideo?.srcObject) {
            localVideo.srcObject = null;
        }
        if (remoteVideo?.srcObject) {
            remoteVideo.srcObject = null;
        }
        setInCall(false);
        setMuted(false);
        setRemoteMuted(false);
        muteDataChannelRef.current = null;
        chatDataChannelRef.current = null;
        remotePeerConnectionRef.current = null;
        setChatMessages([]);
        setChatInput('');
        joinNotificationReadyRef.current = false;
        chatDcOpenBeforeReadyRef.current = false;
        setNotifications([]);
        setRemoteParticipantDisplayName('');
    }

    async function establishAndPublishMuteDataChannel(
        pc: RTCPeerConnection,
        sessionId: string
    ) {
        const response = await sfuApiService.publishDataChannels(sessionId, {
            dataChannels: [{location: 'local', dataChannelName: MUTE_DATA_CHANNEL_NAME}],
        });
        const channelId = response.data?.dataChannels?.[0]?.id;
        if (channelId == null) throw new Error('No data channel ID returned');
        const dc = pc.createDataChannel(MUTE_DATA_CHANNEL_NAME, {
            negotiated: true,
            id: channelId,
        });
        muteDataChannelRef.current = dc;
        dc.onopen = () => {
            try {
                dc.send(JSON.stringify({muted: mutedRef.current}));
            } catch (_) {
            }
        };
    }

    async function establishAndPublishChatDataChannel(
        pc: RTCPeerConnection,
        sessionId: string
    ) {
        const response = await sfuApiService.publishDataChannels(sessionId, {
            dataChannels: [{location: 'local', dataChannelName: CHAT_DATA_CHANNEL_NAME}],
        });
        const channelId = response.data?.dataChannels?.[0]?.id;
        if (channelId == null) throw new Error('No chat data channel ID returned');
        const dc = pc.createDataChannel(CHAT_DATA_CHANNEL_NAME, {
            negotiated: true,
            id: channelId,
        });
        chatDataChannelRef.current = dc;
        dc.onopen = () => {
            if (joinNotificationReadyRef.current) {
                sendJoinNotificationWhenReady();
            } else {
                chatDcOpenBeforeReadyRef.current = true;
            }
        };
    }

    function showNotification(message: string, type: 'join' | 'leave') {
        if (type === 'join') {
            console.log('[Notification] Showing user joined:', message);
        }
        const id = `notif-${Date.now()}-${Math.random()}`;
        setNotifications((prev) => [...prev, {id, message, type, timestamp: Date.now()}]);
        setTimeout(() => {
            setNotifications((prev) => prev.filter((n) => n.id !== id));
        }, 5000);
    }

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

    function sendJoinNotificationWhenReady() {
        const dc = chatDataChannelRef.current;
        if (!dc || dc.readyState !== 'open') return;
        sendNotificationEvent('join', 'User');
    }

    function connectRoomWebSocket() {
        const wsUrl = API_CONFIG.WS_ROOM_URL;
        if (!wsUrl) {
            console.warn('WS_ROOM_URL not configured');
            return;
        }
        const ws = new WebSocket(wsUrl);
        roomWsRef.current = ws;

        ws.onopen = () => {
            const mySessionId = mySessionIdRef.current;
            const videoTrack = localStreamRef.current?.getVideoTracks()[0]?.id ?? '';
            const audioTrack = localStreamRef.current?.getAudioTracks()[0]?.id ?? '';
            ws.send(JSON.stringify({
                type: 'JOIN_ROOM',
                roomToken: ROOM_ID,
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
                    const remoteVideo = remoteVideoRef.current;
                    if (!remoteVideo || subscribedSessionIdsRef.current.has(data.sessionId)) return;
                    subscribedSessionIdsRef.current.add(data.sessionId);
                    remoteSubscribedSessionIdRef.current = data.sessionId;
                    setRemoteParticipantDisplayName(data.userName ?? 'Remote');
                    const msg = data.userName ? `${data.userName} joined the call` : 'User joined the call';
                    showNotification(msg, 'join');
                    doRemoteUserFlow(
                        data.sessionId,
                        { audio: data.audioTrack, video: data.videoTrack },
                        remoteVideo
                    ).catch((e) => {
                        subscribedSessionIdsRef.current.delete(data.sessionId!);
                        remoteSubscribedSessionIdRef.current = null;
                        console.warn('Subscribe to user failed:', e);
                    });
                } else if (data.type === 'USER_LEFT') {
                    if (data.sessionId) {
                        subscribedSessionIdsRef.current.delete(data.sessionId);
                        if (remoteSubscribedSessionIdRef.current === data.sessionId) {
                            remoteSubscribedSessionIdRef.current = null;
                            setRemoteParticipantDisplayName('');
                            const remoteVideo = remoteVideoRef.current;
                            if (remoteVideo?.srcObject) {
                                (remoteVideo.srcObject as MediaStream).getTracks().forEach((t) => t.stop());
                                remoteVideo.srcObject = null;
                            }
                        }
                        showNotification('User left the call', 'leave');
                    }
                }
            } catch (e) {
                console.warn('WebSocket message parse error:', e);
            }
        };

        ws.onerror = () => console.warn('Room WebSocket error');
        ws.onclose = () => { roomWsRef.current = null; };
    }

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

    async function doRemoteUserFlow(
        otherSessionId: string,
        tracks: { audio?: string; video?: string; dataChannel?: string },
        remoteVideo: HTMLVideoElement
    ) {
        const tracksToPull: Array<{
            location: 'remote';
            sessionId: string;
            trackName: string;
        }> = [];
        if (tracks.audio) {
            tracksToPull.push({
                location: 'remote',
                sessionId: otherSessionId,
                trackName: tracks.audio,
            });
        }
        if (tracks.video) {
            tracksToPull.push({
                location: 'remote',
                sessionId: otherSessionId,
                trackName: tracks.video,
            });
        }
        if (tracksToPull.length === 0) return;

        if (!peerConnectionRef.current || !mySessionIdRef.current) return;
        const remotePeerConnection = peerConnectionRef.current;
        const mySessionId = mySessionIdRef.current;
        remotePeerConnectionRef.current = remotePeerConnection;

        const localSdp = remotePeerConnection.localDescription;
        if (!localSdp) throw new Error('Peer connection has no local description');
        const pullResponse = await sfuApiService.subscribeTracks(mySessionId, {
            tracks: tracksToPull,
            sessionDescription: {type: localSdp.type as 'offer' | 'answer', sdp: localSdp.sdp},
        });

        const resolvingTracks = Promise.all(
            pullResponse.data.tracks.map(
                ({mid}/*: { mid: string }*/) =>
                    new Promise<MediaStreamTrack>((res, rej) => {
                        setTimeout(
                            () => rej(new Error(`Track with mid ${mid} not received in time`)),
                            10000
                        );
                        console.log(mid)
                        const handleTrack = (e: RTCTrackEvent) => {
                            const {transceiver, track} = e;
                            console.log(transceiver.mid)
                            console.log(String(transceiver.mid) !== String(mid))
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
        const remoteVideoStream = new MediaStream();
        remoteVideo.srcObject = remoteVideoStream;
        pulledTracks.forEach((t) => remoteVideoStream.addTrack(t));

        const muteDcResponse = await sfuApiService.subscribeDataChannels(mySessionId, {
            dataChannels: [
                {
                    location: 'remote',
                    sessionId: otherSessionId,
                    dataChannelName: MUTE_DATA_CHANNEL_NAME,
                },
            ],
        });
        const muteChannelId = muteDcResponse.data?.dataChannels?.[0]?.id;
        if (muteChannelId != null) {
            const muteDc = remotePeerConnection.createDataChannel(`${MUTE_DATA_CHANNEL_NAME}-subscribed`, {
                negotiated: true,
                id: muteChannelId,
            });
            muteDc.onmessage = (ev: MessageEvent) => {
                try {
                    const {muted} = JSON.parse(ev.data as string) as { muted?: boolean };
                    if (typeof muted === 'boolean') setRemoteMuted(muted);
                } catch (_) {
                }
            };
        }

        const chatDcResponse = await sfuApiService.subscribeDataChannels(mySessionId, {
            dataChannels: [
                {
                    location: 'remote',
                    sessionId: otherSessionId,
                    dataChannelName: CHAT_DATA_CHANNEL_NAME,
                },
            ],
        });
        const chatChannelId = chatDcResponse.data?.dataChannels?.[0]?.id;
        if (chatChannelId != null) {
            const chatDc = remotePeerConnection.createDataChannel(`${CHAT_DATA_CHANNEL_NAME}-subscribed`, {
                negotiated: true,
                id: chatChannelId,
            });
            chatDc.onmessage = (ev: MessageEvent) => {
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

    }

    async function handleJoinCall() {
        const userToken = getStoredToken();
        if (!userToken) {
            setError('Not logged in');
            return;
        }

        const localVideo = localVideoRef.current;
        const remoteVideo = remoteVideoRef.current;
        if (!localVideo || !remoteVideo) return;

        setError(null);
        setLoading(true);
        remoteSubscribedSessionIdRef.current = null;

        try {
            const media = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: true,
            });
            localStreamRef.current = media;
            localVideo.srcObject = media;

            const mySessionId = await createCallsSession(userToken, true);
            // const joinRequest: JoinRequest = {
            //     mediaConstraints: {video: true, audio: true},
            // }
            // const mySessionId = await sfuApiService.joinRoom(ROOM_ID, joinRequest);
            mySessionIdRef.current = mySessionId;

            const localPeerConnection = createPeerConnection();
            peerConnectionRef.current = localPeerConnection;

            localPeerConnection.ondatachannel = (e: RTCDataChannelEvent) => {
                const ch = e.channel;
                if (ch.label === MUTE_DATA_CHANNEL_NAME) {
                    ch.onmessage = (ev: MessageEvent) => {
                        try {
                            const {muted} = JSON.parse(ev.data as string) as { muted?: boolean };
                            if (typeof muted === 'boolean') setRemoteMuted(muted);
                        } catch (_) {
                        }
                    };
                } else if (ch.label === CHAT_DATA_CHANNEL_NAME || ch.label === `${CHAT_DATA_CHANNEL_NAME}-subscribed`) {
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

            const transceivers = media.getTracks().map((track) =>
                localPeerConnection.addTransceiver(track, {direction: 'sendonly'})
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

            await establishAndPublishMuteDataChannel(
                localPeerConnection,
                mySessionId
            ).catch((e) => console.warn('Mute data channel setup:', e));

            await establishAndPublishChatDataChannel(
                localPeerConnection,
                mySessionId
            ).catch((e) => console.warn('Chat data channel setup:', e));

            joinNotificationReadyRef.current = true;
            if (chatDcOpenBeforeReadyRef.current) {
                await sendJoinNotificationWhenReady();
            }

            setInCall(true);

            connectRoomWebSocket();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

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
            <div className="flex justify-between items-center px-4 py-3 shrink-0">
                <h1 className="text-xl font-normal">Video Call</h1>
                <button
                    type="button"
                    onClick={handleLogout}
                    className="text-red-500 hover:text-red-400 text-sm font-medium transition-colors"
                >
                    Logout
                </button>
            </div>
            <div
                className={`grid gap-4 px-4 flex-1 ${chatOpen ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px] max-lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'} max-sm:grid-cols-1`}>
                <div className="relative">
                    <h2 className="text-base font-normal mb-2">Local stream</h2>
                    <div className="relative w-full bg-black rounded-lg">
                        <video
                            ref={localVideoRef}
                            autoPlay
                            playsInline
                            muted
                            className="w-full bg-black rounded-lg"
                        />
                        <span
                            className="absolute bottom-2 right-2 px-2 py-1 rounded text-xs font-medium bg-black/60 text-white">
                            You
                        </span>
                    </div>
                </div>
                <div className="relative">
                    <h2 className="text-base font-normal mb-2">Remote stream</h2>
                    <div className="relative w-full bg-black rounded-lg">
                        <video
                            ref={remoteVideoRef}
                            autoPlay
                            playsInline
                            className="w-full rounded-lg"
                        />
                        <span
                            className="absolute bottom-2 right-2 px-2 py-1 rounded text-xs font-medium bg-black/60 text-white">
                            {remoteParticipantDisplayName || 'Remote'}
                        </span>
                        {remoteMuted && (
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
                {chatOpen && (
                    <div className="max-lg:hidden flex flex-col bg-white/5 border border-white/10 rounded-lg h-[600px]">
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
            {error && <p className="text-red-500 px-4 text-sm">{error}</p>}
            {chatOpen && (
                <div className="lg:hidden fixed inset-0 z-50 bg-black/90 flex flex-col">
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
            )}
            <div className="flex justify-center items-center gap-2 py-4 px-4 shrink-0">
                {!inCall ? (
                    <button
                        type="button"
                        onClick={handleJoinCall}
                        disabled={loading}
                        className="rounded-full px-4 py-2 text-sm font-medium bg-green-600 text-white border border-green-600 hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                    >
                        {loading ? 'Joining…' : 'Join'}
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            onClick={handleMute}
                            className={`rounded-full px-4 py-2 text-sm font-medium border transition-colors ${
                                muted
                                    ? 'bg-red-500/20 border-red-400/50 text-red-400'
                                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                            }`}
                            title={muted ? 'Unmute' : 'Mute'}
                        >
                            {muted ? 'Unmute' : 'Mute'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setChatOpen(!chatOpen)}
                            className={`rounded-full px-4 py-2 text-sm font-medium border transition-colors ${
                                chatOpen
                                    ? 'bg-green-600/20 border-green-400/50 text-green-400'
                                    : 'bg-white/5 border-white/10 hover:bg-white/10'
                            }`}
                        >
                            Chat
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
