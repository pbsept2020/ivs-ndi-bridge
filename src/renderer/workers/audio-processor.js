/**
 * AudioWorklet Processor for PCM extraction
 * 
 * Extracts raw PCM Float32 audio from MediaStream and sends to main thread.
 * Accumulates samples to reduce IPC overhead (128 samples per process() → 1024 batch)
 */

class PCMExtractor extends AudioWorkletProcessor {
    constructor() {
        super();
        
        // Accumulation buffer - NDI prefers larger chunks
        this.bufferSize = 1024;  // samples per channel before sending
        this.leftBuffer = new Float32Array(this.bufferSize);
        this.rightBuffer = new Float32Array(this.bufferSize);
        this.writeIndex = 0;
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        
        // No input connected
        if (!input || input.length === 0) {
            return true;
        }

        const leftChannel = input[0];
        const rightChannel = input.length > 1 ? input[1] : input[0]; // Mono → duplicate
        
        if (!leftChannel) {
            return true;
        }

        const samplesToProcess = leftChannel.length; // Usually 128
        
        // Copy samples to accumulation buffer
        for (let i = 0; i < samplesToProcess; i++) {
            this.leftBuffer[this.writeIndex] = leftChannel[i];
            this.rightBuffer[this.writeIndex] = rightChannel[i];
            this.writeIndex++;
            
            // Buffer full - send to main thread
            if (this.writeIndex >= this.bufferSize) {
                this.port.postMessage({
                    left: this.leftBuffer.slice(),   // Copy to avoid reference issues
                    right: this.rightBuffer.slice(),
                    sampleRate: sampleRate  // Global from AudioWorkletGlobalScope
                });
                this.writeIndex = 0;
            }
        }

        return true;  // Keep processor alive
    }
}

registerProcessor('pcm-extractor', PCMExtractor);
