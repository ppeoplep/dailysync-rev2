import fs from 'fs';

const printSecret = (name: string, value: Record<string, any>) => {
    console.log(`${name}=${JSON.stringify(value)}`);
};

/**
 * 本地引导 OAuth 会话：用账号密码登录两区一次，把会话写入 db/garmin.db，
 * 并打印可以直接填入 GitHub Secrets 的四项值。
 *
 * 为什么需要它：佳明已经对 GitHub Actions 机房 IP 的密码登录返回 429，
 * CI 里只能使用从这里导出的会话来运行。
 */
const bootstrap = async () => {
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.error('bootstrap_sessions 只用于本地引导 OAuth 会话，不能在 GitHub Actions 里运行。');
        process.exit(1);
    }

    // bootstrap 的目的就是拿一次令牌，这里必须允许密码登录
    if (!process.env.GARMIN_ALLOW_PASSWORD_LOGIN) {
        process.env.GARMIN_ALLOW_PASSWORD_LOGIN = 'true';
    }

    const {
        GARMIN_USERNAME_DEFAULT: garminUsername,
        GARMIN_PASSWORD_DEFAULT: garminPassword,
        GARMIN_GLOBAL_USERNAME_DEFAULT: globalUsername,
        GARMIN_GLOBAL_PASSWORD_DEFAULT: globalPassword,
    } = require('./constant');

    const missing = [
        !garminUsername && 'GARMIN_USERNAME',
        !garminPassword && 'GARMIN_PASSWORD',
        !globalUsername && 'GARMIN_GLOBAL_USERNAME',
        !globalPassword && 'GARMIN_GLOBAL_PASSWORD',
    ].filter(Boolean);

    if (missing.length > 0) {
        console.error(`缺少账号配置：${missing.join(', ')}`);
        if (!fs.existsSync('.env')) {
            console.error('当前目录没有 .env：先执行 cp .env.example .env，按注释填写 4 个账号密码后重试。');
        } else {
            console.error('请在 .env 中补齐上面的变量后重试（注意不要给值加引号或分号）。');
        }
        process.exit(1);
    }

    const { getGaminCNClient } = require('./utils/garmin_cn');
    const { getGaminGlobalClient } = require('./utils/garmin_global');

    console.log('== 1/2 登录佳明中国区（connect.garmin.cn）==');
    const clientCN = await getGaminCNClient();

    console.log('== 2/2 登录佳明国际区（connect.garmin.com，需要能访问国际互联网）==');
    const clientGlobal = await getGaminGlobalClient();

    const cnToken = clientCN.exportToken();
    const globalToken = clientGlobal.exportToken();

    console.log('\n=== 把下面 4 行写入 GitHub → Settings → Secrets and variables → Actions ===');
    console.log('（只复制等号右侧内容，保留最外层 {}，不要复制变量名）\n');
    printSecret('GARMIN_CN_OAUTH1', cnToken.oauth1);
    printSecret('GARMIN_CN_OAUTH2', cnToken.oauth2);
    printSecret('GARMIN_GLOBAL_OAUTH1', globalToken.oauth1);
    printSecret('GARMIN_GLOBAL_OAUTH2', globalToken.oauth2);
    console.log('\n这些值等同于账号登录凭证：不要提交到仓库、不要截图外传。');
};

bootstrap().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
});
