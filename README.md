# Voice AI 链路 PoC

基于 WebSocket 的语音 AI 全链路演示项目：前端录音，经服务端完成语音转写（STT）、大模型回复（LLM）、流式语音合成（TTS）后回放。

技术栈：Next.js 14 (App Router) · Fastify · WebSocket · Whisper STT · LLM · ElevenLabs 流式 TTS

## 功能

| 任务 | 说明 | 状态 |
|---|---|---|
| A · WebSocket Echo | Fastify `/ws/voice`，前端发送文本，服务端原样返回 | 已完成，附自动化冒烟测试 |
| B · STT + LLM 回复 | 前端录音 3 秒 → 语音转写 → LLM 生成文本回复 | 已完成，真实链路验证通过 |
| C · 流式 TTS | LLM 回复转为流式音频，经 WebSocket 实时推回前端播放 | 已完成，真实链路验证通过 |

三项任务均已在真实服务环境下验证（百炼 Qwen-ASR 转写、Qwen-Plus 回复、ElevenLabs 流式合成）。

## 目录结构

```
voice-poc/
├── server/                 Fastify 后端（端口 8787）
│   ├── src/
│   │   ├── index.ts        入口：CORS + WebSocket 插件
│   │   ├── ws.ts           /ws/voice 路由与消息协议
│   │   ├── stt.ts          语音转写（OpenAI 兼容 / 百炼 Qwen-ASR 双协议）
│   │   ├── llm.ts          LLM 回复（OpenAI 兼容协议）
│   │   ├── tts.ts          ElevenLabs 流式 TTS（含模拟模式降级）
│   │   └── config.ts       环境变量集中管理
│   └── scripts/            ws-smoke-test.mjs 冒烟测试、verify-api.mjs 密钥验证
└── web/                    Next.js 14 前端（端口 3000）
    └── app/page.tsx        单页 Demo
```

## 快速开始

需要 Node.js ≥ 18.17（建议 20/22 LTS）。

```bash
# 1. 安装依赖
npm run setup

# 2. 配置环境变量
cd server
cp .env.example .env       # Windows: copy .env.example .env
# 已内置演示用 API key（百炼 / ElevenLabs 免费额度），无需额外申请即可运行真实链路；
# 如需改用自己的账号，直接编辑 .env 替换即可；无任何 key 时设 MOCK_AI=1 可跑模拟模式

# 3. 启动前后端（根目录执行）
npm run dev
# 后端 http://localhost:8787  前端 http://localhost:3000
```

### 验证任务 A

保持后端运行，另开终端执行：

```bash
npm run smoke
# 输出 "PASS: 任务 A WebSocket Echo 验证通过" 即成功
```

## 环境变量（server/.env）

| 变量 | 说明 |
|---|---|
| `MOCK_AI` | `1`=模拟模式（无需密钥）；`0`=真实链路 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容的 LLM 服务（阿里云百炼 / DeepSeek / OpenAI / Moonshot 等） |
| `STT_PROVIDER` | `openai`=标准 Whisper 接口（Groq / OpenAI）；`qwen-asr`=百炼 Qwen-ASR |
| `WHISPER_BASE_URL` / `WHISPER_API_KEY` / `WHISPER_MODEL` | 语音转写服务（与 STT_PROVIDER 配套） |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | ElevenLabs TTS（可选，未配置时任务 C 自动跳过）。注意：免费档仅可使用账号 premade 声音（如 Sarah `EXAVITQu4vr4xnSDxMaL`），声音库第三方声音需付费档 |

## 实现说明

- LLM 层采用 OpenAI 兼容协议抽象，切换服务商只需改环境变量；如需 Anthropic 原生协议，替换 `llm.ts` 内部实现即可。
- STT 层支持标准 Whisper transcriptions 接口与百炼 Qwen-ASR（chat completions + input_audio），通过 `STT_PROVIDER` 切换。
- 前端录音经 Web Audio API 解码后重编码为 16kHz 单声道 WAV 再发送，保证转写兼容性（零额外依赖）。
- 消息协议分层：文本帧承载 JSON 控制消息，二进制帧承载音频数据。
- 容错：录音期间拒绝新请求、转写为空返回明确错误、TTS 未配置时优雅降级（`audio_skipped`）。
- 启动日志仅报告密钥是否已配置，不打印明文。

## 正式项目扩展路径

本 PoC 的核心链路（WebSocket 语音通道 + STT/LLM/TTS 三层）可直接作为正式产品的基础模块，向客户 12 周项目技术栈的扩展路径如下：

| 正式项目技术 | 扩展方式 |
|---|---|
| Supabase（PostgreSQL）+ Prisma ORM | 在 `ws.ts` 的 `done` 事件后持久化会话记录与转写/回复文本；新增 Prisma schema 定义 User / VoiceSession / Feedback 表 |
| Redis（Upstash） | 用 Redis 存储 WebSocket 会话状态（多实例共享）与请求限流；连接层已按 `processing` 串行化，天然适合接入令牌桶限流 |
| Claude API（角色扮演） | `llm.ts` 已是独立模块，替换内部实现为 Anthropic 原生协议即可；角色扮演由 systemPrompt 参数化驱动 |
| Stripe 订阅 | 前端接入 Stripe Checkout，WebSocket 握手阶段校验订阅状态（连接钩子中鉴权） |
| 音频存储 | 将 TTS 音频块落盘到 S3/R2，会话结束后生成回放链接 |

三层模块（`stt.ts` / `llm.ts` / `tts.ts`）均无业务耦合，可独立演进或替换实现。
