import { env } from '../config/env.js';

const OWNER = 'FINSS15';
const REPO = 'Last';
const BRANCH = 'main';
const PATH = 'whitelist.json';

export const syncLegacyWhitelistJson = async (snapshot) => {
  if (!env.GITHUB_TOKEN) return { synced: false, reason: 'GITHUB_TOKEN_NOT_CONFIGURED' };
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const endpoint = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
  try {
    const current = await fetch(`${endpoint}?ref=${BRANCH}`, { headers, signal: AbortSignal.timeout(12000) });
    if (!current.ok) throw new Error(`GitHub read failed: HTTP ${current.status}`);
    const file = await current.json();
    const content = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8').toString('base64');
    const updated = await fetch(endpoint, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ message: 'chore: sync whitelist from NOXRIDGE admin', content, sha: file.sha, branch: BRANCH })
    });
    if (!updated.ok) throw new Error(`GitHub write failed: HTTP ${updated.status}`);
    const result = await updated.json();
    return { synced: true, commit: result.commit?.sha || null };
  } catch (error) {
    console.error('[NOXRIDGE WHITELIST SYNC]', error?.message || 'sync failed');
    return { synced: false, reason: 'GITHUB_SYNC_FAILED' };
  }
};
