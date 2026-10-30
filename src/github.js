export const ENGINE_COMMITTER_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/**
 * Returns commit SHAs whose committer is not the engine identity.
 * @param {Array<{ sha: string, committerEmail?: string }>} commits
 * @param {string} [engineEmail]
 * @returns {string[]}
 */
export function foreignCommits(commits, engineEmail = ENGINE_COMMITTER_EMAIL) {
  if (!Array.isArray(commits)) return [];
  return commits
    .filter((c) => c.committerEmail !== engineEmail)
    .map((c) => c.sha);
}

/**
 * Creates a GitHub REST API client.
 * @param {{ token: string, repo: string, fetch?: typeof fetch }} options
 */
export function github({ token, repo, fetch = globalThis.fetch }) {
  const baseUrl = 'https://api.github.com';
  const defaultHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  async function request(apiPath, options = {}) {
    const res = await fetch(`${baseUrl}${apiPath}`, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...(options.headers || {})
      }
    });
    return res;
  }

  return {
    async defaultBranch() {
      const res = await request(`/repos/${repo}`);
      if (!res.ok) throw new Error(`GitHub API request failed with status ${res.status}`);
      const data = await res.json();
      return data.default_branch;
    },

    async branchHead(branch) {
      const res = await request(`/repos/${repo}/commits/${encodeURIComponent(branch)}`);
      if (!res.ok) throw new Error(`GitHub API request failed with status ${res.status}`);
      const data = await res.json();
      return data.sha;
    },

    async openSyncPr() {
      const [owner] = repo.split('/');
      const res = await request(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:figma-sync/run`)}`);
      if (!res.ok) throw new Error(`GitHub API request failed with status ${res.status}`);
      const list = await res.json();
      if (!Array.isArray(list)) return null;
      const found = list.find((pr) => pr.head?.ref === 'figma-sync/run');
      if (!found) return null;
      return {
        number: found.number,
        headSha: found.head.sha
      };
    },

    async fileAt(filePath, ref) {
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const res = await request(`/repos/${repo}/contents/${filePath}${query}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub API request failed with status ${res.status}`);
      const data = await res.json();
      if (!data.content) return null;
      return Buffer.from(data.content, 'base64').toString('utf8');
    },

    async compareCommits(base, head) {
      const res = await request(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      if (!res.ok) throw new Error(`GitHub API request failed with status ${res.status}`);
      const data = await res.json();
      return (data.commits || []).map((c) => ({
        sha: c.sha,
        committerEmail: c.commit?.committer?.email
      }));
    },

    async deleteBranch(name) {
      const res = await request(`/repos/${repo}/git/refs/heads/${encodeURIComponent(name)}`, {
        method: 'DELETE'
      });
      if (res.status === 404) return;
      if (!res.ok) throw new Error(`GitHub API request failed with status ${res.status}`);
    },

    async prComment(number, body) {
      const res = await request(`/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body })
      });
      if (!res.ok) throw new Error(`GitHub API request failed with status ${res.status}`);
      return await res.json();
    }
  };
}
