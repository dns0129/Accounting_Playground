import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentDir, createModelRuntime, provider } from '../ai-service.mjs';

const deviceLogin = process.argv.includes('--device');
const loginProvider = deviceLogin ? 'openai-codex' : provider;
if (!['openai', 'openai-codex'].includes(loginProvider)) throw new Error('只支持 ChatGPT 订阅登录。');
if (deviceLogin && process.env.PI_PROVIDER && process.env.PI_PROVIDER !== loginProvider) {
  throw new Error('设备授权使用 openai-codex；请移除 PI_PROVIDER 覆盖或将其设为 openai-codex。');
}
const runtime = await createModelRuntime({useShared:false});
const devicePath = resolve(agentDir, 'device-id');
let deviceId;
try { deviceId = (await readFile(devicePath, 'utf8')).trim(); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  deviceId = randomUUID();
  await writeFile(devicePath, deviceId, { mode: 0o600, flag: 'wx' });
}
const input = createInterface({ input: stdin, output: stdout });
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
console.log(deviceLogin
  ? '正在发起云端设备授权。获取设备码后，请在官方登录页确认；程序会自动保存授权，无需复制回调地址。'
  : '连接 ChatGPT 订阅。请在你自己的浏览器中完成授权；不要将授权码或令牌发到聊天里。');
try {
  await runtime.login(loginProvider, 'oauth', {
    signal: controller.signal,
    async prompt(prompt) {
      if (prompt.type === 'select') {
        if (deviceLogin) {
          if (prompt.options.some(option => option.id === 'device_code')) return 'device_code';
          throw new Error('此授权流程没有提供设备登录。');
        }
        console.log(prompt.message);
        prompt.options.forEach((option, i) => console.log(`${i + 1}. ${option.label}`));
        const answer = await input.question('选择编号（默认 1）：', { signal: prompt.signal || controller.signal });
        const selected = prompt.options[Number(answer || '1') - 1];
        if (!selected) throw new Error('选择编号无效。');
        return selected.id;
      }
      if (deviceLogin) throw new Error('设备授权意外要求终端输入，已停止。');
      return input.question(`${prompt.message}\n> `, { signal: prompt.signal || controller.signal });
    },
    notify(event) {
      if (event.type === 'auth_url') console.log(`${event.instructions || '请打开登录链接：'}\n${event.url}`);
      else if (event.type === 'device_code') console.log(`请打开 ${event.verificationUri} 并输入：${event.userCode}`);
      else if (event.message) console.log(event.message);
    },
  }, { getDeviceId: () => deviceId, agentName: 'Accounting Playground' });
  await chmod(resolve(agentDir, 'auth.json'), 0o600);
  console.log(`${loginProvider} 订阅登录已保存。回到网页点击「刷新连接」即可使用。`);
} catch {
  console.error(deviceLogin
    ? '设备登录未完成。请检查网络是否放行 auth.openai.com 和 chatgpt.com，以及是否在浏览器完成了账户确认。'
    : '登录未完成。请检查网络是否放行 auth.openai.com、api.openai.com；Codex 通道还需要 chatgpt.com。');
  process.exitCode = 1;
} finally { input.close(); }
