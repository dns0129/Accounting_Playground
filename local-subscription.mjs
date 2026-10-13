import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Shared logins are read-only. Never copy or refresh another app's credentials.
export async function localSubscription({home = homedir(), codexHome = process.env.CODEX_HOME || resolve(home, '.codex'), read = readFile, now = Date.now()} = {}) {
  for (const [path, source, kind] of [
    [resolve(home, '.pi/agent/auth.json'), '本机 Pi 登录', 'pi'],
    [resolve(codexHome, 'auth.json'), '本机 Codex 登录', 'codex'],
  ]) {
    try {
      const data = JSON.parse(await read(path, 'utf8'));
      const entry = kind === 'pi' ? data['openai-codex'] : null;
      const access = kind === 'pi' ? (entry?.type === 'oauth' ? entry.access : null)
        : (data.auth_mode !== 'apikey' ? data.tokens?.access_token : null);
      if (typeof access !== 'string') continue;
      let jwtExpiry = 0;
      try { jwtExpiry = JSON.parse(Buffer.from(access.split('.')[1], 'base64url').toString()).exp * 1000; } catch {}
      const expires = jwtExpiry || Number(entry?.expires || 0);
      if (!Number.isFinite(expires) || expires <= now + 300000) continue;
      return {source, credential:{type:'oauth', access, refresh:'', expires}};
    } catch { /* Missing, malformed, expired, or inaccessible login: use app login. */ }
  }
  return null;
}
