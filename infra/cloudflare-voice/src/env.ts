export interface AiBinding {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  AI: AiBinding;
  MeiVoiceAgent: DurableObjectNamespace;
  CallLog: DurableObjectNamespace;
  ORDER_API_BASE_URL: string;
  INTERNAL_API_KEY: string;
  /** Shared with the carrier's call-instruction URL; proves /voice was requested by our phone line. */
  CARRIER_KEY: string;
  /** Signs the short-lived token that lets one call open its audio stream. */
  STREAM_SIGNING_KEY: string;
  STORE_ID: string;
  STORE_NAME: string;
  LLM_MODEL: string;
  TTS_MODEL: string;
  TTS_SPEAKER: string;
}
