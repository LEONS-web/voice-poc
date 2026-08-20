import OpenAI from 'openai';
import { env } from './config.js';

/** 根据浏览器录音的 MIME 类型推断文件扩展名（Whisper 兼容接口按文件内容解析，扩展名辅助判断） */
function extFromMime(mime: string): string {
  if (mime.includes('mp4') || mime.includes('aac')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

/** 标准 Whisper 兼容接口（Groq 免费档 / OpenAI 官方）：POST /audio/transcriptions */
async function transcribeWithWhisper(audio: Buffer, mimeType: string): Promise<string> {
  const client = new OpenAI({ baseURL: env.stt.baseUrl, apiKey: env.stt.apiKey });
  const ext = extFromMime(mimeType);
  // 复制为独立的 Uint8Array，避免 Buffer 底层 ArrayBuffer 类型不兼容
  const bytes = Uint8Array.from(audio);
  const file = new File([bytes], `audio.${ext}`, { type: mimeType || 'audio/webm' });
  const res = await client.audio.transcriptions.create({
    file,
    model: env.stt.model,
  });
  return (res.text ?? '').trim();
}

/**
 * 百炼 Qwen-ASR（qwen3-asr-flash）：走 OpenAI 兼容的 chat completions 接口，
 * 音频以 base64 Data URL 形式通过 input_audio 传入（非标准 transcriptions 接口）。
 */
async function transcribeWithQwenAsr(audio: Buffer, mimeType: string): Promise<string> {
  const client = new OpenAI({ baseURL: env.stt.baseUrl, apiKey: env.stt.apiKey });
  const dataUri = `data:${mimeType || 'audio/webm'};base64,${audio.toString('base64')}`;
  const res = await client.chat.completions.create({
    model: env.stt.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: dataUri },
          },
        ],
      },
    ] as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
    // 非标准参数：指定识别语种为中文，提升准确率
    asr_options: { language: 'zh', enable_itn: true },
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);
  const content: unknown = res.choices[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  // 部分情况下 content 以数组形式返回（[{ text }]）
  if (Array.isArray(content)) {
    return content
      .map((part: { text?: string }) => part?.text ?? '')
      .join('')
      .trim();
  }
  return '';
}

/**
 * 任务 B 第一步：语音转文字（STT）
 * 按 STT_PROVIDER 分发：
 *  - openai   ：标准 Whisper 兼容接口（Groq 免费档 / OpenAI 官方）
 *  - qwen-asr ：阿里云百炼 Qwen-ASR（与 LLM 共用一个百炼 key）
 */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  if (env.mockAi) {
    return '这是模拟模式下的语音转写结果，接入真实密钥后即可转写真语音。';
  }
  if (env.stt.provider === 'qwen-asr') {
    return transcribeWithQwenAsr(audio, mimeType);
  }
  return transcribeWithWhisper(audio, mimeType);
}
