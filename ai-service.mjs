import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';

export const projectDir = fileURLToPath(new URL('.', import.meta.url));
export const agentDir = resolve(process.env.PI_AGENT_DIR || resolve(projectDir, '.pi'));
export const provider = process.env.PI_PROVIDER || 'openai';
export const modelId = process.env.PI_MODEL || 'gpt-6.1-sol';

export class AIError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function parseModelJSON(text) {
  const content = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new AIError('invalid_json', 'AI 的回答不是有效的 JSON 对象，请再试一次。');
  }
}

export async function createModelRuntime() {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const runtime = await ModelRuntime.create({
    authPath: resolve(agentDir, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const source = runtime.getProvider(provider);
  if (!source?.auth.oauth) throw new Error('所选通道不支持 ChatGPT 订阅登录。');
  // Remove the API-key auth method as well as checking credential metadata. This also
  // prevents a concurrent logout from falling back to an ambient API key mid-request.
  runtime.registerNativeProvider({...source, auth:{oauth:source.auth.oauth}});
  return runtime;
}

export function createPiBackend({ loadRuntime = createModelRuntime, createSession = createAgentSession } = {}) {
  if (!['openai', 'openai-codex'].includes(provider)) {
    throw new Error('PI_PROVIDER 必须是 openai 或 openai-codex。');
  }

  async function context() {
    const runtime = await loadRuntime();
    const credentials = await runtime.listCredentials();
    // A headless device login uses the Codex subscription flow. Pick it automatically
    // when no provider override exists and the regular ChatGPT flow has no OAuth login.
    const selectedProvider = !process.env.PI_PROVIDER
      && !credentials.some(c => c.providerId === provider && c.type === 'oauth')
      && credentials.some(c => c.providerId === 'openai-codex' && c.type === 'oauth')
      ? 'openai-codex' : provider;
    // Only OAuth may use this app. An ambient OPENAI_API_KEY must never silently change billing.
    const configured = credentials.some(c => c.providerId === selectedProvider && c.type === 'oauth');
    const model = runtime.getModel(selectedProvider, modelId);
    return { runtime, configured, model, selectedProvider };
  }

  return {
    async status() {
      const { configured, model, selectedProvider } = await context();
      return {
        configured: configured && !!model,
        provider:selectedProvider, model: modelId, label: 'GPT', billing: 'chatgpt-subscription',
        message: !model ? '所选 GPT 模型不在 pi 的模型列表中。' : configured
          ? '已配置 ChatGPT 登录；实际可用性与额度由模型服务确认。'
          : '请先在云端完成 ChatGPT 登录，再刷新连接。',
      };
    },

    async sample(prompt, { signal }) {
      signal.throwIfAborted();
      const { runtime, configured, model } = await context();
      if (!configured) throw new AIError('not_authenticated', '云端尚未登录 ChatGPT，请完成登录后重试。', 503);
      if (!model) throw new AIError('model_unavailable', '所选 GPT 模型不可用，请检查云端模型配置。', 503);
      const settings = SettingsManager.inMemory({
        compaction: { enabled: false }, retry: { enabled: false },
        cacheWarming: 'off',
      });
      const loader = new DefaultResourceLoader({
        cwd: projectDir, agentDir, settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true,
        noThemes: true, noContextFiles: true,
        systemPromptOverride: () => 'You are an IFRS accounting tutor. Follow the requested JSON schema. Return one JSON object and no other text. Do not call tools.',
      });
      await loader.reload();
      signal.throwIfAborted();
      const { session } = await createSession({
        cwd: projectDir, agentDir, modelRuntime: runtime, model,
        tools: [], noTools: 'all', thinkingLevel: 'low',
        resourceLoader: loader, settingsManager: settings,
        sessionManager: SessionManager.inMemory(),
      });
      const abort = () => { void session.abort().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        await session.prompt(prompt);
        signal.throwIfAborted();
        const reply = [...session.messages].reverse().find(m => m.role === 'assistant');
        if (!reply || reply.stopReason === 'error' || reply.stopReason === 'aborted') {
          const detail = reply?.errorMessage || '';
          if (/429|rate.limit|quota|usage.limit/i.test(detail)) {
            throw new AIError('rate_limited', '已达到请求或订阅用量上限，请稍后再试。', 429);
          }
          if (/401|403|auth|token/i.test(detail)) {
            throw new AIError('not_authenticated', 'ChatGPT 授权失效或模型访问被拒绝，请检查登录和网络配置。', 503);
          }
          throw new AIError('upstream_error', 'GPT 连接失败，请检查云端网络和模型可用性。');
        }
        return parseModelJSON(reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
      } catch (error) {
        if (error instanceof AIError || signal.aborted) throw error;
        if (/429|rate.limit|quota|usage.limit/i.test(error.message || '')) {
          throw new AIError('rate_limited', '已达到请求或订阅用量上限，请稍后再试。', 429);
        }
        throw new AIError('upstream_error', 'GPT 连接失败，请检查云端网络和 ChatGPT 授权。');
      } finally {
        signal.removeEventListener('abort', abort);
        session.dispose();
      }
    },
  };
}
