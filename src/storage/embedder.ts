import {
  pipeline,
  env,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { MODELS_DIR } from "./paths.js";

const MAX_CACHE = 100;

export class Embedder {
  private extractor: FeatureExtractionPipeline | null = null;
  private cache = new Map<string, Float32Array>();

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
}
