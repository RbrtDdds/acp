declare module '@huggingface/transformers' {
  export function pipeline(
    task: string,
    model?: string,
    options?: Record<string, any>
  ): Promise<any>;

  export const env: {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
    cacheDir: string;
    [key: string]: any;
  };
}
