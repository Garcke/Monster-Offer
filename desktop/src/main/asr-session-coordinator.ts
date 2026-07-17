import type {AsrStatus} from '../shared/contracts';

export interface AsrSessionSender {
    postMessage(channel: string, message: unknown, transfer: unknown[]): void;
}

export interface AsrSessionPort {
    on(event: 'message', listener: (event: {data: unknown}) => void): void;
    start(): void;
    close(): void;
}

export interface AsrSessionCoordinatorOptions {
    isAuthorizedSender(sender: AsrSessionSender): boolean;
    loadConnection(): Promise<{baseUrl: string} | undefined>;
    createPort(): {input: AsrSessionPort; output: unknown};
    startRemote(baseUrl: string, sampleRate: number): Promise<AsrStatus>;
    writePcm(buffer: ArrayBuffer): void;
    onPortError(sender: AsrSessionSender): void;
    portChannel: string;
}

export class AsrSessionCoordinator {
    private owner: AsrSessionSender | null = null;
    private port: AsrSessionPort | null = null;

    public constructor(private readonly options: AsrSessionCoordinatorOptions) {}

    public isActive(): boolean {
        return this.owner !== null;
    }

    public getOwner(): AsrSessionSender | null {
        return this.owner;
    }

    public async start(sender: AsrSessionSender, sampleRate: number): Promise<AsrStatus> {
        if (!this.options.isAuthorizedSender(sender)) throw new Error('Unauthorized ASR request');
        const connection = await this.options.loadConnection();
        if (!this.options.isAuthorizedSender(sender)) throw new Error('Unauthorized ASR request');
        if (!connection) throw new Error('Remote server is not configured');
        if (this.isActive()) throw new Error('ASR is already active');

        try {
            const {input, output} = this.options.createPort();
            this.owner = sender;
            this.port = input;
            input.on('message', ({data}) => this.handlePortMessage(data));
            input.start();
            sender.postMessage(this.options.portChannel, null, [output]);
            return await this.options.startRemote(connection.baseUrl, sampleRate);
        } catch (error) {
            this.endSession();
            throw error;
        }
    }

    public endSession(): void {
        const port = this.port;
        this.port = null;
        this.owner = null;
        port?.close();
    }

    private handlePortMessage(data: unknown): void {
        if (!(data instanceof ArrayBuffer)) {
            this.failPort();
            return;
        }
        try {
            this.options.writePcm(data);
        } catch {
            this.failPort();
        }
    }

    private failPort(): void {
        const owner = this.owner;
        this.endSession();
        if (owner) this.options.onPortError(owner);
    }
}
