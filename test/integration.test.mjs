import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createApp } from '../server.mjs';
import { createWebLogin } from '../web-login.mjs';
import { AIError, createModelRuntime, createPiBackend, parseModelJSON, provider } from '../ai-service.mjs';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { localSubscription } from '../local-subscription.mjs';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const status = { configured:true, provider:'openai', model:'gpt-6.1-sol', message:'ChatGPT 登录已配置。' };
const entry = {
  date:'2026-09-01', memo:'GPT 测试服务收入', adjusting:false,
  groups:[[{acct:'1000',dr:1234,cr:0},{acct:'4000',dr:0,cr:1234}]],
  explain:'服务履约后确认收入；现金增加记借方，收入增加记贷方。', assumptions:'',
};
const question = {
  title:'GPT 收入确认练习', prompt:'按照 IFRS 15，服务收入在何时确认？',
  options:['收到订单时','履约义务满足时','报价时','年末统一确认'], answer:1,
  explain:'收入应在履约义务满足时确认。',
};

async function listen(t, options = {}) {
  const server = createApp(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (base, body, options = {}) => fetch(base + '/api/ai/json', {
  method:'POST', headers:{'Content-Type':'application/json', 'X-Accounting-AI':'1', ...options.headers},
  body:JSON.stringify(body), signal:options.signal,
});

async function until(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(20); }
  assert.fail('Timed out waiting for UI state');
}

async function page(t, base, extra = {}) {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const html = await (await fetch(base)).text();
  const dom = new JSDOM(html, {
    url:extra.pageUrl || base, runScripts:'dangerously', virtualConsole,
    beforeParse(window) {
      window.fetch = (url, options) => extra.fetchSpy ? extra.fetchSpy(url, options) : fetch(new URL(url, base), options);
      window.AbortController = AbortController;
      window.AbortSignal = AbortSignal;
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      if (extra.fastLoginPolling) {
        const schedule = window.setTimeout.bind(window);
        window.setTimeout = (callback, ms, ...args) => schedule(callback, ms === 2000 ? 20 : ms, ...args);
      }
      Object.assign(window, extra);
    },
  });
  t.after(() => dom.window.close());
  return { window:dom.window, document:dom.window.document, errors };
}

function deviceLoginFixture() {
  let confirm, saved = false, calls = 0, cancelled = false;
  const approved = new Promise(resolve => { confirm = resolve; });
  const login = createWebLogin({
    secureCredentials:async () => { saved = true; },
    loadRuntime:async () => ({
      async login(provider, method, interaction) {
        calls++;
        assert.equal(provider, 'openai-codex'); assert.equal(method, 'oauth');
        assert.equal(await interaction.prompt({type:'select',options:[{id:'device_code'}]}),'device_code');
        interaction.notify({type:'device_code',userCode:'TEST-1234',verificationUri:'https://auth.openai.com/codex/device',expiresInSeconds:900});
        let stop;
        const aborted = new Promise((_, reject) => {
          stop = () => { cancelled = true; reject(new Error('cancelled')); };
          interaction.signal.addEventListener('abort',stop,{once:true});
        });
        try { await Promise.race([approved,aborted]); }
        finally { interaction.signal.removeEventListener('abort',stop); }
        return {access:'test-access-token-must-not-reach-browser',refresh:'test-refresh-token-must-not-reach-browser'};
      },
    }),
  });
  return {login,confirm:() => confirm(),get saved(){return saved;},get calls(){return calls;},get cancelled(){return cancelled;}};
}

test('clicking the page login button shows a device code and detects authorization without terminal input', async t => {
  const flow = deviceLoginFixture();
  const base = await listen(t,{login:flow.login,backend:{
    status:async () => ({...status,configured:flow.saved}),sample:async () => entry,
  }});
  const {document,errors} = await page(t,base,{fastLoginPolling:true});
  assert.equal(flow.calls,0);
  const button = document.querySelector('#toolbar [data-act="aiLogin"]');
  assert.equal(button.textContent,'登录 ChatGPT'); button.click();
  await until(() => document.querySelector('#ai-device-code'));
  assert.equal(document.querySelector('#ai-device-code').textContent,'TEST-1234');
  assert.equal(document.querySelector('#ai-login-link').href,'https://auth.openai.com/codex/device');
  assert.equal(document.querySelector('#ai-login-link').target,'_blank');
  const response = await (await fetch(base+'/api/ai/login')).text();
  assert.doesNotMatch(response,/test-access-token|test-refresh-token/);
  flow.confirm();
  await until(() => document.querySelector('#ai-login-panel').textContent.includes('登录成功'));
  await until(() => document.querySelector('#toolbar').textContent.includes('GPT 已登录'));
  assert.equal(document.querySelector('#ai-device-code'),null);
  document.querySelector('[data-act="closeModal"]').click();
  document.querySelector('[data-act="mode"][data-v="ai"]').click();
  assert.equal(document.querySelector('[data-act="aiGo"]').disabled,false);
  assert.equal(flow.calls,1);
  assert.deepEqual(errors,[]);
});

test('the page can cancel device authorization and gives a retry action', async t => {
  const flow = deviceLoginFixture();
  const base = await listen(t,{login:flow.login,backend:{status:async () => ({...status,configured:false})}});
  const {document,errors} = await page(t,base,{fastLoginPolling:true});
  document.querySelector('#toolbar [data-act="aiLogin"]').click();
  await until(() => document.querySelector('[data-act="aiCancelLogin"]'));
  document.querySelector('[data-act="aiCancelLogin"]').click();
  await until(() => document.querySelector('#ai-login-panel').textContent.includes('已取消登录'));
  assert.equal(flow.saved,false); assert.equal(flow.cancelled,true);
  assert.equal(document.querySelector('#ai-device-code'),null);
  assert.match(document.querySelector('[data-act="aiStartLogin"]').textContent,/重新登录/);
  assert.deepEqual(errors,[]);
});

test('a failed login remains in the page with an actionable error', async t => {
  const login = createWebLogin({loadRuntime:async () => {throw new Error('403: private diagnostics');}});
  const base = await listen(t,{login,backend:{status:async () => ({...status,configured:false})}});
  const {document,errors} = await page(t,base);
  document.querySelector('#toolbar [data-act="aiLogin"]').click();
  await until(() => document.querySelector('#ai-login-panel').textContent.includes('无法完成 ChatGPT 登录'));
  assert.match(document.querySelector('#ai-login-panel').textContent,/auth.openai.com/);
  assert.doesNotMatch(document.querySelector('#ai-login-panel').textContent,/private diagnostics/);
  assert.ok(document.querySelector('[data-act="aiStartLogin"]'));
  assert.deepEqual(errors,[]);
});

test('device authorization reuses an active request and rejects stale cancellation', async () => {
  const flow = deviceLoginFixture();
  try {
    const [first,second] = await Promise.all([flow.login.start(),flow.login.start()]);
    assert.equal(first.id,second.id); assert.equal(flow.calls,1);
    assert.throws(() => flow.login.cancel('old-request'),error => error.code === 'invalid_request');
    assert.equal(flow.login.status().state,'waiting');
    flow.login.cancel(first.id);
    assert.equal(flow.login.status().state,'cancelled');
  } finally {flow.login.close();}
});

test('device authorization times out instead of leaving a permanent login spinner', async () => {
  const login = createWebLogin({startTimeoutMs:20,loadRuntime:async () => {
    await delay(40); return {login:async () => {assert.fail('Cancelled login should not start');}};
  }});
  try {
    const state = await login.start();
    assert.equal(state.state,'cancelled'); assert.match(state.message,/超时/);
    await delay(30);
  } finally {login.close();}
});

test('the actual page generates a balanced journal entry and a GPT quiz through HTTP', async t => {
  const prompts = [];
  const base = await listen(t, { backend:{
    status:async () => status,
    sample:async prompt => { prompts.push(prompt); return prompt.includes('record ONE business transaction') ? entry : question; },
  } });
  const { window, document, errors } = await page(t, base);
  document.querySelector('[data-act="mode"][data-v="ai"]').click();
  await until(() => !document.querySelector('[data-act="aiGo"]').disabled);
  const text = document.querySelector('#ai-text');
  text.value = '9 月 1 日收到服务收入 1234';
  text.dispatchEvent(new window.Event('input', {bubbles:true}));
  document.querySelector('[data-act="aiGo"]').click();
  await until(() => document.querySelector('[data-act="aiAccept"]'));
  assert.match(document.querySelector('#bench').textContent, /GPT 测试服务收入/);
  document.querySelector('[data-act="aiAccept"]').click();
  const stored = JSON.parse(window.localStorage.getItem('acct2102-statement-lab-v1'));
  const generated = stored.txns.find(e => e.memo === entry.memo);
  assert.equal(generated.src, 'ai');
  assert.equal(generated.groups[0].reduce((sum, line) => sum + line.s, 0), 0);
  assert.equal(generated.groups[0][0].s, 123400);
  document.querySelector('[data-act="view"][data-v="quiz"]').click();
  assert.match(document.querySelector('#qside').textContent, /让 GPT 出新题/);
  document.querySelector('[data-act="qAiGo"]').click();
  await until(() => document.querySelector('.qcard .qtitle')?.textContent === question.title);
  assert.match(document.querySelector('.qcard .qprompt').textContent, /IFRS 15/);
  assert.equal(document.querySelectorAll('.qcard').length, 37);
  assert.match(prompts[0], /Chart of accounts/);
  assert.match(prompts[1], /Chapter 3/);
  assert.deepEqual(errors, []);
});

test('unavailable AI remains visible and provides a connection action', async t => {
  const base = await listen(t, {backend:{status:async () => ({...status,configured:false,message:'云端尚未登录 ChatGPT。'})}});
  const { document, errors } = await page(t, base);
  document.querySelector('[data-act="mode"][data-v="ai"]').click();
  await until(() => document.querySelector('#bench').textContent.includes('云端尚未登录'));
  assert.equal(document.querySelector('[data-act="aiGo"]').disabled, true);
  document.querySelector('[data-act="aiConnection"]').click();
  assert.equal(document.querySelector('#modal').hidden, false);
  assert.ok(document.querySelector('#ai-base'));
  document.querySelector('[data-act="closeModal"]').click();
  document.querySelector('[data-act="view"][data-v="quiz"]').click();
  assert.ok(document.querySelector('[data-act="qAiGo"]'));
  assert.equal(document.querySelector('[data-act="qAiGo"]').disabled, true);
  assert.deepEqual(errors, []);
});

test('unbalanced AI output is rejected before any journal entry is saved', async t => {
  const base = await listen(t, {backend:{status:async () => status,sample:async () => ({...entry,groups:[[{acct:'1000',dr:12,cr:0},{acct:'4000',dr:0,cr:10}]]})}});
  const { window, document } = await page(t, base);
  document.querySelector('[data-act="mode"][data-v="ai"]').click();
  await until(() => !document.querySelector('[data-act="aiGo"]').disabled);
  const text = document.querySelector('#ai-text'); text.value = '服务收入 12';
  text.dispatchEvent(new window.Event('input', {bubbles:true}));
  document.querySelector('[data-act="aiGo"]').click();
  await until(() => document.querySelector('#bench').textContent.includes('借贷不平衡'));
  assert.equal(document.querySelector('[data-act="aiAccept"]'), null);
});

test('Claude Artifacts sampling still works when no cloud GPT account is connected', async t => {
  const base = await listen(t, {backend:{status:async () => ({...status,configured:false})}});
  const { document } = await page(t, base, {claude:{use:async name => name === 'sample' ? {json:async () => entry} : null}});
  document.querySelector('[data-act="mode"][data-v="ai"]').click();
  await until(() => document.querySelector('#bench').textContent.includes('由 Claude'));
  assert.equal(document.querySelector('[data-act="aiGo"]').disabled, false);
});

test('gateway rejects missing credentials, hostile origins, invalid tasks and private file paths', async t => {
  let calls = 0;
  const base = await listen(t, {token:'test-only-password',backend:{status:async () => status,sample:async () => {calls++; return entry;}}});
  assert.equal((await fetch(base + '/api/ai/status')).status, 401);
  assert.equal((await fetch(base + '/api/ai/login')).status, 401);
  assert.equal((await fetch(base + '/api/ai/login',{method:'POST',headers:{'Content-Type':'application/json','X-Accounting-AI':'1'},body:'{}'})).status,401);
  const headers = {Authorization:'Bearer test-only-password'};
  assert.equal((await fetch(base + '/api/ai/status', {headers})).status, 200);
  assert.equal((await post(base, {prompt:'test',task:'transaction'}, {headers:{...headers,Origin:'https://untrusted.example'}})).status, 403);
  assert.equal((await post(base, {prompt:'test',task:'shell'}, {headers})).status, 400);
  assert.equal((await post(base, {prompt:'x'.repeat(50001),task:'quiz'}, {headers})).status, 400);
  assert.equal((await fetch(base + '/.pi/auth.json')).status, 404);
  assert.equal(calls, 0);
});

test('stopping a request cancels the model and frees the next request', async t => {
  let cancelled = false, started = false;
  const base = await listen(t, {backend:{status:async () => status,sample:async (prompt,{signal}) => {
    if (prompt === 'again') return entry;
    started = true;
    await delay(10000, null, {signal}).catch(error => {cancelled = signal.aborted; throw error;});
    return entry;
  }}});
  const control = new AbortController();
  const first = post(base,{prompt:'wait',task:'transaction'},{signal:control.signal}).catch(error => error);
  await until(() => started);
  assert.equal((await post(base,{prompt:'second',task:'quiz'})).status,429);
  control.abort();
  await first;
  await until(() => cancelled);
  await delay(20);
  const next = await post(base,{prompt:'again',task:'quiz'});
  assert.equal(next.status,200);
  assert.deepEqual((await next.json()).result,entry);
});

test('a model timeout produces a useful error', async t => {
  const base = await listen(t,{timeoutMs:30,backend:{status:async () => status,sample:async (_prompt,{signal}) => {
    await delay(10000,null,{signal}); return entry;
  }}});
  const response = await post(base,{prompt:'wait',task:'quiz'});
  assert.equal(response.status,504);
  assert.equal((await response.json()).error.code,'timeout');
});

test('pi backend refuses API-key billing and parses model JSON', async () => {
  const runtime = await createModelRuntime();
  assert.equal(runtime.getProvider(provider).auth.apiKey,undefined);
  let created = false;
  const credentialMetadata = [{providerId:'openai',type:'api_key'}];
  const backend = createPiBackend({loadRuntime:async () => ({
    listCredentials:async () => credentialMetadata,
    getModel:provider => ({provider,id:'gpt-6.1-sol'}),
  }),createSession:async () => {created = true;}});
  assert.equal((await backend.status()).configured,false);
  await assert.rejects(() => backend.sample('test',{signal:new AbortController().signal}),error => error instanceof AIError && error.code === 'not_authenticated');
  assert.equal(created,false);
  credentialMetadata.push({providerId:'openai-codex',type:'oauth'});
  assert.equal((await backend.status()).configured,true);
  assert.equal((await backend.status()).provider,'openai-codex');
  credentialMetadata[0] = {providerId:'openai',type:'oauth'};
  assert.equal((await backend.status()).provider,'openai');
  assert.deepEqual(parseModelJSON('```json\n{"answer":1}\n```'),{answer:1});
  assert.throws(() => parseModelJSON('[]'),error => error.code === 'invalid_json');
});

test('the installed pi SDK can construct the app session with no tools or context files', async () => {
  const runtime = await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
  const settings = SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}});
  const loader = new DefaultResourceLoader({cwd:process.cwd(),agentDir:process.cwd()+'/.pi',settingsManager:settings,
    noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    systemPromptOverride:() => 'IFRS tutor. Return JSON.'});
  await loader.reload();
  const {session} = await createAgentSession({cwd:process.cwd(),agentDir:process.cwd()+'/.pi',modelRuntime:runtime,
    model:runtime.getModel('openai','gpt-6.1-sol'),tools:[],noTools:'all',resourceLoader:loader,
    settingsManager:settings,sessionManager:SessionManager.inMemory()});
  try {
    assert.deepEqual(session.getActiveToolNames(),[]);
    assert.match(session.systemPrompt,/IFRS tutor/);
    assert.equal(loader.getAgentsFiles().agentsFiles.length,0);
  } finally {session.dispose();}
});

test('shared subscription selects only valid OAuth and never exposes refresh credentials', async () => {
  const now = Date.now();
  const token = expiry => `synthetic.${Buffer.from(JSON.stringify({exp:expiry})).toString('base64url')}.synthetic`;
  const files = new Map();
  const read = async path => { if (!files.has(path)) throw new Error('missing'); return JSON.stringify(files.get(path)); };
  const options = {home:'/synthetic', codexHome:'/synthetic/codex', read, now};
  files.set('/synthetic/codex/auth.json', {auth_mode:'apikey', tokens:{access_token:token((now+3600000)/1000)}});
  assert.equal(await localSubscription(options), null);
  files.set('/synthetic/codex/auth.json', {auth_mode:'chatgpt', tokens:{access_token:token((now+3600000)/1000),refresh_token:'must-not-copy'}});
  const shared = await localSubscription(options);
  assert.equal(shared.source, '本机 Codex 登录');
  assert.equal(shared.credential.refresh, '');
  files.set('/synthetic/.pi/agent/auth.json', {'openai-codex':{type:'oauth',access:token((now+7200000)/1000),refresh:'must-not-copy'}});
  assert.equal((await localSubscription(options)).source, '本机 Pi 登录');
  files.set('/synthetic/.pi/agent/auth.json', {'openai-codex':{type:'oauth',access:token((now+1000)/1000)}});
  assert.equal((await localSubscription(options)).source, '本机 Codex 登录');
  files.set('/synthetic/codex/auth.json', {tokens:{access_token:token((now+1000)/1000)}});
  assert.equal(await localSubscription(options), null);
});

test('GitHub Pages guides local pi setup without requesting nonexistent login API', async t => {
  const base = await listen(t, {backend:{status:async () => status}});
  const calls = [];
  const {document, window, errors} = await page(t, base, {
    pageUrl:'https://dns0129.github.io/Accounting_Playground/',
    fetchSpy:async url => { calls.push(url); throw new Error('unexpected network'); },
  });
  await delay(100);
  document.querySelector('[data-act="aiLogin"]').click();
  await delay(50);
  assert.match(document.querySelector('#ai-login-panel').textContent, /连接本机 pi/);
  assert.match(document.querySelector('#ai-login-panel').textContent, /无需部署云服务器/);
  assert.deepEqual(calls, []);
  assert.equal(window.AccountingAI.needsLocal, true);
  assert.deepEqual(errors, []);
});

test('pi runtime uses an injected shared OAuth login in memory with refresh disabled', async () => {
  const runtime = await createModelRuntime({localEnabled:true, loadShared:async () => ({
    source:'本机 Codex 登录', credential:{type:'oauth',access:'synthetic-access',refresh:'',expires:Date.now()+3600000},
  })});
  const backend = createPiBackend({loadRuntime:async () => runtime});
  const metadata = await backend.status();
  assert.equal(metadata.provider, 'openai-codex');
  assert.equal(metadata.configured, true);
  assert.equal(metadata.source, '本机 Codex 登录');
  assert.ok(!JSON.stringify(metadata).includes('synthetic-access'));
  assert.equal(runtime.getProvider('openai-codex').auth.apiKey, undefined);
  await assert.rejects(runtime.getProvider('openai-codex').auth.oauth.refresh({}), /本机共享授权即将过期/);
});

test('GitHub local connection reuses configured pi without starting a new authorization', async t => {
  const base = await listen(t, {backend:{status:async () => status}});
  const calls = [];
  const {document, window} = await page(t, base, {
    pageUrl:'https://dns0129.github.io/Accounting_Playground/',
    fetchSpy:async url => {
      calls.push(url);
      return new Response(JSON.stringify({...status, source:'本机 Codex 登录', message:'已找到本机 Codex 登录。'}), {status:200, headers:{'Content-Type':'application/json'}});
    },
  });
  await delay(100);
  document.querySelector('[data-act="aiLogin"]').click();
  document.querySelector('[data-act="aiConnectLocal"]').click();
  await until(() => document.querySelector('#ai-login-panel').textContent.includes('已找到本机 Codex 登录'));
  assert.equal(window.AccountingAI.base, 'http://127.0.0.1:8792');
  assert.deepEqual(calls, ['http://127.0.0.1:8792/api/ai/status']);
});

test('local gateway permits private network preflight only for the configured website', async t => {
  const origin = 'https://dns0129.github.io';
  const base = await listen(t, {backend:{status:async () => status}, appOrigin:origin});
  const allowed = await fetch(base+'/api/ai/status', {method:'OPTIONS', headers:{Origin:origin,'Access-Control-Request-Private-Network':'true'}});
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Private-Network'), 'true');
  const denied = await fetch(base+'/api/ai/status', {method:'OPTIONS', headers:{Origin:'https://untrusted.example','Access-Control-Request-Private-Network':'true'}});
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Private-Network'), null);
});
