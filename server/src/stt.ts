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

/**
 * 任务 B 第一步：语音转文字（Whisper）
 * 走 OpenAI 兼容协议，可对接 Groq 免费档 / OpenAI 官方 / 自部署服务。
 */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  if (env.mockAi) {
    return '这是模拟模式下的语音转写结果，接入真实密钥后即可转写真语音。';
  }
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
