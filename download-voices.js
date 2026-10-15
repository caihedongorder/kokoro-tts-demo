// 从 onnx-community/Kokoro-82M-v1.1-zh-ONNX 下载全部中文音色 bin
// 用法：node download-voices.js  （可重复执行，已存在的跳过）
// 注意：bin 必须放在 kokoro-js 包的 voices/ 目录（它从那里读取）
const https = require('https');
const fs = require('fs');
const path = require('path');

const REPO = 'onnx-community/Kokoro-82M-v1.1-zh-ONNX';
const VOICES_DIR = path.join(path.dirname(require.resolve('kokoro-js')), 'voices');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return getJSON(r.headers.location).then(resolve, reject);
      }
      if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode + ' ' + url));
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'node' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        return download(r.headers.location, dest).then(resolve, reject);
      }
      if (r.statusCode !== 200) return reject(new Error('HTTP ' + r.statusCode + ' ' + url));
      const f = fs.createWriteStream(dest);
      r.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(VOICES_DIR, { recursive: true });
  console.log('voices dir:', VOICES_DIR);
  // 1) 拉仓库文件列表，筛出中文音色 bin
  const meta = await getJSON(`https://huggingface.co/api/models/${REPO}`);
  const wanted = (meta.siblings || [])
    .map((s) => s.rfilename)
    .filter((f) => /^voices\/(zf|zm)_\d+\.bin$/.test(f))
    .map((f) => f.replace('voices/', ''));
  console.log(`仓库中文音色: ${wanted.length} 个`);

  // 2) 过滤本地已有的（>1000 字节视为完整）
  const todo = wanted.filter((v) => {
    const p = path.join(VOICES_DIR, v);
    return !(fs.existsSync(p) && fs.statSync(p).size > 1000);
  });
  console.log(`需下载: ${todo.length} 个（已有 ${wanted.length - todo.length}）`);
  if (!todo.length) { console.log('ALL DONE'); return; }

  // 3) 并发下载（并发 8）
  let done = 0, fail = 0;
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const v = queue.shift();
      const url = `https://huggingface.co/${REPO}/resolve/main/voices/${v}`;
      try {
        await download(url, path.join(VOICES_DIR, v));
        done++;
        if (done % 20 === 0) console.log(`进度: ${done}/${todo.length}`);
      } catch (e) {
        fail++;
        console.error('FAIL', v, e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`完成: ${done} 失败: ${fail}`);
  console.log('ALL DONE');
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
