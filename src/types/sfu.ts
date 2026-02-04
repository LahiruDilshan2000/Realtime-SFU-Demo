// Type definitions for Cloudflare SFU API

export interface MediaConstraints {
  audio: boolean;
  video: boolean;
}

export interface SessionDescription {
  sdp: string;
  type: 'offer' | 'answer';
}

export interface Login {
  username: string;
  password: string;
}

export interface TrackObject {
  location: 'local' | 'remote';
  trackName?: string;
  kind?: 'video' | 'audio' | 'data';
  trackId?: string;
  sessionId?: string;
  mid?: string;
}

export interface DataChannelObject {
  location: 'local' | 'remote';
  dataChannelName?: string;
  sessionId?: string;
}

// Request Types
export interface JoinRequest {
  mediaConstraints: MediaConstraints;
}

export interface PublishTracksRequest {
  sessionDescription?: SessionDescription; // Optional - required for initial publish, optional for renegotiation
  tracks: TrackObject[];
  autoDiscover?: boolean;
}

export interface PublishDataChannelsRequest {
  dataChannels: DataChannelObject[]; // camelCase
}

export interface SubscribeTracksRequest {
  sessionDescription: SessionDescription; // Required: Current user's SDP offer
  tracks: Array<{
    location: 'remote';
    sessionId: string; // Other user's session ID
    trackName: string; // Track name (audio or video)
  }>;
}

export interface SubscribeDataChannelsRequest {
  dataChannels: DataChannelObject[]; // camelCase
}

export interface EstablishDataChannelRequest {
  dataChannel: {
    location: 'remote';
    dataChannelName: string;
  };
}

export interface RenegotiateRequest {
  sessionDescription: SessionDescription;
}

export interface CloseTracksRequest {
  tracks: Array<{ mid: string }>;
  sessionDescription: SessionDescription;
}

export interface LeaveChatRequest {
  tracks: Array<{ mid: string }>;
  sessionDescription: SessionDescription;
  force?: boolean;
}

// Response Types
export interface TrackInfo {
  trackId?: string;
  trackName: string;
  mid?: string;
}

export interface DataChannelInfo {
  dataChannelName: string;
  location: 'local' | 'remote';
  id?: number;
}

export interface MyTracks {
  video?: TrackInfo;
  audio?: TrackInfo;
  dataChannel?: TrackInfo;
  screen?: TrackInfo;
}

export interface ParticipantTracks {
  video?: string;
  audio?: string;
  dataChannel?: string;
  screen?: string;
}

export interface ParticipantTrackInfo {
  userId: string;
  sessionId: string;
  tracks: ParticipantTracks;
}

export interface JoinResponse {
  success: boolean;
  data: {
    sessionId: string;
    sdp: string;
    myTracks: MyTracks;
    existingParticipants: ParticipantTrackInfo[];
  };
}

export interface RoomInfoResponse {
  success: boolean;
  data: {
    roomToken: string;
    roomName: string;
    roomType: number;
    description?: string;
    participants: Array<{
      userId: string;
      displayName: string;
      avatar?: string;
      isInCall: boolean;
      tracks?: ParticipantTracks;
      sessionId?: string;
      joinedAt?: string;
    }>;
    totalParticipants: number;
    participantsInCall: number;
    roomSettings: {
      maxParticipants: number;
      recordingEnabled: boolean;
    };
    lastUpdated: string;
  };
}

export interface PublishTracksResponse {
  success: boolean;
  data: {
    requiresImmediateRenegotiation: boolean;
    tracks: TrackInfo[];
    sessionDescription: SessionDescription;
  };
}

export interface PublishDataChannelsResponse {
  success: boolean;
  data: {
    dataChannels: DataChannelInfo[];
  };
}

export interface SubscribeTracksResponse {
  success: boolean;
  data: {
    requiresImmediateRenegotiation: boolean;
    tracks: TrackInfo[];
    sessionDescription: SessionDescription;
  };
}

export interface SessionStateResponse {
  success: boolean;
  data: {
    tracks: Array<{
      location: 'local' | 'remote';
      mid?: string;
      trackName: string;
      sessionId?: string;
      status: string;
    }>;
  };
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  description?: string;
  error?: string;
}
