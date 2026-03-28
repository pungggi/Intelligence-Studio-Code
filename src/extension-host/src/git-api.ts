/**
 * CoreCode built-in vscode.git extension API.
 *
 * Provides the minimal API surface that extensions like GitLens consume:
 *   vscode.extensions.getExtension('vscode.git').exports.getAPI(1)
 *
 * Backed by spawning the system `git` binary via child_process.
 * All heavy operations are async to avoid blocking the Extension Host.
 */

import { spawn } from "node:child_process";
import { join, isAbsolute, normalize } from "node:path";

// ─── Types (mirrors vscode.git public API v1) ─────────────────

export interface Repository {
  rootUri: { fsPath: string; toString(): string };
  state: RepositoryState;
  dispose(): void;
  log(options?: LogOptions): Promise<Commit[]>;
  getCommit(hash: string): Promise<Commit>;
  blame(path: string): Promise<BlameHunk[]>;
  diff(options?: { cached?: boolean }): Promise<string>;
  show(ref: string, filePath: string): Promise<string>;
  getConfig(key: string): Promise<string>;
  getBranch(name: string): Promise<Branch>;
  getBranches(query: { remote?: boolean }): Promise<Branch[]>;
}

export interface RepositoryState {
  HEAD: Branch | undefined;
  refs: Branch[];
  remotes: Remote[];
  workingTreeChanges: Change[];
  indexChanges: Change[];
  mergeChanges: Change[];
  onDidChange: (listener: () => void) => { dispose(): void };
}

export interface Branch {
  name: string;
  commit?: string;
  upstream?: { name: string; remote: string };
  ahead?: number;
  behind?: number;
  type: 0 | 1; // 0=Local, 1=Remote
}

export interface Remote { name: string; fetchUrl?: string; pushUrl?: string }
export interface Change { uri: { fsPath: string }; status: number }
export interface Commit { hash: string; message: string; authorName: string; authorEmail: string; authorDate: Date; commitDate: Date; parents: string[] }
export interface BlameHunk { originalStartLineNumber: number; originalEndLineNumber: number; finalStartLineNumber: number; finalEndLineNumber: number; commit: Commit }
export interface LogOptions { maxEntries?: number; path?: string; follow?: boolean; excludeMerges?: boolean }

// ─── git subprocess helper ────────────────────────────────────

const GIT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB per stream

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    proc.stdout.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        proc.stdout.removeAllListeners('data');
        proc.stderr.removeAllListeners('data');
        proc.kill();
        clearTimeout(timer);
        reject(new Error(`git ${args[0]} output exceeded ${MAX_OUTPUT_BYTES} bytes (stdout truncated at: ${stdout.slice(-256)})`));
        return;
      }
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        proc.stdout.removeAllListeners('data');
        proc.stderr.removeAllListeners('data');
        proc.kill();
        clearTimeout(timer);
        reject(new Error(`git ${args[0]} stderr exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
      else resolve(stdout);
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── Parse helpers ────────────────────────────────────────────

const LOG_SEP = '\x00';
const LOG_FMT = `%H${LOG_SEP}%s${LOG_SEP}%an${LOG_SEP}%ae${LOG_SEP}%aI${LOG_SEP}%cI${LOG_SEP}%P`;

function safeDate(value: string | undefined): Date {
  const d = new Date(value || 0);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function parseCommits(raw: string): Commit[] {
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const [hash, message, authorName, authorEmail, aDate, cDate, parents] = line.split(LOG_SEP);
    return {
      hash: hash ?? '',
      message: message ?? '',
      authorName: authorName ?? '',
      authorEmail: authorEmail ?? '',
      authorDate: safeDate(aDate),
      commitDate: safeDate(cDate),
      parents: parents ? parents.split(' ').filter(Boolean) : [],
    };
  });
}

function parseBlame(raw: string): BlameHunk[] {
  const hunks: BlameHunk[] = [];
  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const headerMatch = lines[i]?.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?/);
    if (!headerMatch) { i++; continue; }
    const [, hash = '', origLine = '0', finalLine = '0', numLines] = headerMatch;
    const count = parseInt(numLines ?? '1', 10);
    // scan for author info in following lines
    let authorName = '', authorEmail = '', aDate = '';
    let j = i + 1;
    while (j < lines.length && !lines[j]?.match(/^[0-9a-f]{40}/)) {
      if (lines[j]?.startsWith('author ')) authorName = lines[j].slice(7);
      if (lines[j]?.startsWith('author-mail ')) authorEmail = lines[j].slice(12).replace(/[<>]/g, '');
      if (lines[j]?.startsWith('author-time ')) aDate = lines[j].slice(12);
      j++;
    }
    const commit: Commit = { hash, message: '', authorName, authorEmail, authorDate: new Date(parseInt(aDate, 10) * 1000), commitDate: new Date(parseInt(aDate, 10) * 1000), parents: [] };
    hunks.push({
      originalStartLineNumber: parseInt(origLine, 10),
      originalEndLineNumber: parseInt(origLine, 10) + count - 1,
      finalStartLineNumber: parseInt(finalLine, 10),
      finalEndLineNumber: parseInt(finalLine, 10) + count - 1,
      commit,
    });
    i = j;
  }
  return hunks;
}

// ─── Repository implementation ────────────────────────────────

function makeRepository(root: string): Repository {
  const rootUri = {
    fsPath: root,
    toString() { return root.match(/^[A-Za-z]:/) ? 'file:///' + root.replace(/\\/g, '/') : 'file://' + root; },
  };

  let _headCache: Branch | undefined;
  let _refsCache: Branch[] = [];
  let _changesCache = { working: [] as Change[], index: [] as Change[], merge: [] as Change[] };
  const _changeListeners: Array<() => void> = [];

  function notifyChange() { for (const l of _changeListeners) { try { l(); } catch { /* ignore */ } } }

  // Background refresh every 5 seconds
  async function refresh() {
    try {
      // HEAD
      const headName = (await git(['symbolic-ref', '--short', 'HEAD'], root).catch(() => '')).trim();
      const headHash = (await git(['rev-parse', 'HEAD'], root).catch(() => '')).trim();
      if (headName || headHash) {
        _headCache = { name: headName || headHash.slice(0, 7), commit: headHash, type: 0 };
        // Try to get upstream info
        try {
          const upstream = (await git(['rev-parse', '--abbrev-ref', `${headName}@{upstream}`], root)).trim();
          if (upstream) {
            const [remote, ...rest] = upstream.split('/');
            _headCache.upstream = { remote, name: rest.join('/') };
            const ahead = parseInt((await git(['rev-list', '--count', `${upstream}..HEAD`], root)).trim(), 10);
            const behind = parseInt((await git(['rev-list', '--count', `HEAD..${upstream}`], root)).trim(), 10);
            _headCache.ahead = ahead;
            _headCache.behind = behind;
          }
        } catch { /* no upstream */ }
      }

      // Refs (local branches)
      try {
        const refsOut = (await git(['for-each-ref', '--format=%(refname:short)\t%(objectname:short)\t%(refname:strip=2)', 'refs/heads/'], root)).trim();
        _refsCache = refsOut ? refsOut.split('\n').map(line => {
          const [name, commit] = line.split('\t');
          return { name, commit: commit ?? '', type: 0 as 0 };
        }) : [];
      } catch { _refsCache = []; }

      // Status
      const statusOut = await git(['status', '--porcelain=v1', '-z'], root).catch(() => '');
      _changesCache = { working: [], index: [], merge: [] };
      for (const entry of statusOut.split('\0').filter(Boolean)) {
        if (entry.length < 3) continue;
        const x = entry[0];
        const y = entry[1];
        const fp = entry.slice(3);
        const uri = { fsPath: join(root, fp) };
        if (x !== ' ' && x !== '?') _changesCache.index.push({ uri, status: x.charCodeAt(0) });
        if (y !== ' ' && y !== '?') _changesCache.working.push({ uri, status: y.charCodeAt(0) });
        if (x === 'U' || y === 'U') _changesCache.merge.push({ uri, status: x.charCodeAt(0) });
      }

      notifyChange();
    } catch { /* ignore if not a git repo */ }
  }

  refresh();
  const _refreshInterval = setInterval(refresh, 5000);

  return {
    dispose() { clearInterval(_refreshInterval); },
    rootUri,
    get state(): RepositoryState {
      return {
        HEAD: _headCache,
        refs: _refsCache,
        remotes: [],
        workingTreeChanges: _changesCache.working,
        indexChanges: _changesCache.index,
        mergeChanges: _changesCache.merge,
        onDidChange: (listener) => {
          _changeListeners.push(listener);
          return { dispose: () => { const idx = _changeListeners.indexOf(listener); if (idx !== -1) _changeListeners.splice(idx, 1); } };
        },
      };
    },
    async log(options: LogOptions = {}): Promise<Commit[]> {
      const args = ['log', `--format=${LOG_FMT}`];
      if (options.excludeMerges) args.push('--no-merges');
      if (options.maxEntries) args.push(`-${options.maxEntries}`);
      if (options.follow && options.path) args.push('--follow');
      if (options.path) args.push('--', options.path);
      const raw = await git(args, root);
      return parseCommits(raw);
    },
    async getCommit(hash: string): Promise<Commit> {
      if (hash.startsWith('-') || !/^[A-Za-z0-9_./:@^~\-{}]+$/.test(hash)) {
        throw new Error(`getCommit: unsafe hash '${hash}'`);
      }
      const raw = await git(['show', '-s', `--format=${LOG_FMT}`, '--', hash], root);
      return parseCommits(raw)[0] ?? { hash, message: '', authorName: '', authorEmail: '', authorDate: new Date(), commitDate: new Date(), parents: [] };
    },
    async blame(filePath: string): Promise<BlameHunk[]> {
      if (isAbsolute(filePath)) {
        throw new Error(`blame: filePath must be relative, got '${filePath}'`);
      }
      const normalized = normalize(filePath);
      if (normalized.startsWith('..')) {
        throw new Error(`blame: filePath '${filePath}' traverses outside repository`);
      }
      const raw = await git(['blame', '--porcelain', '--', filePath], root);
      return parseBlame(raw);
    },
    async diff(options: { cached?: boolean } = {}): Promise<string> {
      const args = ['diff'];
      if (options.cached) args.push('--cached');
      return git(args, root);
    },
    async show(ref: string, filePath: string): Promise<string> {
      // Validate filePath: must be relative and must not traverse outside the repo root
      if (isAbsolute(filePath)) {
        throw new Error(`show: filePath must be relative, got '${filePath}'`);
      }
      const normalized = normalize(filePath);
      if (normalized.startsWith('..')) {
        throw new Error(`show: filePath '${filePath}' traverses outside repository`);
      }
      // Validate ref: only allow safe characters and reject leading dashes to prevent
      // flag injection. Includes {} for stash refs (stash@{0}) and branch@{n} syntax.
      if (ref.startsWith('-') || !/^[A-Za-z0-9_./:@^~\-{}]+$/.test(ref)) {
        throw new Error(`show: unsafe ref '${ref}'`);
      }
      return git(['show', `${ref}:${filePath}`], root);
    },
    async getConfig(key: string): Promise<string> {
      if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(key)) {
        throw new Error(`getConfig: unsafe key '${key}'`);
      }
      return (await git(['config', '--get', '--', key], root)).trim();
    },
    async getBranch(name: string): Promise<Branch> {
      if (name.startsWith('-') || !/^[A-Za-z0-9_./:@^~\-{}]+$/.test(name)) {
        throw new Error(`getBranch: unsafe name '${name}'`);
      }
      const hash = (await git(['rev-parse', '--', name], root)).trim();
      return { name, commit: hash, type: name.includes('/') ? 1 : 0 };
    },
    async getBranches(query: { remote?: boolean } = {}): Promise<Branch[]> {
      const args = ['branch', '--format=%(refname:short)%09%(objectname:short)', query.remote ? '-r' : '-l'];
      const raw = await git(args, root);
      return raw.trim().split('\n').filter(Boolean).map(line => {
        const [name, commit] = line.split('\t');
        return { name: name?.trim() ?? '', commit: commit?.trim(), type: query.remote ? 1 : 0 } as Branch;
      });
    },
  };
}

// ─── Git Extension API factory ────────────────────────────────

export function createGitExtension(workspaceRoot: string) {
  const repo = makeRepository(workspaceRoot);
  const repositories = [repo];

  return {
    exports: {
      getAPI(version: number) {
        if (version !== 1) throw new Error(`vscode.git API version ${version} not supported`);
        return {
          state: 'initialized' as const,
          repositories,
          getRepository(uri: { fsPath: string }) {
            const fp = uri.fsPath;
            return repositories.find(r => {
              const rp = r.rootUri.fsPath;
              return fp === rp || fp.startsWith(rp + '/') || fp.startsWith(rp + '\\');
            }) ?? null;
          },
          onDidOpenRepository: (_l: unknown) => ({ dispose: () => { } }),
          onDidCloseRepository: (_l: unknown) => ({ dispose: () => { } }),
          onDidChangeState: (_l: unknown) => ({ dispose: () => { } }),
        };
      },
      isAuthenticated: false,
    },
    id: 'vscode.git',
    extensionUri: { fsPath: '' },
    isActive: true,
    activate: async () => { },
    deactivate: () => { repo.dispose(); },
  };
}
