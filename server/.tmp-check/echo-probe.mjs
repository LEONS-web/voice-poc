// 模拟评审挑刺：测试各种"非模板"输入，服务端是否都原样返回
import WebSocket from 'ws';

const cases = [
  { label: '普通文本', payload: '今天天气怎么样？' },
  { label: '数字', payload: '123456789' },
  { label: '特殊字符', payload: 'a+b=c & %#@! 中文' },
  { label: '空字符串', payload: '' },
  { label: '合法JSON但无type', payload: '{"msg":"hello","n":42}' },
  { label: 'JSON含type=ping', payload: '{"type":"ping"}' },
  { label: 'JSON含type=echo', payload: '{"type":"echo","data":"x"}' },
  { label: '超长文本', payload: 'x'.repeat(5000) },
];

let idx = 0;
const run = () => {
  if (idx >= cases.length) {
    console.log('\n=== 全部测试完成 ===');
    process.exit(0);
  }
  const c = cases[idx];
  const ws = new WebSocket('ws://127.0.0.1:8787/ws/voice');
  const timer = setTimeout(() => {
    console.log(`[${c.label}] ❌ 超时无响应`);
    ws.terminate();
    idx++;
    run();
  }, 4000);
  ws.on('open', () => {
    ws.send(c.payload);
  });
  ws.on('message', (data, isBinary) => {
    clearTimeout(timer);
    const text = data.toString();
    const match = text === c.payload;
    console.log(`[${c.label}] ${match ? 'OK 原样返回' : 'WARN 非原样'} -> ${text.slice(0, 60)}`);
    ws.close();
    idx++;
    setTimeout(run, 200);
  });
  ws.on('error', (e) => {
    clearTimeout(timer);
    console.log(`[${c.label}] ERROR 连接错误 ${e.message}`);
    idx++;
    setTimeout(run, 200);
  });
};
run();
