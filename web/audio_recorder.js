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

    async connect(audioCallback) {
        this.audioCallback = audioCallback;
        this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000,
        });
        await this.audioContext.resume();

        this.stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                noiseSuppression: true,
                autoGainControl: true,
            },
        });
        this.currentSource = this.audioContext.createMediaStreamSource(this.stream);

        try {
            await this.audioContext.audioWorklet.addModule('recorder_worklet.js');
        } catch (error) {
            await this._cleanup();
            throw new Error(`AudioWorklet 加载失败: ${error.message || error}`);
        }

        this.processorNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
        this.processorNode.port.onmessage = (event) => {
            if (event.data instanceof Int16Array) {
                this.audioCallback?.(event.data, this.audioContext.sampleRate);
                return;
            }

            if (event.data?.event === 'stopped') {
                this._resolveStop();
            }
        };

        // A zero-gain output keeps the worklet active without playing microphone
        // audio back through the speakers.
        this.silentGain = this.audioContext.createGain();
        this.silentGain.gain.value = 0;
        this.currentSource.connect(this.processorNode);
        this.processorNode.connect(this.silentGain);
        this.silentGain.connect(this.audioContext.destination);
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

        if (this.audioContext && this.audioContext.state !== 'closed') {
            await this.audioContext.close();
        }
        this.audioContext = null;
    }
}

export default PCMAudioRecorder;
