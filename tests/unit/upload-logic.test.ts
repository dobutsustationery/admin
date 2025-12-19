import { describe, it, expect } from 'vitest';
import { getUploadCandidates } from '../../src/lib/upload-logic';
import type { MediaItem } from '../../src/lib/google-photos';
import type { UploadState } from '../../src/lib/photos-slice';

// Mock minimal MediaItem
const mockPhoto = (id: string, baseUrl: string): MediaItem => ({
    id,
    baseUrl,
    productUrl: '',
    mimeType: '',
    filename: '',
    mediaMetadata: { width: '0', height: '0', creationTime: '' }
});

describe('getUploadCandidates', () => {
    const config = {
        maxRetries: 3,
        uploadTimeout: 60000 // 60s
    };
    const now = 1000000; // Fixed time

    it('should select items with no upload record', () => {
        const photos = [mockPhoto('p1', 'http://lh3.google.com/temp')];
        const uploads = {};
        
        const candidates = getUploadCandidates(photos, uploads, now, config);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].id).toBe('p1');
    });

    it('should skip items that are already permanent Drive links', () => {
        const photos = [mockPhoto('p1', 'https://drive.google.com/thumbnail?id=123')];
        const uploads = {};
        
        const candidates = getUploadCandidates(photos, uploads, now, config);
        expect(candidates).toHaveLength(0);
    });

    it('should skip items that are currently uploading within timeout', () => {
        const photos = [mockPhoto('p1', 'http://temp')];
        const uploads: Record<string, UploadState> = {
            'p1': { status: 'uploading', retryCount: 0, lastAttempt: now - 10000 } // 10s ago
        };

        const candidates = getUploadCandidates(photos, uploads, now, config);
        expect(candidates).toHaveLength(0);
    });

    it('should retry items that are uploading but timed out', () => {
        const photos = [mockPhoto('p1', 'http://temp')];
        const uploads: Record<string, UploadState> = {
            'p1': { status: 'uploading', retryCount: 0, lastAttempt: now - 61000 } // 61s ago
        };

        const candidates = getUploadCandidates(photos, uploads, now, config);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].id).toBe('p1');
    });

    it('should retry failed items if retry count is low', () => {
        const photos = [mockPhoto('p1', 'http://temp')];
        const uploads: Record<string, UploadState> = {
            'p1': { status: 'failed', retryCount: 2, lastAttempt: now - 1000 }
        };

        const candidates = getUploadCandidates(photos, uploads, now, config);
        expect(candidates).toHaveLength(1);
    });

    it('should skip failed items if retry count exceeded limit', () => {
        const photos = [mockPhoto('p1', 'http://temp')];
        const uploads: Record<string, UploadState> = {
            'p1': { status: 'failed', retryCount: 3, lastAttempt: now - 1000 }
        };

        const candidates = getUploadCandidates(photos, uploads, now, config);
        expect(candidates).toHaveLength(0);
    });

    it('should skip completed items', () => {
        const photos = [mockPhoto('p1', 'http://temp')];
        const uploads: Record<string, UploadState> = {
            'p1': { status: 'completed', retryCount: 0, lastAttempt: now - 500000 }
        };

        const candidates = getUploadCandidates(photos, uploads, now, config);
        expect(candidates).toHaveLength(0);
    });
});
