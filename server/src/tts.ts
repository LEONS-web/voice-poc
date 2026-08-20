import { env } from './config.js';

/** 生成一段正弦波 WAV（模拟模式下代替 ElevenLabs，让前端音频链路也能完整演示） */
function generateToneWav(seconds = 1.2, freq = 440): Buffer {
  const sampleRate = 44100;
  const n = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2 * Math.PI * freq * (i / sampleRate)) * 0.3 * 32767);
    buf.writeInt16LE(v, 44 + i * 2);
  }
  return buf;
}

/**
 * 任务 C：ElevenLabs 流式 TTS
 * 调用 /text-to-speech/{voice_id}/stream 接口，边接收边通过回调推送音频块，
 * 服务端再把音频块经 WebSocket 实时转发给前端，实现流式播放。
 *
 * @returns 'sent' 表示已推送音频；'skipped' 表示未配置密钥（任务 C 为可选加分项）
 */
export async function synthesizeStream(
  text: string,
  onChunk: (chunk: Buffer) => void
): Promise<'sent' | 'skipped'> {
  if (env.mockAi) {
    onChunk(generateToneWav());
    return 'sent';
  }
  if (!env.tts.apiKey) return 'skipped';

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${env.tts.voiceId}/stream?output_format=mp3_44100_128`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': env.tts.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: env.tts.modelId,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs 请求失败 (${res.status}): ${detail.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) onChunk(Buffer.from(value));
  }
  return 'sent';
}
