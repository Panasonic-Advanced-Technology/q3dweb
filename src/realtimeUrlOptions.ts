import type { RealtimeTopicOptions } from './utils/realtimeTypes';

export interface RealtimeUrlOptions extends RealtimeTopicOptions {
    rosbridgeUrl?: string;
}

function firstParam(params: URLSearchParams, names: readonly string[]): string | undefined {
    for (const name of names) {
        const value = params.get(name)?.trim();
        if (value) return value;
    }
    return undefined;
}

function positiveIntegerParam(params: URLSearchParams, names: readonly string[]): number | undefined {
    const value = firstParam(params, names);
    if (!value) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
}

export function parseRealtimeUrlOptions(params: URLSearchParams): RealtimeUrlOptions {
    return {
        rosbridgeUrl: firstParam(params, ['ros', 'rosbridge', 'rosbridgeUrl', 'rosUrl', 'ws']),
        cloudTopicName: firstParam(params, ['cloudTopic', 'cloud_topic', 'cloud', 'topic', 'topicName']),
        odomTopicName: firstParam(params, ['odomTopic', 'odom_topic', 'odom']),
        gnss1TopicName: firstParam(params, ['gnss1Topic', 'gnss1_topic', 'gnss1', 'fix1Topic', 'fix1', 'topic1']),
        gnss2TopicName: firstParam(params, ['gnss2Topic', 'gnss2_topic', 'gnss2', 'fix2Topic', 'fix2', 'topic2']),
        maxPointsPerScan: positiveIntegerParam(params, [
            'maxPointsPerScan',
            'max_points_per_scan',
            'maxScanPoints',
            'scanPoints',
        ]),
        maxAccumulatedPoints: positiveIntegerParam(params, [
            'maxAccumulatedPoints',
            'max_accumulated_points',
            'maxMapPoints',
            'mapPoints',
            'maxPoints',
        ]),
    };
}