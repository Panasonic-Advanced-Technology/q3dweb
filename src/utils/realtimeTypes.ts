export type ColorMode = 'FLAT' | 'I' | 'RGB';

export interface PointFieldJson {
    name: string;
    offset: number;
    datatype: number;
    count: number;
}

export interface DecodedCloudChunk {
    positions: Float32Array;
    values: Float32Array;
    rgb?: Uint8Array;
    maxAccumulatedPoints: number;
}

export interface PointCloud2Json {
    height: number;
    width: number;
    fields: PointFieldJson[];
    is_bigendian: boolean;
    point_step: number;
    row_step: number;
    data: string;
    is_dense: boolean;
}

export interface RosbridgePublishMessage {
    op?: string;
    topic?: string;
    msg?: unknown;
}

export interface RealtimeTopicOptions {
    topicName?: string;
    cloudTopicName?: string;
    odomTopicName?: string;
    gnss1TopicName?: string;
    gnss2TopicName?: string;
    maxPointsPerScan?: number;
    maxAccumulatedPoints?: number;
    autoFitOnFirstChunk?: boolean;
}

export interface OdomJson {
    pose?: {
        pose?: {
            position?: { x?: number; y?: number; z?: number };
            orientation?: { x?: number; y?: number; z?: number; w?: number };
        };
    };
}

export interface NavSatFixJson {
    status?: { status?: number; service?: number };
    latitude?: number;
    longitude?: number;
    altitude?: number;
}
