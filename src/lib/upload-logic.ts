import type { MediaItem } from "$lib/google-photos";
import type { UploadState } from "$lib/photos-slice";

export interface UploadLogicConfig {
    maxRetries: number;
    uploadTimeout: number; // ms
}

export function getUploadCandidates(
    selectedPhotos: MediaItem[],
    uploads: Record<string, UploadState>,
    now: number,
    config: UploadLogicConfig
): MediaItem[] {
    return selectedPhotos.filter(p => {
        // 1. Skip if already permanent (drive.google.com)
        if (p.baseUrl && p.baseUrl.includes("drive.google.com")) return false;
        
        // Check upload state
        const status = uploads[p.id];
        
        // Case A: New (No status record) -> UPLOAD
        if (!status) return true;
        
        // Case B: Completed -> SKIP
        if (status.status === 'completed') return false;
        
        // Case C: Failed -> RETRY if under limit
        if (status.status === 'failed') {
            return status.retryCount < config.maxRetries;
        }
        
        // Case D: Uploading -> RETRY if timed out
        if (status.status === 'uploading') {
            const elapsed = now - status.lastAttempt;
            return elapsed > config.uploadTimeout;
        }
        
        // Case E: Pending -> Treat same as uploading? 
        // Or if it's 'pending' but not 'uploading', it might be waiting for worker.
        // If we strictly use 'uploading' for "worker picked it up", then 'pending' means "ready".
        // But our slice only sets 'uploading'. 
        // Let's assume 'pending' isn't effectively used yet or treats as new.
        if (status.status === 'pending') return true;
        
        return false;
    });
}
