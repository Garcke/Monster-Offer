import {promises as fs} from 'node:fs';
import path from 'node:path';

export interface SafeStorageLike {
    isEncryptionAvailable(): boolean;
    encryptString(plaintext: string): Buffer;
    decryptString(ciphertext: Buffer): string;
}

export interface DesktopConnection {
    baseUrl: string;
    adminToken: string;
}

export interface DesktopSettingsStatus {
    configured: boolean;
    baseUrl: string | null;
}

interface PersistedSettings {
    version: 1;
    encryptedConnection: string;
}

export interface DesktopSettingsStoreOptions {
    safeStorage: SafeStorageLike;
    settingsPath: string;
    production: boolean;
}

export function validateBackendUrl(value: string, production: boolean): URL {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Backend URL is required');

    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error('Backend URL must be an absolute HTTP(S) URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Backend URL must use HTTP or HTTPS');
    }
    if (url.username || url.password) throw new Error('Backend URL must not include credentials');
    if (url.search || url.hash) throw new Error('Backend URL must not include query or fragment data');
    if (production && url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        throw new Error('Production remote servers must use HTTPS');
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

export class DesktopSettingsStore {
    private readonly temporaryPath: string;

    public constructor(private readonly options: DesktopSettingsStoreOptions) {
        this.temporaryPath = `${options.settingsPath}.tmp`;
    }

    public async loadStatus(): Promise<DesktopSettingsStatus> {
        try {
            const connection = await this.loadConnection();
            return connection
                ? {configured: true, baseUrl: connection.baseUrl}
                : {configured: false, baseUrl: null};
        } catch {
            await this.clearConnection();
            return {configured: false, baseUrl: null};
        }
    }

    public async loadConnection(): Promise<DesktopConnection | undefined> {
        const persisted = await this.readPersistedSettings();
        if (!persisted) return undefined;
        if (!this.options.safeStorage.isEncryptionAvailable()) {
            throw new Error('Desktop connection encryption is unavailable');
        }
        try {
            const plaintext = this.options.safeStorage.decryptString(Buffer.from(persisted.encryptedConnection, 'base64'));
            const parsed: unknown = JSON.parse(plaintext);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid connection');
            const candidate = parsed as Partial<DesktopConnection>;
            if (typeof candidate.baseUrl !== 'string' || typeof candidate.adminToken !== 'string' || !candidate.adminToken.trim()) {
                throw new Error('invalid connection');
            }
            return {baseUrl: validateBackendUrl(candidate.baseUrl, this.options.production).href, adminToken: candidate.adminToken.trim()};
        } catch {
            await this.clearConnection();
            throw new Error('Stored desktop connection could not be decrypted');
        }
    }

    public async saveConnection(connection: DesktopConnection): Promise<DesktopSettingsStatus> {
        if (!this.options.safeStorage.isEncryptionAvailable()) {
            throw new Error('Desktop connection encryption is unavailable');
        }
        if (!connection || typeof connection.adminToken !== 'string' || !connection.adminToken.trim()) {
            throw new Error('An administrator token is required');
        }
        const baseUrl = validateBackendUrl(connection.baseUrl, this.options.production).href;
        const encryptedConnection = this.options.safeStorage.encryptString(JSON.stringify({
            baseUrl,
            adminToken: connection.adminToken.trim(),
        })).toString('base64');
        const payload: PersistedSettings = {version: 1, encryptedConnection};

        try {
            await fs.mkdir(path.dirname(this.options.settingsPath), {recursive: true});
            await fs.writeFile(this.temporaryPath, JSON.stringify(payload), {encoding: 'utf8', mode: 0o600});
            await fs.rename(this.temporaryPath, this.options.settingsPath);
        } catch {
            await fs.unlink(this.temporaryPath).catch(() => undefined);
            throw new Error('Unable to persist encrypted desktop connection');
        }
        return {configured: true, baseUrl};
    }

    public async clearConnection(): Promise<void> {
        await Promise.all([
            fs.unlink(this.options.settingsPath).catch(() => undefined),
            fs.unlink(this.temporaryPath).catch(() => undefined),
        ]);
    }

    private async readPersistedSettings(): Promise<PersistedSettings | undefined> {
        let raw: string;
        try {
            raw = await fs.readFile(this.options.settingsPath, 'utf8');
        } catch (error: unknown) {
            if (isMissingFile(error)) return undefined;
            throw new Error('Unable to read desktop connection settings');
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
            const candidate = parsed as Partial<PersistedSettings>;
            if (candidate.version !== 1 || typeof candidate.encryptedConnection !== 'string' || !candidate.encryptedConnection) {
                throw new Error('invalid');
            }
            return {version: 1, encryptedConnection: candidate.encryptedConnection};
        } catch {
            await this.clearConnection();
            throw new Error('Stored desktop connection is invalid');
        }
    }
}

function isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
