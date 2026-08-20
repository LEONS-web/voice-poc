# 语音 AI 链路 PoC（竞标试做）

技术栈：**Next.js 14 (App Router) + Fastify + WebSocket + Whisper STT + LLM + ElevenLabs 流式 TTS**

## 任务完成度

| 任务 | 状态 | 说明 |
|---|---|---|
| A · WebSocket Echo | ✅ | Fastify `/ws/voice`，前端连接后发文本原样返回；附自动化冒烟测试 |
| B · Whisper STT + LLM 回复 | ✅ | 前端录音 3 秒 → Whisper 转写 → LLM 生成回复 |
| C · ElevenLabs 流式 TTS | ✅ | LLM 回复转流式音频，经 WebSocket 实时推回前端播放 |

## 目录结构

```
voice-poc/
├── server/                 Fastify 后端（端口 8787）
│   ├── src/
│   │   ├── index.ts        入口：CORS + WebSocket 插件
│   │   ├── ws.ts           /ws/voice 路由与消息协议
│   │   ├── stt.ts          Whisper 转写（OpenAI 兼容协议）
│   │   ├── llm.ts          LLM 回复（可切换任意 OpenAI 兼容服务）
│   │   ├── tts.ts          ElevenLabs 流式 TTS
│   │   └── config.ts       环境变量集中管理
│   └── scripts/ws-smoke-test.mjs   任务 A 自动化冒烟测试
└── web/                    Next.js 14 前端（端口 3000）
    └── app/page.tsx        单页 Demo
```

## 快速开始

> 需要 Node.js ≥ 18.17（建议 20/22 LTS）

```bash
# 1. 安装依赖
npm run setup

# 2. 配置环境变量（首次可先用模拟模式跑通全链路）
cd server
cp .env.example .env       # Windows: copy .env.example .env
# 编辑 .env：无密钥时设 MOCK_AI=1；有密钥时填入并设 MOCK_AI=0

# 3. 启动前后端（根目录执行）
npm run dev
# 后端 http://localhost:8787  前端 http://localhost:3000
```

### 自动化验证任务 A

```bash
# 保持后端运行，另开终端执行：
npm run smoke
# 输出 "PASS: 任务 A WebSocket Echo 验证通过" 即成功
```

## 演示步骤（录屏脚本）

1. 打开 `http://localhost:3000`，确认"连接状态"显示已连接
2. **任务 A**：在 Echo 卡片输入任意文本 → 点击"发送并回显" → 下方显示服务端原样返回
3. **任务 B/C**：点击"开始录音" → 允许麦克风权限 → 对麦克风说一句话（3 秒）
4. 观察页面依次出现：Whisper 转写文字 → LLM 回复文字 → 音频自动播放
5. 运行日志卡片全程展示各阶段状态

## 环境变量说明（server/.env）

| 变量 | 说明 |
|---|---|
| `MOCK_AI` | `1`=模拟模式（无需密钥，STT/LLM 返回模拟数据，TTS 生成提示音）；`0`=真实链路 |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI 兼容的 LLM 服务（阿里云百炼 / DeepSeek / OpenAI / Moonshot 等） |
| `STT_PROVIDER` | `openai`=标准 Whisper 接口（Groq / OpenAI）；`qwen-asr`=百炼 Qwen-ASR |
| `WHISPER_BASE_URL` / `WHISPER_API_KEY` / `WHISPER_MODEL` | 语音转写服务（与 STT_PROVIDER 配套） |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID` | ElevenLabs TTS（可选，未配置时任务 C 自动跳过）⚠️ 免费档 API 只能用账号 premade 声音（如 Sarah `EXAVITQu4vr4xnSDxMaL`），声音库第三方声音需付费档 |

## 设计要点

- **LLM 层采用 OpenAI 兼容协议抽象**：切换服务商只需改环境变量，不改代码；如需 Anthropic 原生协议仅替换 `llm.ts` 内部实现
- **STT 双协议适配**：同时支持标准 Whisper transcriptions 接口与百炼 Qwen-ASR（chat completions + input_audio），通过 `STT_PROVIDER` 切换
- **前端录音格式统一**：浏览器 MediaRecorder 输出 webm，前端用 Web Audio API 解码后重新编码为 16kHz 单声道 WAV 再发送，确保 STT 兼容性并压缩体积（零额外依赖）
- **消息协议清晰分层**：文本帧走 JSON 控制消息，二进制帧走音频数据，前后端解耦
- **容错**：录音期间拒绝新请求、转写为空报错、TTS 未配置优雅降级，错误经 `error` 消息回传前端
- **日志不泄露密钥**：启动日志只报告密钥"是否已配置"，不打印明文
