import { ContextIndex } from "../storage/sqlite.js";
import type { ContextEntry } from "../storage/markdown.js";

export interface ContextLoadInput {
  name: string;
}

export interface LoadedReference {
  id: string;
  type: string;
  date: string;
  contentPreview: string;
}

export interface LoadedCheckpoint {
  id: string;
  name: string;
  summary?: string;
  content: string;
  projectRoot?: string;
  createdAt: string;
}

export interface ContextLoadResult {
  checkpoint: LoadedCheckpoint | null;
  references: LoadedReference[];
  candidates: Array<{ name: string; summary?: string; date: string }>;
}

function preview(content: string): string {
  const trimmed = content.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed;
}

function toLoadedReference(e: ContextEntry): LoadedReference {
  return {
    id: e.id,
    type: e.type,
    date: e.date,
    contentPreview: preview(e.content),
  };
}

export async function contextLoad(input: ContextLoadInput): Promise<ContextLoadResult> {
  const index = new ContextIndex();
  try {
    const exact = index.findCheckpointByName(input.name);
    if (exact) {
      const refs: LoadedReference[] = [];
      if (exact.referencedEntryIds?.length) {
        const allRecent = index.list({ days: 365 });
        const byId = new Map(allRecent.map(e => [e.id, e] as const));
        for (const id of exact.referencedEntryIds) {
          const found = byId.get(id);
          if (found) refs.push(toLoadedReference(found));
        }
      }
      return {
        checkpoint: {
          id: exact.id,
          name: exact.name!,
          summary: exact.summary,
          content: exact.content,
          projectRoot: exact.projectRoot,
          createdAt: exact.date + " " + exact.time,
        },
        references: refs,
        candidates: [],
      };
    }

    // Fallback: list checkpoints whose name contains the query as a substring.
    const all = index.listCheckpoints({ limit: 100 });
    const sub = all.filter(c => (c.name ?? "").toLowerCase().includes(input.name.toLowerCase()));
    const candidates = sub.slice(0, 10).map(c => ({
      name: c.name!, summary: c.summary, date: c.date,
    }));

    return { checkpoint: null, references: [], candidates };
  } finally {
    index.close();
  }
}
