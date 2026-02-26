/**
 * @rbrtdds/acp-embeddings — Local embedding provider using transformers.js
 *
 * Uses Xenova/all-MiniLM-L6-v2 (384 dimensions) by default.
 * Model is downloaded on first use and cached locally.
 *
 * Usage:
 *   import { LocalEmbeddingProvider } from '@rbrtdds/acp-embeddings';
 *   const provider = new LocalEmbeddingProvider();
 *   await provider.initialize();
 *   acp.setEmbeddingProvider(provider);
 */

import { pipeline, env } from '@huggingface/transformers';
import type { EmbeddingProvider } from '@rbrtdds/acp-core';
import { join } from 'path';
import { homedir } from 'os';

// Disable browser-specific features when running in Node.js
env.allowLocalModels = true;
env.useBrowserCache = false;

/** Default model — fast, small (30MB), 384 dimensions, good quality */
const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_CACHE_DIR = join(homedir(), '.acp', 'models');

export interface LocalEmbeddingOptions {
  /** HuggingFace model ID (must have ONNX weights) */
  model?: string;
  /** Expected embedding dimensions */
  dimensions?: number;
  /** Local cache directory for downloaded models */
  cacheDir?: string;
  /** Use quantized model (faster, smaller, slightly less accurate) */
  quantized?: boolean;
}

/**
 * Local embedding provider using transformers.js (ONNX runtime).
 * Runs entirely offline after first model download.
 */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  private dimensions: number;
  private cacheDir: string;
  private quantized: boolean;
  private extractor: any = null;

  constructor(options: LocalEmbeddingOptions = {}) {
    this.model = options.model || DEFAULT_MODEL;
    this.dimensions = options.dimensions || DEFAULT_DIMENSIONS;
    this.cacheDir = options.cacheDir || DEFAULT_CACHE_DIR;
    this.quantized = options.quantized ?? true;
  }

  /**
   * Initialize the embedding pipeline. Downloads model on first call.
   * Must be called before embed() or embedBatch().
   */
  async initialize(): Promise<void> {
    if (this.extractor) return;

    env.cacheDir = this.cacheDir;

    this.extractor = await pipeline('feature-extraction', this.model, {
      quantized: this.quantized,
      dtype: 'q8', // 8-bit quantized — ~4x less RAM than fp32
    });
  }

  /**
   * Embed a single text string.
   */
  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) {
      await this.initialize();
    }

    const output = await this.extractor(text, {
      pooling: 'mean',
      normalize: true,
    });

    const embedding = this.extractFloat32Array(output);

    // Dispose tensor to free ONNX memory
    if (typeof output?.dispose === 'function') {
      output.dispose();
    }

    return embedding;
  }

  /**
   * Embed multiple texts sequentially.
   * Processes one at a time and disposes tensors to prevent memory leaks.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) {
      await this.initialize();
    }

    const results: Float32Array[] = [];

    for (const text of texts) {
      const output = await this.extractor(text, {
        pooling: 'mean',
        normalize: true,
      });

      // Copy the data out immediately
      const embedding = this.extractFloat32Array(output);
      results.push(embedding);

      // Dispose tensor to free ONNX memory
      if (typeof output?.dispose === 'function') {
        output.dispose();
      }
    }

    return results;
  }

  /**
   * Get the model name.
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Get the embedding dimensions.
   */
  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Extract Float32Array from pipeline output.
   * Handles both single and batch outputs.
   */
  private extractFloat32Array(output: any): Float32Array {
    // transformers.js Tensor — .data contains the raw typed array
    if (output?.data instanceof Float32Array) {
      // Single input → first (and only) embedding
      if (output.dims?.length === 3) {
        // Shape: [1, seq_len, hidden_size] after pooling → [1, hidden_size]
        return new Float32Array(output.data.slice(0, this.dimensions));
      }
      if (output.dims?.length === 2) {
        return new Float32Array(output.data.slice(0, this.dimensions));
      }
      return new Float32Array(output.data);
    }

    // Fallback: try to get .tolist() or raw array
    if (typeof output?.tolist === 'function') {
      const list = output.tolist();
      const flat = Array.isArray(list[0]) ? list[0] : list;
      return new Float32Array(flat);
    }

    throw new Error('Unexpected embedding output format');
  }
}
