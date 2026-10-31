// Garmin 会话 Secret 诊断：只报告「是否存在 / 格式是否合法 / 剩余有效期」，绝不打印令牌内容。
//
// 背景：佳明已对 GitHub Actions 机房 IP 的密码登录返回 429，CI 只能使用
// 本地 `yarn bootstrap_sessions` 导出的 OAuth 会话。这个脚本让失败原因一眼可见。
//
// 这里始终以 0 退出：是否阻断任务由代码里的登录策略决定，避免同一套规则在两地各写一遍。

const definitions = [
    { name: 'GARMIN_CN_OAUTH1', kind: 'oauth1', region: '国区 CN' },
    { name: 'GARMIN_CN_OAUTH2', kind: 'oauth2', region: '国区 CN' },
    { name: 'GARMIN_GLOBAL_OAUTH1', kind: 'oauth1', region: '国际区 Global' },
    { name: 'GARMIN_GLOBAL_OAUTH2', kind: 'oauth2', region: '国际区 Global' },
];

const parsePart = (raw) => {
    const trimmed = String(raw).trim();
    const json = trimmed.startsWith('base64:')
        ? Buffer.from(trimmed.slice('base64:'.length), 'base64').toString('utf8')
        : trimmed;
    return JSON.parse(json);
};

const formatDays = (seconds) => {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return undefined;
    }
    const days = Math.round((seconds - Math.floor(Date.now() / 1000)) / 86400);
    const time = new Date(seconds * 1000).toISOString().slice(0, 10);
    return { days, time };
};

const describe = (definition) => {
    const raw = process.env[definition.name];
    if (!raw || !raw.trim()) {
        return { status: 'missing', text: '未配置' };
    }

    let token;
    try {
        token = parsePart(raw);
    } catch (error) {
        return { status: 'invalid', text: `不是合法 JSON（${error.message}）` };
    }

    if (definition.kind === 'oauth1') {
        const complete = Boolean(token?.oauth_token && token?.oauth_token_secret);
        return complete
            ? { status: 'ok', text: '已配置，oauth1 字段完整' }
            : { status: 'invalid', text: '已配置但缺少 oauth_token / oauth_token_secret' };
    }

    const complete = Boolean(token?.access_token && token?.refresh_token);
    if (!complete) {
        return { status: 'invalid', text: '已配置但缺少 access_token / refresh_token' };
    }

    const access = formatDays(token?.expires_at);
    const refresh = formatDays(token?.refresh_token_expires_at);
    const accessText = access ? `${access.time}（剩余 ${access.days} 天）` : '未提供';
    const refreshText = refresh ? `${refresh.time}（剩余 ${refresh.days} 天）` : '未提供';
    const expired = (refresh && refresh.days <= 0) || (access && access.days <= -30);
    return {
        status: expired ? 'expired' : 'ok',
        text: `已配置，access 到期 ${accessText}；refresh 到期 ${refreshText}`,
        refresh,
    };
};

const problems = [];
const results = definitions.map((definition) => {
    const result = describe(definition);
    const prefix = result.status === 'ok' ? '[ok]  ' : '[!!]  ';
    console.log(`${prefix}${definition.name.padEnd(22, ' ')}（${definition.region}）${result.text}`);

    if (result.status === 'missing') {
        problems.push(`${definition.name} 未配置`);
    } else if (result.status === 'invalid') {
        problems.push(`${definition.name} 格式异常：${result.text}`);
    } else if (result.status === 'expired') {
        problems.push(`${definition.name} 的 refresh token 已过期`);
    }
    return result;
});

const cnReady = results[0].status === 'ok' && results[1].status === 'ok';
const globalReady = results[2].status === 'ok' && results[3].status === 'ok';

console.log('');
if (!cnReady || !globalReady) {
    const regions = [!cnReady && '国区 CN', !globalReady && '国际区 Global'].filter(Boolean).join(' / ');
    console.log(`::warning::${regions} 缺少可用的 OAuth 会话 Secret：${problems.join('；') || '见上方输出'}`);
    console.log('::warning::GitHub Actions 上的密码登录已被佳明返回 429 封锁；请在本地执行 yarn bootstrap_sessions，把输出的四个值写入仓库 Secrets。');
} else {
    console.log('国区 CN / 国际区 Global 的 OAuth 会话 Secret 均已配置，本次运行将使用会话登录。');
}

const nearExpiry = results.find((result) => result.refresh && result.refresh.days <= 7 && result.refresh.days > 0);
if (nearExpiry) {
    console.log(`::warning::有会话的 refresh token 将在 ${nearExpiry.refresh.days} 天内过期，请尽快重新执行 yarn bootstrap_sessions 并更新 Secrets。`);
}
