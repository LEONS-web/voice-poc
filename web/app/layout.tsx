import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '语音 AI 链路 PoC',
  description: 'Next.js 14 + Fastify + WebSocket + Whisper + LLM + ElevenLabs 流式 TTS',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
