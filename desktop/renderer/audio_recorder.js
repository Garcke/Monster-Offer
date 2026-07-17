class PCMAudioRecorder {
    constructor() {
        this.audioContext = null;
        this.stream = null;
        this.currentSource = null;
        this.processorNode = null;
        this.silentGain = null;
        this.audioCallback = null;
        this.stopResolver = null;
        this.stopTimer = null;
        this.stopPromise = null;
    }

    async prepare(audioCallback) {
        if (this.audioContext) throw new Error('录音器已经准备完成');
        this.audioCallback = audioCallback;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({sampleRate: 16000});
            await this.audioContext.resume();
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {channelCount: 1, noiseSuppression: true, autoGainControl: true},
            });
            this.currentSource = this.audioContext.createMediaStreamSource(this.stream);
            await this.audioContext.audioWorklet.addModule('recorder_worklet.js');
            this.processorNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
            this.processorNode.port.onmessage = (event) => this._handleWorkletMessage(event);
            this.silentGain = this.audioContext.createGain();
            this.silentGain.gain.value = 0;
            this.processorNode.connect(this.silentGain);
            this.silentGain.connect(this.audioContext.destination);
            return this.audioContext.sampleRate;
        } catch (error) {
            await this._cleanup();
            throw error;
        }
    }

    start() {
        if (!this.currentSource || !this.processorNode) throw new Error('录音器尚未准备');
        this.currentSource.connect(this.processorNode);
    }

    _handleWorkletMessage(event) {
        if (event.data instanceof Int16Array) {
            this.audioCallback?.(event.data);
            return;
        }
        if (event.data?.event === 'stopped') this._resolveStop();
    }

    async stop() {
        if (this.stopPromise) return this.stopPromise;
        this.stopPromise = this._stopAndCleanup();
        try {
            await this.stopPromise;
        } finally {
            this.stopPromise = null;
        }
    }

    async _stopAndCleanup() {
        if (this.processorNode) {
            await new Promise((resolve) => {
                this.stopResolver = resolve;
                this.stopTimer = window.setTimeout(() => this._resolveStop(), 1000);
                this.processorNode.port.postMessage({event: 'stop'});
            });
        }
        await this._cleanup();
    }

    _resolveStop() {
        if (this.stopTimer) {
            window.clearTimeout(this.stopTimer);
            this.stopTimer = null;
        }
        const resolve = this.stopResolver;
        this.stopResolver = null;
        resolve?.();
    }

    async _cleanup() {
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        this.currentSource?.disconnect();
        this.processorNode?.disconnect();
        this.silentGain?.disconnect();
        this.processorNode?.port.close();
        this.currentSource = null;
        this.processorNode = null;
        this.silentGain = null;
        this.audioCallback = null;
        if (this.audioContext && this.audioContext.state !== 'closed') await this.audioContext.close();
        this.audioContext = null;
    }
}

export default PCMAudioRecorder;
