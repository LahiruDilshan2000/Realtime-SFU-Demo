import axios, {AxiosInstance} from 'axios';
import {API_CONFIG} from '../constants/api';
import type {
    JoinRequest,
    JoinResponse,
    PublishTracksRequest,
    PublishTracksResponse,
    PublishDataChannelsRequest,
    PublishDataChannelsResponse,
    SubscribeTracksRequest,
    SubscribeTracksResponse,
    SubscribeDataChannelsRequest,
    EstablishDataChannelsRequest,
    EstablishDataChannelsResponse,
    RenegotiateRequest,
    CloseTracksRequest,
    LeaveChatRequest,
    RoomInfoResponse,
    SessionStateResponse,
    ApiResponse,
    SessionDescription,
} from '../types/sfu';
import {Login} from "../types/sfu";

class SFUApiService {
    private api: AxiosInstance;
    private api_auth: AxiosInstance;

    constructor() {
        this.api = axios.create({
            baseURL: API_CONFIG.BASE_URL,
            headers: {
                'Content-Type': 'application/json',
                'Time-Zone': API_CONFIG.TIME_ZONE,
            },
        });

        this.api_auth = axios.create({
            baseURL: API_CONFIG.BASE_URL_AUTH,
            headers: {
                'USER-DOMAIN': "sharenest.io",
                'Content-Type': 'application/json',
                'Time-Zone': API_CONFIG.TIME_ZONE,
            },
        });

        // Add request interceptor to include auth token
        this.api.interceptors.request.use(
            (config) => {
                const token = this.getAuthToken();
                if (token) {
                    config.headers.Authorization = `Bearer ${token}`;
                }
                return config;
            },
            (error) => {
                return Promise.reject(error);
            }
        );
    }

    private getAuthToken(): string | null {
        if (typeof window !== 'undefined') {
            return localStorage.getItem(API_CONFIG.STORAGE_TOKEN_KEY);
        }
        return null;
    }

    setAuthToken(token: string): void {
        if (typeof window !== 'undefined') {
            localStorage.setItem(API_CONFIG.STORAGE_TOKEN_KEY, token);
        }
    }

    clearAuthToken(): void {
        if (typeof window !== 'undefined') {
            localStorage.removeItem(API_CONFIG.STORAGE_TOKEN_KEY);
        }
    }

    // 1. Get Room Information (Pre-Call)
    async getRoomInfo(roomToken: string): Promise<RoomInfoResponse> {
        const response = await this.api.get<RoomInfoResponse>(`/rooms/${roomToken}`);
        return response.data;
    }

    // 2. Join Room & Create SFU Session
    async joinRoom(roomToken: string, request: JoinRequest): Promise<JoinResponse> {
        const response = await this.api.post<JoinResponse>(`/rooms/${roomToken}/join`, request);
        return response.data;
    }

    // 2.5. Send Initial Offer (Establish Connection)
    // This is for the initial WebRTC connection (CREATED → CONNECTED)
    // POST /api/v1/talk/sfu/offer (as per user's documentation)
    async sendOffer(sessionId: string, offer: SessionDescription): Promise<ApiResponse<{
        sessionDescription: SessionDescription
    }>> {
        const response = await this.api.post<ApiResponse<{ sessionDescription: SessionDescription }>>(
            `/sfu/offer`,
            {
                sessionId,
                sdp: offer.sdp
            }
        );
        return response.data;
    }

    // 3. Publish Media Tracks
    async publishTracks(sessionId: string, request: PublishTracksRequest): Promise<PublishTracksResponse> {
        const response = await this.api.post<PublishTracksResponse>(
            `/sessions/${sessionId}/tracks/publish`,
            request
        );
        return response.data;
    }

    // 4a. Establish Data Channel Transport (call first, before publish/subscribe)
    async establishDataChannels(
        sessionId: string,
        request: EstablishDataChannelsRequest
    ): Promise<EstablishDataChannelsResponse> {
        const response = await this.api.post<EstablishDataChannelsResponse>(
            `/sessions/${sessionId}/data-channels/establish`,
            request
        );
        return response.data;
    }

    // 4b. Publish Data Channel (uses /datachannels/new, returns ID for negotiated channel)
    async publishDataChannels(
        sessionId: string,
        request: PublishDataChannelsRequest
    ): Promise<PublishDataChannelsResponse> {
        const response = await this.api.post<PublishDataChannelsResponse>(
            `/sessions/${sessionId}/data-channels/publish`,
            request
        );
        return response.data;
    }

    // 5. Subscribe to Remote Tracks
    async subscribeTracks(sessionId: string, request: SubscribeTracksRequest): Promise<SubscribeTracksResponse> {
        const response = await this.api.post<SubscribeTracksResponse>(
            `/sessions/${sessionId}/tracks/subscribe`,
            request
        );
        return response.data;
    }

    // 6. Subscribe to Data Channels (uses /datachannels/new, returns ID for negotiated channel)
    async subscribeDataChannels(
        sessionId: string,
        request: SubscribeDataChannelsRequest
    ): Promise<PublishDataChannelsResponse> {
        const response = await this.api.post<PublishDataChannelsResponse>(
            `/sessions/${sessionId}/data-channels/subscribe`,
            request
        );
        return response.data;
    }

    async auth(request: Login): Promise<ApiResponse> {
        const response = await this.api_auth.post<ApiResponse>(`/signin`, request);
        return response.data;
    }

    // 7. Renegotiate Session
    async renegotiate(sessionId: string, request: RenegotiateRequest): Promise<ApiResponse> {
        try {
            const response = await this.api.put<ApiResponse>(`/sessions/${sessionId}/renegotiate`, request);
            // CRITICAL: Return full response object so we can check status code
            return {
                ...response.data,
                _axiosStatus: response.status, // Include status code for verification
                _axiosHeaders: response.headers, // Include headers for debugging
            } as any;
        } catch (error: any) {
            // Axios throws error for non-2xx status codes
            console.error('❌ Renegotiate API call failed:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                message: error.message
            });
            throw error;
        }
    }

    // 8. Close Tracks
    async closeTracks(sessionId: string, request: CloseTracksRequest): Promise<ApiResponse> {
        const response = await this.api.put<ApiResponse>(`/sessions/${sessionId}/tracks/close`, request);
        return response.data;
    }

    // 9. Leave Room
    async leaveRoom(roomToken: string): Promise<ApiResponse> {
        const response = await this.api.post<ApiResponse>(`/rooms/${roomToken}/leave`);
        return response.data;
    }

    // 10. Get Session State
    async getSessionState(sessionId: string): Promise<SessionStateResponse> {
        const response = await this.api.get<SessionStateResponse>(`/sessions/${sessionId}`);
        return response.data;
    }

    // 11. Join Room for Chat-Only (No Media)
    async joinRoomForChat(roomToken: string, request: JoinRequest): Promise<JoinResponse> {
        const response = await this.api.post<JoinResponse>(`/rooms/${roomToken}/join-chat`, request);
        return response.data;
    }

    // 12. Leave Chat-Only Session (room-based; optional body)
    async leaveChat(roomToken: string, request?: LeaveChatRequest): Promise<ApiResponse> {
        const response = await this.api.post<ApiResponse>(
            `/rooms/${roomToken}/leave-chat`,
            request ?? {}
        );
        return response.data;
    }

    // 13. Leave Chat by Session (session-based; requires tracks + sessionDescription)
    async leaveChatSession(sessionId: string, request: {
        sessionDescription: { type: string; sdp: string };
        force: boolean;
        tracks: { mid: string }[]
    }): Promise<ApiResponse> {
        const response = await this.api.post<ApiResponse>(
            `/sessions/${sessionId}/leave-chat`,
            request
        );
        return response.data;
    }
}

export const sfuApiService = new SFUApiService();
export default sfuApiService;
