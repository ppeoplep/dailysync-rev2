import dns from 'dns';
import https from 'https';
import { GarminSessionRegion } from './garmin_session_env';

const API_HOST: Record<GarminSessionRegion, string> = {
    CN: 'connectapi.garmin.cn',
    GLOBAL: 'connectapi.garmin.com',
};

const PROBE_PATH = '/userprofile-service/socialProfile';
const PROBE_TIMEOUT_MS = 15000;

/**
 * 给库内部的 axios 实例补上传输层配置。
 *
 * @gooin/garmin-connect 的 axios 默认没有超时、也不指定地址族；
 * connectapi.garmin.cn / .com 同时有 A 和 AAAA 记录，而 GitHub runner 的 IPv6 出网不可靠，
 * 强制 IPv4 可以避免连接被卡在不可达的 IPv6 地址上。
 */
export const hardenGarminTransport = (client: any, label: string): void => {
    const axiosInstance = client?.client?.client;
    if (!axiosInstance?.defaults) {
        console.log(`[net] ${label} 未取到库内部 axios 实例，跳过传输配置`);
        return;
    }

    axiosInstance.defaults.timeout = 30000;
    if (!axiosInstance.defaults.httpsAgent) {
        axiosInstance.defaults.httpsAgent = new https.Agent({ family: 4, keepAlive: true });
    }
    console.log(`[net] ${label} 传输配置：timeout=30s，强制 IPv4`);
};

const describeDns = async (host: string): Promise<string> => {
    const parts: string[] = [];
    for (const [type, resolve] of [['A', dns.promises.resolve4], ['AAAA', dns.promises.resolve6]] as const) {
        try {
            const addresses = await resolve(host);
            parts.push(`${type}: ${addresses.slice(0, 3).join(', ')}`);
        } catch (error) {
            parts.push(`${type}: 查询失败（${(error as any)?.code ?? error}）`);
        }
    }
    return parts.join(' | ');
};

const requestOnce = (host: string, family?: 4): Promise<string> => new Promise((resolve) => {
    const request = https.get(
        {
            host,
            path: PROBE_PATH,
            timeout: PROBE_TIMEOUT_MS,
            family,
            headers: { 'User-Agent': 'garmin-dailysync-connectivity-probe' },
        },
        (response) => {
            response.resume();
            resolve(`HTTP ${response.statusCode}`);
        },
    );
    request.on('timeout', () => {
        request.destroy();
        resolve(`超时（${PROBE_TIMEOUT_MS / 1000}s 内无响应）`);
    });
    request.on('error', (error: any) => resolve(`${error?.code ?? 'ERROR'}: ${error?.message ?? error}`));
});

/**
 * 只在认证/首个请求失败时调用：把「到底卡在哪」打出来，并返回摘要供失败注解复用。
 * 输出内容不含任何令牌，只是 DNS 解析结果和 HTTP 状态/错误码。
 */
export const probeGarminApiConnectivity = async (region: GarminSessionRegion): Promise<string> => {
    const host = API_HOST[region];
    const lines: string[] = [];
    const record = (line: string) => {
        lines.push(line);
        console.log(line);
    };

    try {
        record(`[net] 探测 ${region} 接口主机 ${host}`);
        record(`[net] DNS ${await describeDns(host)}`);
        record(`[net] 默认连接：${await requestOnce(host)}`);
        record(`[net] 仅 IPv4：${await requestOnce(host, 4)}`);
        record('[net] HTTP 401/403 表示网络与 TLS 正常（只是没带令牌）；超时 / ECONNRESET 表示 runner 到该主机被阻断。');
    } catch (error) {
        record(`[net] 探测本身出错：${(error as any)?.message ?? error}`);
    }

    return lines.join('\n');
};
