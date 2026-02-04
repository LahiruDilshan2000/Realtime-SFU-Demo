/**
 * User must log in first; token in localStorage.
 * "Join call" runs only local flow (get media, join room, publish).
 * Room info is polled every 5s; when another in-call user with sessionId and
 * audio/video track names is found, remote subscribe flow runs.
 */
import {useRef, useState, useEffect} from 'react';
import {API_CONFIG} from '../constants/api';
import sfuApiService from '../services/sfuApiService';
import type {RoomInfoResponse} from '../types/sfu';

const API_BASE = API_CONFIG.BASE_URL;
const AUTH_BASE = API_CONFIG.BASE_URL_AUTH;
const ROOM_ID = 'pmZYT4i4';
const STORAGE_KEY = API_CONFIG.STORAGE_TOKEN_KEY;
const ROOM_POLL_INTERVAL_MS = 8000;

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

function findOtherInCallParticipant(
    roomInfo: RoomInfoResponse,
    mySessionId: string
) {
    const participants = roomInfo.data?.participants ?? [];
    return participants.find(
        (p) =>
            p.sessionId &&
            p.sessionId !== mySessionId &&
            p.isInCall &&
            (p.tracks?.audio || p.tracks?.video)
    );
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
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');

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
        if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current);
            pollIntervalRef.current = null;
        }
        clearToken();
        sfuApiService.clearAuthToken();
        setToken(null);
        setInCall(false);
        setError(null);
        mySessionIdRef.current = null;
        peerConnectionRef.current = null;
        remoteSubscribedSessionIdRef.current = null;
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

    async function doRemoteUserFlow(
        otherSessionId: string,
        tracks: { audio?: string; video?: string },
        token: string,
        remoteVideo: HTMLVideoElement,
        existingPC: RTCPeerConnection // Pass the PC from handleJoinCall
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


        /*        const mySessionId = mySessionIdRef.current;

                // 1. Tell the API we want to subscribe
                const pullResponse = await fetch(
                    `${API_BASE}/sessions/${mySessionId}/tracks/subscribe`,
                    {
                        method: 'POST',
                        headers: getHeader(token),
                        body: JSON.stringify({tracks: tracksToPull}),
                    }
                ).then((r) => r.json());

                // 2. Handle the Renegotiation Cloudflare requires
                if (pullResponse.data.requiresImmediateRenegotiation) {
                    await existingPC.setRemoteDescription(
                        new RTCSessionDescription(pullResponse.data.sessionDescription)
                    );

                    // Create an answer to the offer Cloudflare just gave us
                    const answer = await existingPC.createAnswer();
                    await existingPC.setLocalDescription(answer);

                    // Send the answer back
                    await fetch(`${API_BASE}/sessions/${mySessionId}/renegotiate`, {
                        method: 'PUT',
                        headers: getHeader(token),
                        body: JSON.stringify({
                            sessionDescription: {sdp: answer.sdp, type: 'answer'},
                        }),
                    });
                }
                console.log("---------------")
                console.log(existingPC)
                console.log(existingPC.ontrack)

                // 3. Listen for the tracks on the EXISTING PC
                existingPC.ontrack = (e) => {
                    console.log("🔥 Remote track received!", e.streams[0]);
                    if (remoteVideo.srcObject !== e.streams[0]) {
                        remoteVideo.srcObject = e.streams[0];
                    }
                };*/


        // const remotePeerConnection = createPeerConnection();
        if (!peerConnectionRef.current)
            throw new Error("RTC Peer null");
        const remotePeerConnection = peerConnectionRef.current;
        const mySessionId = mySessionIdRef.current;
        const pullResponse = await fetch(
            `${API_BASE}/sessions/${mySessionId}/tracks/subscribe`,
            {
                method: 'POST',
                headers: getHeader(token),
                body: JSON.stringify({tracks: tracksToPull}),
            }
        ).then((r) => r.json());
        const resolvingTracks = Promise.all(
            pullResponse.data.tracks.map(
                ({mid}: { mid: string }) =>
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
            const renegotiateResponse = await fetch(
                `${API_BASE}/sessions/${mySessionId}/renegotiate`,
                {
                    method: 'PUT',
                    headers: getHeader(token),
                    body: JSON.stringify({
                        sessionDescription: {
                            sdp: remoteAnswer.sdp,
                            type: 'answer'
                        },
                    }),
                }
            ).then((r) => r.json());
            if (renegotiateResponse.errorCode) {
                throw new Error(renegotiateResponse.errorDescription);
            }
        }

        const pulledTracks = await resolvingTracks;
        const remoteVideoStream = new MediaStream();
        remoteVideo.srcObject = remoteVideoStream;
        pulledTracks.forEach((t) => remoteVideoStream.addTrack(t));
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
            localVideo.srcObject = media;

            const mySessionId = await createCallsSession(userToken, true);
            mySessionIdRef.current = mySessionId;

            const localPeerConnection = createPeerConnection();
            peerConnectionRef.current = localPeerConnection;
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

            setInCall(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (!inCall) return;

        const poll = async () => {
            const mySessionId = mySessionIdRef.current;
            const remoteVideo = remoteVideoRef.current;
            const userToken = getStoredToken();
            if (
                !mySessionId ||
                !remoteVideo ||
                !userToken ||
                remoteSubscribedSessionIdRef.current
            ) {
                return;
            }

            try {
                const roomInfo = await sfuApiService.getRoomInfo(ROOM_ID);
                const other = findOtherInCallParticipant(roomInfo, mySessionId);
                if (!other?.sessionId || !other.tracks) return;
                if (remoteSubscribedSessionIdRef.current === other.sessionId) return;

                remoteSubscribedSessionIdRef.current = other.sessionId;
                await doRemoteUserFlow(
                    other.sessionId,
                    other.tracks,
                    userToken,
                    remoteVideo,
                    peerConnectionRef.current
                );
                if (pollIntervalRef.current) {
                    clearInterval(pollIntervalRef.current);
                    pollIntervalRef.current = null;
                }
            } catch {
                // ignore poll errors
            }
        };

        pollIntervalRef.current = setInterval(poll, ROOM_POLL_INTERVAL_MS);
        poll();

        return () => {
            if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
            }
        };
    }, [inCall]);

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
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 max-sm:grid-cols-1">
            <div className="col-span-full flex justify-between items-center">
                <h1 className="text-xl font-normal">Video Call</h1>
                <button
                    type="button"
                    onClick={handleLogout}
                    className="text-red-600 hover:underline text-sm"
                >
                    Logout
                </button>
            </div>
            <div className="col-span-full">
                <button
                    type="button"
                    onClick={handleJoinCall}
                    disabled={loading}
                    className="bg-green-600 text-white px-4 py-2 rounded disabled:opacity-50"
                >
                    {loading ? 'Joining…' : 'Join call'}
                </button>
            </div>
            <div>
                <h2 className="text-base font-normal mb-2">Local stream</h2>
                <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="w-full bg-black"
                />
            </div>
            <div>
                <h2 className="text-base font-normal mb-2">Remote stream</h2>
                <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="w-full bg-black"
                />
            </div>
            {error && <p className="text-red-600 col-span-full">{error}</p>}
        </div>
    );
}
