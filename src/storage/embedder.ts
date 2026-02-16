import {
  pipeline,
  env,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { MODELS_DIR } from "./paths.js";

const MAX_CACHE = 100;

export interface TemplateEmbedding {
  category: string;
  text: string;
  embedding: Float32Array;
}

export class Embedder {
  private extractor: FeatureExtractionPipeline | null = null;
  private cache = new Map<string, Float32Array>();
  private directiveTemplates: TemplateEmbedding[] | null = null;
  private categoryTemplates: TemplateEmbedding[] | null = null;
  private intentTemplates: TemplateEmbedding[] | null = null;

  /** Pre-load the model so first real query is fast. */
  async warmup(): Promise<void> {
    await this.ensureModel();
  }

  private async ensureModel(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      env.cacheDir = MODELS_DIR;
      // @ts-expect-error -- pipeline() union type too complex for TS; runtime type is correct
      this.extractor = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { dtype: "q8" },
      );
    }
    return this.extractor;
  }

  async embed(text: string): Promise<Float32Array> {
    const key = text.trim().toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const extractor = await this.ensureModel();
    const result = await extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    const embedding = result.data as Float32Array;

    // LRU eviction: delete oldest if at capacity
    if (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(key, embedding);

    return embedding;
  }

  /** Pre-computed directive templates for correction detection */
  async getDirectiveTemplates(): Promise<TemplateEmbedding[]> {
    if (this.directiveTemplates) return this.directiveTemplates;

    const directives = [
      { category: "always", text: "always do this from now on" },
      { category: "never", text: "never do that again" },
      { category: "stop", text: "stop doing this please" },
      { category: "remember", text: "please remember to do this going forward" },
      { category: "preference", text: "I prefer this approach instead" },
      { category: "correction", text: "that's wrong, do it this way instead" },
    ];

    this.directiveTemplates = [];
    for (const d of directives) {
      const embedding = await this.embed(d.text);
      this.directiveTemplates.push({ ...d, embedding });
    }
    return this.directiveTemplates;
  }

  /** Pre-computed category templates for distillation */
  async getCategoryTemplates(): Promise<TemplateEmbedding[]> {
    if (this.categoryTemplates) return this.categoryTemplates;

    const categories = [
      { category: "decision", text: "we decided to go with this approach" },
      { category: "decision", text: "let's use this option instead" },
      { category: "solution", text: "the fix was to change this" },
      { category: "solution", text: "this worked because of that reason" },
      { category: "discovery", text: "turns out the issue was caused by this" },
      { category: "discovery", text: "I found out that this is how it works" },
    ];

    this.categoryTemplates = [];
    for (const c of categories) {
      const embedding = await this.embed(c.text);
      this.categoryTemplates.push({ ...c, embedding });
    }
    return this.categoryTemplates;
  }

  /** Pre-computed intent templates for autonomous capture */
  async getIntentTemplates(): Promise<TemplateEmbedding[]> {
    if (this.intentTemplates) return this.intentTemplates;

    const intents = [
      { category: "declaration", text: "this is my project" },
      { category: "declaration", text: "that's my app" },
      { category: "declaration", text: "my app is called" },
      { category: "declaration", text: "I built this" },
      { category: "declaration", text: "this is called my tool" },
      { category: "identity", text: "my name is" },
      { category: "identity", text: "my username is" },
      { category: "identity", text: "my account name is" },
      { category: "preference", text: "I like using this tool" },
      { category: "preference", text: "I usually do it this way" },
      { category: "preference", text: "I prefer this approach" },
      { category: "preference", text: "I prefer using this over that" },
      { category: "frustration", text: "this keeps happening over and over" },
      { category: "frustration", text: "why does this always break" },
      { category: "ownership", text: "this belongs to me" },
      { category: "ownership", text: "I own this repository" },
      { category: "ownership", text: "this is my repo" },
    ];

    this.intentTemplates = [];
    for (const i of intents) {
      const embedding = await this.embed(i.text);
      this.intentTemplates.push({ ...i, embedding });
    }
    return this.intentTemplates;
  }

  /** Classify a sentence against templates, return best match if above threshold */
  async classifySentence(
    sentence: string,
    templates: TemplateEmbedding[],
    threshold: number = 0.7
  ): Promise<{ category: string; similarity: number } | null> {
    const sentenceEmb = await this.embed(sentence);
    let bestMatch: { category: string; similarity: number } | null = null;

    for (const tpl of templates) {
      let dot = 0;
      for (let i = 0; i < sentenceEmb.length; i++) {
        dot += sentenceEmb[i] * tpl.embedding[i];
      }
      // Embeddings are L2-normalized, so dot product = cosine similarity
      if (dot >= threshold && (!bestMatch || dot > bestMatch.similarity)) {
        bestMatch = { category: tpl.category, similarity: dot };
      }
    }
    return bestMatch;
  }
}
