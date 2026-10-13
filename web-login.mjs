import { randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { agentDir, AIError, createModelRuntime } from './ai-service.mjs';

export function createWebLogin({
  loadRuntime = createModelRuntime,
  secureCredentials = () => chmod(resolve(agentDir, 'auth.json'), 0o600),
  startTimeoutMs = 20000,
} = {}) {
  let active = null;
  const pending = job => job && ['starting', 'waiting'].includes(job.state);
  const snapshot = job => job ? {
    id:job.id, state:job.state,
    ...(job.state === 'waiting' ? {userCode:job.userCode, verificationUri:job.verificationUri, expiresAt:job.expiresAt} : {}),
    ...(job.error ? {message:job.error} : {}),
  } : {state:'idle'};

  function abort(job, message) {
    if (!pending(job)) return;
    job.state = 'cancelled'; job.error = message;
    clearTimeout(job.timer); job.controller.abort(); job.ready();
  }

  async function run(job) {
    try {
      const runtime = await loadRuntime();
      job.controller.signal.throwIfAborted();
      await runtime.login('openai-codex', 'oauth', {
        signal:job.controller.signal,
        async prompt(prompt) {
          if (prompt.type === 'select' && prompt.options.some(option => option.id === 'device_code')) return 'device_code';
          throw new Error('Device login unexpectedly requested terminal input.');
        },
        notify(event) {
          if (job.controller.signal.aborted || event.type !== 'device_code') return;
          const url = new URL(event.verificationUri);
          if (url.origin !== 'https://auth.openai.com' || url.pathname.replace(/\/$/, '') !== '/codex/device'
            || typeof event.userCode !== 'string' || !event.userCode.trim() || event.userCode.length > 64) {
            throw new Error('Invalid device authorization response.');
          }
          const expiresInMs = Math.min(Math.max(Number(event.expiresInSeconds) || 900, 1), 900) * 1000;
          job.state = 'waiting'; job.userCode = event.userCode;
          job.verificationUri = 'https://auth.openai.com/codex/device';
          job.expiresAt = Date.now() + expiresInMs;
          clearTimeout(job.timer);
          job.timer = setTimeout(() => abort(job, '登录码已过期，请重新登录。'), expiresInMs);
          job.timer.unref(); job.ready();
        },
      }, {agentName:'Accounting Playground'});
      job.controller.signal.throwIfAborted();
      await secureCredentials();
      job.state = 'authorized';
    } catch {
      if (!job.controller.signal.aborted) {
        job.state = 'error';
        job.error = '无法完成 ChatGPT 登录。请确认云端网络已放行 auth.openai.com 和 chatgpt.com，并在官方页面完成账户确认。';
      }
    } finally {
      clearTimeout(job.timer); job.ready();
      delete job.userCode; delete job.verificationUri;
    }
  }

  return {
    status() { return snapshot(active); },
    async start() {
      if (process.env.PI_PROVIDER && process.env.PI_PROVIDER !== 'openai-codex') {
        throw new AIError('login_unavailable', '当前服务固定了其他登录通道，请让服务管理员启用网页设备登录。', 503);
      }
      if (pending(active)) { await active.available; return snapshot(active); }
      const job = {id:randomUUID(), state:'starting', controller:new AbortController()};
      job.available = new Promise(resolve => { job.ready = resolve; });
      job.timer = setTimeout(() => abort(job, '获取登录码超时，请检查云端网络后重试。'), startTimeoutMs);
      job.timer.unref(); active = job;
      void run(job);
      await job.available;
      return snapshot(job);
    },
    cancel(id) {
      if (active && id !== active.id) throw new AIError('invalid_request', '登录请求已改变，请刷新后重试。', 409);
      abort(active, '已取消登录。');
      return snapshot(active);
    },
    close() { abort(active, '登录服务已关闭。'); },
  };
}
