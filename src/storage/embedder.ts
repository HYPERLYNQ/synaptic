import {
  pipeline,
  env,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { MODELS_DIR } from "./paths.js";

export class Embedder {
  private extractor: FeatureExtractionPipeline | null = null;

  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) {
      env.cacheDir = MODELS_DIR;
      // @ts-expect-error -- pipeline() union type too complex for TS; runtime type is correct
      this.extractor = await pipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
        { dtype: "q8" },
      );
    }
    const result = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    return result.data as Float32Array;
  }
}
