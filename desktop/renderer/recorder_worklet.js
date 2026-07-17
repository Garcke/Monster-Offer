class PcmProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.targetSamples = Math.max(1, Math.round(sampleRate * 0.05));
        this.minimumSamples = Math.max(1, Math.round(sampleRate * 0.02));
        this.samples = [];
        this.sampleCount = 0;
        this.stopping = false;
        this.port.onmessage = (event) => {
            if (event.data?.event !== 'stop' || this.stopping) return;
            this.stopping = true;
            if (this.sampleCount >= this.minimumSamples) this._postAvailable(this.sampleCount);
            this.port.postMessage({event: 'stopped'});
        };
    }

    process(inputs) {
        if (this.stopping) return false;
        const input = inputs[0]?.[0];
        if (!input?.length) return true;
        this.samples.push(new Float32Array(input));
        this.sampleCount += input.length;
        while (this.sampleCount >= this.targetSamples) this._postAvailable(this.targetSamples);
        return true;
    }

    _postAvailable(length) {
        if (!length) return;
        const block = new Int16Array(length);
        let offset = 0;
        while (offset < length && this.samples.length) {
            const current = this.samples[0];
            const take = Math.min(length - offset, current.length);
            for (let index = 0; index < take; index += 1) {
                const sample = Math.max(-1, Math.min(1, current[index]));
                block[offset + index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            }
            offset += take;
            this.sampleCount -= take;
            if (take === current.length) this.samples.shift();
            else this.samples[0] = current.slice(take);
        }
        this.port.postMessage(block, [block.buffer]);
    }
}

registerProcessor('pcm-processor', PcmProcessor);
