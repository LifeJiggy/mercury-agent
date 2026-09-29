import { logger } from './logger.js';

const GITHUB_API = 'https://api.github.com';

let cachedToken: string | null = null;

export function setGitHubToken(token: string): void {
  cachedToken = token;
}

export function getGitHubToken(): string | null {
  if (cachedToken) return cachedToken;
  return process.env.GITHUB_TOKEN || null;
}

export function isGitHubConfigured(): boolean {
  return !!getGitHubToken();
}

interface GitHubRequestOptions {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
}

const GITHUB_API_HOST = 'api.github.com';

/**
 * Resolve a `github_api` request target, confining it to GitHub so the bearer
 * token is never attached to a caller-chosen host (#81). Relative API paths
 * and absolute `https://api.github.com/...` URLs are allowed; any other
 * absolute URL is rejected.
 */
export function resolveGitHubApiUrl(path: string): string {
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`Invalid GitHub API URL: ${path}`);
    }
    if (url.protocol !== 'https:') {
      throw new Error(`github_api requires https; refusing ${url.protocol}//${url.hostname}`);
    }
    if (url.hostname.toLowerCase() !== GITHUB_API_HOST) {
      throw new Error(
        `github_api is restricted to ${GITHUB_API_HOST}; refusing to send the GitHub token to ${url.hostname}`,
      );
    }
    return url.toString();
  }
  if (!trimmed.startsWith('/')) {
    throw new Error('github_api path must start with "/" (e.g. /repos/owner/repo/issues).');
  }
  return `${GITHUB_API}${trimmed}`;
}

export async function githubRequest(path: string, options: GitHubRequestOptions = {}): Promise<any> {
  const token = getGitHubToken();
  if (!token) {
    throw new Error('GITHUB_TOKEN not configured. Run mercury doctor to set it up.');
  }

  const url = resolveGitHubApiUrl(path);
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Mercury-Agent',
    ...options.headers,
  };

  const fetchOptions: any = {
    method: options.method || 'GET',
    headers,
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
    headers['Content-Type'] = 'application/json';
  }

  logger.info({ method: fetchOptions.method, path }, 'GitHub API request');

  const response = await fetch(url, fetchOptions);

  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining && parseInt(remaining, 10) < 100) {
    logger.warn({ remaining }, 'GitHub API rate limit running low');
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body.slice(0, 500)}`);
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}