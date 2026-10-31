export type GarminSessionRegion = 'CN' | 'GLOBAL';

export type GarminSessionToken = {
    oauth1: Record<string, any>;
    oauth2: Record<string, any>;
};

export const sessionEnvNames: Record<GarminSessionRegion, [string, string]> = {
    CN: ['GARMIN_CN_OAUTH1', 'GARMIN_CN_OAUTH2'],
    GLOBAL: ['GARMIN_GLOBAL_OAUTH1', 'GARMIN_GLOBAL_OAUTH2'],
};

const parseSessionPart = (value: string): Record<string, any> => {
    const trimmedValue = value.trim();
    const jsonValue = trimmedValue.startsWith('base64:')
        ? Buffer.from(trimmedValue.slice('base64:'.length), 'base64').toString('utf8')
        : trimmedValue;
    return JSON.parse(jsonValue);
};

/**
 * 会话 Secret 是否已配置（只看是否存在，不校验内容，避免把令牌打进日志）
 */
export const hasSessionEnv = (region: GarminSessionRegion): boolean => {
    const [oauth1EnvName, oauth2EnvName] = sessionEnvNames[region];
    return Boolean(process.env[oauth1EnvName] && process.env[oauth2EnvName]);
};

export const getSessionFromEnv = (region: GarminSessionRegion): GarminSessionToken | undefined => {
    const [oauth1EnvName, oauth2EnvName] = sessionEnvNames[region];
    const oauth1Value = process.env[oauth1EnvName];
    const oauth2Value = process.env[oauth2EnvName];

    if (!oauth1Value || !oauth2Value) {
        return undefined;
    }

    try {
        return {
            oauth1: parseSessionPart(oauth1Value),
            oauth2: parseSessionPart(oauth2Value),
        };
    } catch (error) {
        throw new Error(`Garmin ${region} 会话 Secret 不是合法 JSON：${oauth1EnvName}, ${oauth2EnvName}`);
    }
};

const formatExpiry = (seconds: unknown): string => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return '未知';
    }
    const days = Math.round((seconds - Math.floor(Date.now() / 1000)) / 86400);
    const time = new Date(seconds * 1000).toISOString();
    return days <= 0 ? `已过期（${time}）` : `${time}，剩余 ${days} 天`;
};

/**
 * 令牌到期摘要。只输出时间，绝不输出令牌内容。
 */
export const describeTokenExpiry = (oauth2: Record<string, any> | undefined): string => {
    const accessExpiry = formatExpiry(oauth2?.expires_at);
    const refreshExpiry = formatExpiry(oauth2?.refresh_token_expires_at);
    return `access ${accessExpiry}；refresh ${refreshExpiry}`;
};
