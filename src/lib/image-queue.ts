
/**
 * A simple request queue with concurrency limits and retry logic.
 */
export class RequestQueue {
    private queue: Array<() => Promise<void>> = [];
    private activeCount = 0;
    private maxConcurrency = 5; // Conservative limit for Drive
    private maxRetries = 3;

    constructor(maxConcurrency = 5) {
        this.maxConcurrency = maxConcurrency;
    }

    /**
     * Enqueues a task that returns a Promise.
     * @param task function that performs the fetch/async operation
     * @returns Promise resolving to the task result
     */
    add<T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const wrappedTask = async () => {
                let attempt = 0;
                while (attempt <= this.maxRetries) {
                    try {
                        const result = await task();
                        resolve(result);
                        return;
                    } catch (e: any) {
                        attempt++;
                        // Retry on 429 (Too Many Requests) or 5xx (Server Error)
                        if (attempt <= this.maxRetries && this.isRetryable(e)) {
                            const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000; // Exponential backoff + jitter
                            console.warn(`[RequestQueue] Retry ${attempt}/${this.maxRetries} after ${delay.toFixed(0)}ms due to:`, e.message);
                            await new Promise(r => setTimeout(r, delay));
                        } else {
                            reject(e);
                            return;
                        }
                    }
                }
            };
            
            this.queue.push(wrappedTask);
            this.process();
        });
    }

    private isRetryable(error: any): boolean {
        // Broad retry logic: typical fetch network errors or explicit status codes
        // If error object has 'status', check it.
        if (error.status === 429 || (error.status >= 500 && error.status < 600)) {
            return true;
        }
        // Also retry on network failures (TypeError: Failed to fetch)
        if (error.message && (error.message.includes("fetch") || error.message.includes("network"))) {
             return true;
        }
        // If we threw "Failed to load image: 429" string
        if (typeof error.message === 'string' && error.message.includes("429")) {
            return true;
        }
        
        return false;
    }

    private async process() {
        if (this.activeCount >= this.maxConcurrency || this.queue.length === 0) {
            return;
        }

        this.activeCount++;
        const task = this.queue.shift();

        if (task) {
            try {
                await task();
            } catch (e) {
                // Should have been handled by wrappedTask, but safety first
                console.error("[RequestQueue] Unhandled task error:", e);
            } finally {
                this.activeCount--;
                this.process(); // Trigger next
            }
        }
    }
}

// Global singleton
export const imageQueue = new RequestQueue(5);
