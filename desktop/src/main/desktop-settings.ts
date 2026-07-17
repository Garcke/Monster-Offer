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
    fileSystem?: Pick<typeof fs, 'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'unlink'>;
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
            return {configured: false, baseUrl: null};
        }
    }

    public async loadConnection(): Promise<DesktopConnection | undefined> {
        let persisted: PersistedSettings | undefined;
        try {
            persisted = await this.readPersistedSettings();
        } catch (error) {
            if (error instanceof SettingsStorageError) {
                throw new Error(error.message);
            }
            await this.clearConnection();
            throw new Error('Stored desktop connection could not be decrypted');
        }
        if (!persisted) return undefined;

        let encryptionAvailable: boolean;
        try {
            encryptionAvailable = this.options.safeStorage.isEncryptionAvailable();
        } catch {
            throw new SettingsStorageError('Unable to check desktop connection encryption availability');
        }
        if (!encryptionAvailable) {
            throw new SettingsStorageError('Desktop connection encryption is unavailable');
        }

        try {
            const plaintext = this.options.safeStorage.decryptString(Buffer.from(persisted.encryptedConnection, 'base64'));
            const parsed: unknown = JSON.parse(plaintext);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SettingsCorruptionError();
            const candidate = parsed as Partial<DesktopConnection>;
            if (typeof candidate.baseUrl !== 'string' || typeof candidate.adminToken !== 'string' || !candidate.adminToken.trim()) {
                throw new SettingsCorruptionError();
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
            await this.fileSystem.mkdir(path.dirname(this.options.settingsPath), {recursive: true});
            await this.fileSystem.writeFile(this.temporaryPath, JSON.stringify(payload), {encoding: 'utf8', mode: 0o600});
            await this.fileSystem.rename(this.temporaryPath, this.options.settingsPath);
        } catch {
            await this.fileSystem.unlink(this.temporaryPath).catch(() => undefined);
            throw new Error('Unable to persist encrypted desktop connection');
        }
        return {configured: true, baseUrl};
    }

    public async clearConnection(): Promise<void> {
        await Promise.all([
            this.fileSystem.unlink(this.options.settingsPath).catch(() => undefined),
            this.fileSystem.unlink(this.temporaryPath).catch(() => undefined),
        ]);
    }

    private async readPersistedSettings(): Promise<PersistedSettings | undefined> {
        let raw: string;
        try {
            raw = await this.fileSystem.readFile(this.options.settingsPath, 'utf8');
        } catch (error: unknown) {
            if (isMissingFile(error)) return undefined;
            throw new SettingsStorageError('Unable to read desktop connection settings');
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SettingsCorruptionError();
            const candidate = parsed as Partial<PersistedSettings>;
            if (candidate.version !== 1 || typeof candidate.encryptedConnection !== 'string' || !candidate.encryptedConnection) {
                throw new SettingsCorruptionError();
            }
            return {version: 1, encryptedConnection: candidate.encryptedConnection};
        } catch (error) {
            if (error instanceof SettingsCorruptionError) throw error;
            throw new SettingsCorruptionError();
        }
    }

    private get fileSystem(): Pick<typeof fs, 'readFile' | 'writeFile' | 'mkdir' | 'rename' | 'unlink'> {
        return this.options.fileSystem ?? fs;
    }
}

class SettingsStorageError extends Error {}
class SettingsCorruptionError extends Error {}

function isMissingFile(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
