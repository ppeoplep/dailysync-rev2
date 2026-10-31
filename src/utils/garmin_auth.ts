import { getSessionFromDB, initDB, saveSessionToDB, updateSessionToDB } from './sqlite';
import {
    describeTokenExpiry,
    getSessionFromEnv,
    GarminSessionRegion,
    sessionEnvNames,
} from './garmin_session_env';

export type SessionSource = 'env' | 'db' | 'password';

type SessionClient = {
    loadToken(oauth1: Record<string, any>, oauth2: Record<string, any>): void;
    exportToken(): { oauth1: Record<string, any>; oauth2: Record<string, any> };
    login(username?: string, password?: string): Promise<any>;
};

export type GarminCredentials = {
    username: string;
    password: string;
};

const REGION_LABEL: Record<GarminSessionRegion, string> = {
    CN: 'GarminCN',
    GLOBAL: 'GarminGlobal',
};

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * 是否允许用账号密码登录。
 *
 * 佳明已经对 GitHub Actions 机房 IP 的密码登录返回 429（Rate limited），
 * 在 CI 里继续尝试密码登录只会把限流窗口不断延长，因此默认在 Actions 上禁用；
 * 本地 / Docker / 自建机器默认仍然允许（行为与改动前一致）。
 *
 * 需要临时放开时设置 GARMIN_ALLOW_PASSWORD_LOGIN=true（仓库 Variables 或 Secrets 均可）。
 */
export const isPasswordLoginAllowed = (): boolean => {
    const explicit = String(process.env.GARMIN_ALLOW_PASSWORD_LOGIN ?? '').trim().toLowerCase();
    if (explicit) {
        return TRUE_VALUES.has(explicit);
    }
    return process.env.GITHUB_ACTIONS !== 'true';
};

export const extractErrorMessage = (error: any): string => {
    if (!error) {
        return 'unknown error';
    }
    if (typeof error === 'string') {
        return error;
    }
    return String(error.message ?? error);
};

/** 佳明 SSO / API 的 429 限流 */
export const isRateLimited = (error: any): boolean =>
    /\(429\)|too many requests|rate limited/i.test(extractErrorMessage(error));

/** 会话令牌被拒（access/refresh 过期、刷新失败） */
export const isSessionRejected = (error: any): boolean =>
    /\((400|401|403)\)|no oauth2token|refresh/i.test(extractErrorMessage(error));

/**
 * 网络层失败：@gooin/garmin-connect 的响应拦截器在拿不到 HTTP 响应时，
 * 会先抛 TypeError（reading 'status'），把真实的 DNS/TLS/连接错误吞掉。
 */
export const isTransportFailure = (error: any): boolean =>
    /reading '(status|response|config)'|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNABORTED|socket hang up|UNABLE_TO_VERIFY|CERT_|self signed/i
        .test(extractErrorMessage(error));

/** 已经是「可照做」的认证错误，describeAuthFailure 不再二次包装 */
export class GarminAuthError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GarminAuthError';
    }
}

const missingSessionMessage = (region: GarminSessionRegion): string => {    const [oauth1EnvName, oauth2EnvName] = sessionEnvNames[region];
    return `${REGION_LABEL[region]} 没有可用会话：Secrets ${oauth1EnvName} / ${oauth2EnvName} 未配置或为空。`
        + 'GitHub Actions 已无法使用账号密码登录（佳明 SSO 返回 429），'
        + '请在本地执行 yarn bootstrap_sessions，再把输出的四项 OAuth 值写入仓库 Secrets。';
};

/**
 * 读取缓存会话；读不出来（AESKEY 变更、缓存损坏）时降级为「没有缓存」，不让整次运行卡在解密错误上。
 */
const readCachedSession = async (
    region: GarminSessionRegion,
    label: string,
): Promise<Record<string, any> | undefined> => {
    try {
        return await getSessionFromDB(region);
    } catch (error) {
        console.log(`[auth] ${label} 缓存会话不可用，将忽略它：${extractErrorMessage(error)}`);
        return undefined;
    }
};

/**
 * 按「Secrets 会话 → 缓存会话 → 账号密码」的顺序拿到可用会话。
 * 每一步都会打印来源与到期时间（不打印令牌内容），失败时抛出可直接照做的错误。
 */
export const acquireGarminSession = async (
    client: SessionClient,
    region: GarminSessionRegion,
    credentials: GarminCredentials,
): Promise<SessionSource> => {
    const label = REGION_LABEL[region];
    await initDB();

    // 1. Secrets 中导出的 OAuth 会话：Actions 上的正常路径
    const envSession = getSessionFromEnv(region);
    if (envSession) {
        client.loadToken(envSession.oauth1, envSession.oauth2);
        // 缓存读不出来（例如换过 AESKEY）不应该拦住可用的 Secrets 会话，直接覆盖即可
        const currentSession = await readCachedSession(region, label);
        if (currentSession) {
            await updateSessionToDB(region, client.exportToken());
        } else {
            await saveSessionToDB(region, client.exportToken());
        }
        console.log(`[auth] ${label} source=env（${describeTokenExpiry(envSession.oauth2)}）`);
        return 'env';
    }

    // 2. 上一次运行留下的会话（GitHub Actions 缓存里的 db/garmin.db）
    const cachedSession = await readCachedSession(region, label);
    if (cachedSession?.oauth1 && cachedSession?.oauth2) {
        client.loadToken(cachedSession.oauth1, cachedSession.oauth2);
        console.log(`[auth] ${label} source=db（${describeTokenExpiry(cachedSession.oauth2)}）`);
        return 'db';
    }

    // 3. 兜底：账号密码登录（Actions 上默认禁用）
    if (!isPasswordLoginAllowed()) {
        throw new GarminAuthError(missingSessionMessage(region));
    }

    console.log(`[auth] ${label} source=password 正在用账号密码登录`);
    await client.login(credentials.username, credentials.password);
    await saveSessionToDB(region, client.exportToken());
    console.log(`[auth] ${label} source=password 登录成功，会话已写入 db/garmin.db`);
    return 'password';
};

/**
 * 把底层报错翻译成能直接照做的提示，避免再出现「Cannot read properties of undefined」这类二次错误。
 */
export const describeAuthFailure = (error: any, region: GarminSessionRegion): string => {
    if (error instanceof GarminAuthError) {
        return error.message;
    }

    const label = REGION_LABEL[region];
    const [oauth1EnvName, oauth2EnvName] = sessionEnvNames[region];
    const message = extractErrorMessage(error);

    if (isRateLimited(error)) {
        return `${label} 登录被佳明限流（${message}）：GitHub Actions 的密码登录已被封锁，`
            + `请改为在本地执行 yarn bootstrap_sessions，并把 ${oauth1EnvName} / ${oauth2EnvName} 写入仓库 Secrets。`;
    }

    if (isSessionRejected(error)) {
        return `${label} 会话令牌已失效（${message}）：`
            + `请重新执行 yarn bootstrap_sessions 并更新 ${oauth1EnvName} / ${oauth2EnvName}。`;
    }

    if (isTransportFailure(error)) {
        return `${label} 请求佳明接口时网络层失败（${message}）：会话文件本身可能是有效的，`
            + '卡在 runner 到接口主机（connectapi.*）的连通性上，具体原因见上方 [net] 探测输出。';
    }

    return `${label} 登录失败：${message}`;
};
