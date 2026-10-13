import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.PORT || 8792);
const url = `http://127.0.0.1:${port}`;
const openPage = () => {
  console.log(`财报助手：${url}（关闭此窗口即可停止服务）`);
  if (process.platform === 'darwin') spawn('open', [url], {stdio:'ignore'}).on('error', () => {});
};
async function isOurApp() {
  try {
    const response = await fetch(`${url}/api/ai/status`, {signal:AbortSignal.timeout(1000)});
    const body = await response.json();
    return response.ok && body.billing === 'chatgpt-subscription' && body.label === 'GPT';
  } catch { return false; }
}
if (await isOurApp()) {
  openPage();
} else {
  const child = spawn(process.execPath, ['--use-env-proxy', 'server.mjs'], {
    cwd:new URL('..', import.meta.url), stdio:'inherit',
    env:{...process.env, HOST:'127.0.0.1', PORT:String(port)},
  });
  let exited = false;
  child.on('error', error => { console.error(error.message); process.exitCode = 1; exited = true; });
  child.on('exit', code => { exited = true; process.exitCode = code || 0; });
  for (let i = 0; i < 40 && !exited; i++) {
    if (await isOurApp()) { openPage(); break; }
    await delay(250);
    if (i === 39) { console.error('本机服务启动超时，请检查上方提示。'); child.kill(); process.exitCode = 1; }
  }
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
}
