/** 文本向量端口 —— 核心层只依赖这个接口，不直接依赖 transformers/ONNX。 */
export interface EmbeddingPort {
  /** 模型标识，仅用于可观测性。 */
  readonly model: string;
  /** 批量编码；返回与输入等长的向量。 */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}
