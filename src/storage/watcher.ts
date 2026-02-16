import { watch, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FSWatcher } from "node:fs";
import type { ContextIndex } from "./sqlite.js";
import type { Embedder } from "./embedder.js";
import { isGitRepo } from "./git.js";
import { contextGitIndex } from "../tools/context-git-index.js";
import { appendEntry } from "./markdown.js";
import { detectProject } from "./project.js";
import { getSessionId } from "./session.js";

export interface WatcherOptions {
  cwd?: string;
  index: ContextIndex;
  embedder: Embedder;
  getCurrentProject: () => string | null;
}

export class GitWatcher {
  private cwd: string;
  private index: ContextIndex;
  private embedder: Embedder;
  private getCurrentProject: () => string | null;

  private watchers: FSWatcher[] = [];
  private lastHead: string = "";
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: WatcherOptions) {
    this.cwd = opts.cwd ?? process.cwd();
    this.index = opts.index;
    this.embedder = opts.embedder;
    this.getCurrentProject = opts.getCurrentProject;
  }

  start(): void {
    if (!isGitRepo(this.cwd)) return;

    const gitDir = join(this.cwd, ".git");

    // Read initial HEAD
    const headPath = join(gitDir, "HEAD");
    try {
      this.lastHead = readFileSync(headPath, "utf-8").trim();
    } catch {
      // HEAD unreadable — bail out
      return;
    }

    // Watch .git/HEAD (branch switches)
    try {
      const headWatcher = watch(headPath, () => this.scheduleEvent());
      this.watchers.push(headWatcher);
    } catch {
      // Ignore — file may be inaccessible
    }

    // Watch .git/refs/heads/ (new commits)
    const refsHeadsDir = join(gitDir, "refs", "heads");
    if (existsSync(refsHeadsDir)) {
      try {
        const refsWatcher = watch(refsHeadsDir, { recursive: false }, () =>
          this.scheduleEvent()
        );
        this.watchers.push(refsWatcher);
      } catch {
        // Ignore — directory may be inaccessible
      }
    }

    // Watch .git/COMMIT_EDITMSG (commit creation) — only if file exists
    const commitMsgPath = join(gitDir, "COMMIT_EDITMSG");
    if (existsSync(commitMsgPath)) {
      try {
        const commitMsgWatcher = watch(commitMsgPath, () =>
          this.scheduleEvent()
        );
        this.watchers.push(commitMsgWatcher);
      } catch {
        // Ignore
      }
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // Ignore close errors
      }
    }
    this.watchers = [];
  }

  private scheduleEvent(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.handleEvent().catch(() => {
        // Swallow errors — watcher is best-effort
      });
    }, 2000);
  }

  private async handleEvent(): Promise<void> {
    const headPath = join(this.cwd, ".git", "HEAD");
    let currentHead: string;
    try {
      currentHead = readFileSync(headPath, "utf-8").trim();
    } catch {
      return;
    }

    // Check for branch switch
    if (currentHead !== this.lastHead) {
      const branchMatch = currentHead.match(/^ref: refs\/heads\/(.+)$/);
      if (branchMatch) {
        const branchName = branchMatch[1];
        const content = `Switched to branch ${branchName}`;
        const entry = appendEntry(content, "progress", [
          "branch-switch",
          `branch:${branchName}`,
        ]);

        entry.tier = "ephemeral";
        entry.project = this.getCurrentProject() ?? detectProject(this.cwd);
        entry.sessionId = getSessionId();
        entry.agentId = "watcher";

        const rowid = this.index.insert(entry);
        const embedding = await this.embedder.embed(content);
        this.index.insertVec(rowid, embedding);
      }
    }

    // Auto-index recent commits
    await contextGitIndex(
      { repo_path: this.cwd, days: 1 },
      this.index,
      this.embedder
    );

    // Update lastHead
    this.lastHead = currentHead;
  }
}
