import type { TTSProvider } from 'agents/voice';
import type { AiBinding } from './env';

/**
 * Text-to-speech that returns raw 16 kHz 16-bit PCM. The SDK's built-in
 * Workers AI provider returns MP3, which cannot be decoded inside a Worker and
 * so cannot be converted to the 8 kHz mu-law audio a phone line needs.
 */
export class PcmTTS implements TTSProvider {
  constructor(
    private readonly ai: AiBinding,
    private readonly model: string,
    private readonly speaker: string
  ) {}

  async synthesize(text: string): Promise<ArrayBuffer | null> {
    const result = await this.ai.run(
      this.model,
      { text, speaker: this.speaker, encoding: 'linear16', container: 'none', sample_rate: 16000 },
      { returnRawResponse: true }
    );
    if (result instanceof Response) return result.ok ? result.arrayBuffer() : null;
    if (result instanceof ArrayBuffer) return result;
    if (result instanceof ReadableStream) return new Response(result).arrayBuffer();
    return null;
  }
}
