class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = [];
        this.isStopped = false;
        this.targetSampleCount = Math.max(1, Math.round(sampleRate * 0.1));

        this.port.onmessage = (event) => {
            if (event.data?.event !== 'stop' || this.isStopped) return;
            this.isStopped = true;
            this._flushRemaining();
            this.port.postMessage({event: 'stopped'});
        };
    }

    _postSamples(values) {
        const pcmData = Int16Array.from(values);
        this.port.postMessage(pcmData, [pcmData.buffer]);
    }

    _flushRemaining() {
        if (!this.buffer.length) return;
        this._postSamples(this.buffer);
        this.buffer = [];
    }

    process(inputs) {
        if (this.isStopped) return false;

        const inputData = inputs[0]?.[0];
        if (!inputData) return true;

        for (let i = 0; i < inputData.length; i++) {
            const value = Math.max(-1, Math.min(1, inputData[i]));
            this.buffer.push(value < 0 ? Math.round(value * 32768) : Math.round(value * 32767));
        }

        while (this.buffer.length >= this.targetSampleCount) {
            this._postSamples(this.buffer.splice(0, this.targetSampleCount));
        }
        return true;
    }
}

registerProcessor('pcm-processor', PCMProcessor);
