# kokoro-tts-demo

本地离线中文语音合成（TTS）Demo：**Node.js + Express 后端 + 纯 HTML 前端**，纯 CPU 推理，无需 GPU、无需联网（首次加载模型除外）。

基于 [Kokoro-82M v1.1-zh](https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX)（82M 参数 StyleTTS2 架构，Apache-2.0，中文数据来自 100 名中文使用者）。

## 特性

- **100 个中文音色**（54 女声 + 46 男声）+ 2 个英语音色，切换零开销（音色 bin 只是 500KB 风格向量）
- **流式合成**：`POST /api/tts/stream` 按句切分、chunked 传输，前端 Web Audio API 边收边播，首句出声约 2.2s
- **中文 G2P 自研实现**（`zh-g2p.js`）：汉字 → 拼音 → 注音符号 + 声调，词边界 `/` 分隔，中英混读
- 纯 CPU 实测 **RTF 0.14 ~ 0.46**（比实时快 2~7 倍），fp32 量化在本机比 q8 快 2.5 倍

## 快速开始

```bash
npm install                 # Express + kokoro-js + pinyin-pro + @node-rs/jieba + phonemizer
node download-voices.js     # 下载 100 个中文音色 bin 到 node_modules/kokoro-js/voices/（可重复执行）
node server.js              # 首次运行自动从 HuggingFace 下载模型并缓存到 ./models
# 打开 http://localhost:3000
```

## 接口

### `POST /api/tts` — 缓冲式合成（返回完整 WAV）

```json
{ "text": "要合成的文本", "voice": "zf_001", "speed": 1.0 }
```

响应：`audio/wav`，响应头 `X-TTS-Latency-ms`（合成耗时）、`X-TTS-Duration-s`（音频时长）。

### `POST /api/tts/stream` — 流式合成（chunked PCM WAV）

参数同上。响应为流式 WAV（长度字段 0xFFFFFFFF 约定），逐句推理逐句下发。客户端断开自动停止推理。

### `GET /api/status` — 服务状态

```json
{ "ready": true, "loading": false, "voices": ["zf_001", "..."] }
```

## 中文 G2P 链路（`zh-g2p.js`）

对照官方 Python 库 [misaki](https://github.com/hexgrad/misaki) v1.1 的行为，纯 JS 离线重写：

```
中文文本
  ├─ URL/邮箱符号规范化    p4.o.mihoyo.com:1666 → p4 点 o 点 mihoyo 点 com 冒号 1666
  ├─ 百分号               25%178 → 百分之二十五 178（% 挪到数字前，前瞻防粘连）
  ├─ 中文标点 → 半角       ，→ ,  。→ .
  ├─ 数字 → 汉字           2024 → 二千零二十四（万/亿分组）
  ├─ jieba 分词 + 词边界    实时离线 → 实时/离线 → 词间插 '/'
  ├─ pinyin-pro 拼音       多音字按词消歧 + toneSandhi 变调（一/不/三声）
  └─ 注音符号映射          ni3 hao3 → ㄋㄧ3ㄏㄠ3（zhi→十 zi→ㄭ ü→ㄩ 等特例）
      英文段：espeak-ng (phonemizer WASM) → IPA 音标（mihoyo → mɪhɔɪoʊ）
      1-2 字母缩写逐字母拼读（P4 → P 四），3+ 字母整词发音
```

## 中间踩过的坑

### 1. kokoro-js 不支持中文（G2P 是纯英文的）

`kokoro-js` 的音素化只走 espeak 的 `en-us`/`en`，`_validate_voice` 用硬编码的 v1.0 英语音色表校验，**中文音色和中文文本全部被拒**。绕过方式：直接调它底层的 `generate_from_ids(input_ids, { voice, speed })`——该路径不校验音色、不做音素化，tokenizer 和 ONNX 推理是语言无关的。中文 G2P 由 `zh-g2p.js` 自己实现，输出 v1.1-zh tokenizer 的注音格式。

### 2. v1.0 模型没有中文音色，v1.1-zh 才有

`Kokoro-82M-v1.0-ONNX` 只有英语音色（`zf_*` 中文音色是 v1.1 加的）。用 `onnx-community/Kokoro-82M-v1.1-zh-ONNX`。注意 `@huggingface/transformers` v4 的 `pipeline('text-to-speech')` 也不认这个模型（`Unsupported model type "style_text_to_speech_2"`）——必须走 `kokoro-js`（v3 系列，它内部处理了 StyleTextToSpeech2 架构）。

### 3. 词边界丢失导致句中怪异停顿

第一版 G2P 输出整串无分隔注音（`ㄓㄜ4ㄕ十4...`），模型找不到词边界，韵律全靠猜——用户反馈「语音合成测试」中间会突然停顿。修复：jieba 分词后**词间插 `/`**（v1.1-zh tokenizer 词表里有 `/`，模型就是按带词边界的格式训练的）。这是对齐官方 misaki `zh_frontend.py` 的 `whitespace='/'` 行为。

### 4. 前端流式播放的 Int16 符号扩展 bug（爆音噪音）

手动拼字节 `(lo | hi << 8)` 做 PCM→Float32 转换时，**负数样本没有符号扩展**：`hi` 的最高位是 1 时（约 47% 的语音样本），`lo | hi<<8` 算出 32768~65535 的正数，除以 32768 得到 1.0~2.0——波形下半周全部翻正，听起来是持续削波爆音。修复：用 `DataView.getInt16(offset, true)`（自带符号扩展）。教训：**验证服务端字节流完整性≠验证浏览器端转换路径**，这个 bug 在 Node 客户端测试里完全测不出来。

### 5. Node 18+ 的 `req.on('close')` 语义变化（流式接口挂死）

Express 流式接口里用 `req.on('close', () => closed = true)` 检测客户端断开——Node 18+ 里**请求体读完后 `'close'` 就会触发**（不再表示 socket 断开），导致循环被误判中断，响应永远挂起（WAV 头发出后 3 分钟无数据）。修复：监听 `res` 的 `'close'` 并排除正常结束：

```js
res.on('close', () => { if (!res.writableEnded) closed = true; });
req.on('aborted', () => { closed = true; });
```

### 6. q8 量化在 CPU 上反而比 fp32 慢 2.5 倍

直觉上 int8 量化更快，实测本机（无 AVX512 VNNI 的消费级 CPU）q8 单句推理 5.7s vs fp32 2.2s——**int8 反量化的逐元素开销超过了矩阵乘法省下的时间**。onnxruntime-node 在 CPU 后端对动态量化 matmul 的优化不佳。结论：CPU 部署先实测再选 dtype，别默认 q8。

### 7. 正则重叠匹配漏配（URL 中间的点丢了）

`([A-Za-z0-9])\.([A-Za-z0-9])` 替换 URL 内部的点：`p4.o.mihoyo.com` 里 `4.o` 匹配消耗了 `o`，`o.m` 的 `o` 已在上一场匹配的捕获组里，**中间点被跳过**。修复：lookbehind/lookahead 断言零宽匹配，不消耗字符：

```js
t.replace(/(?<=[A-Za-z0-9])\.(?=[A-Za-z0-9])/g, ' 点 ');
```

### 8. `%` 不在 tokenizer 字符白名单（静默吞掉）

v1.1-zh tokenizer 的 normalizer 正则把白名单外字符**直接丢弃**（不是报错）——`25%` 的 `%` 无声消失。所有「读不出来」的符号问题都是这个机制。修复在文本规范化阶段：`(\d+)%` → `百分之$1`（注意 `\d+` 捕获完整数字，`\d` 会把 `25%` 劈成 `2百分之5`）。

### 9. zhToPhonemes 变 async 后服务端没 await

接入 espeak 音素化（phonemize 是 async）后 `zhToPhonemes` 返回 Promise，服务端报 `phonemes.split is not a function`。日志里 `[object Promise]` 一眼能看出来，但当时先怀疑了 tokenizer——**先看日志再猜模块**。

### 10. 音色 bin 的实际读取路径

kokoro-js 读音色的路径是 `__dirname/../voices/<name>.bin`，`__dirname` 是 `dist/`——即**包根的 `voices/` 目录**，不是 `dist/voices/`。npm 安装只带英语音色；`download-voices.js` 下载后两个目录都放了一份（`dist/voices/` 是 `npm pack` 的目录结构残留）。

## 已知局限（对齐官方 misaki 行为）

- 英文按 espeak 发音（`P4` 读「P 四」不是「批四」），不翻译语义
- 长数字按整数值读（2024 → 二千零二十四），不做年份读法（二零二四）
- 句末 `.` 保持句号语义，只有「字符.字符」中间的才读「点」
- 模型上下文 512 token，长句自动切分（句间插 0.2s 静音）
- 儿化音、多音字极端 case 以 pinyin-pro 词典为准（未接 misaki 的 must_erhua/not_erhua 例外表）

## 性能实测（本机：Windows 11，消费级 CPU，无 GPU）

| 场景 | 合成耗时 | 音频时长 | RTF |
|---|---|---|---|
| 短句（5 字） | 0.8s | 4.6s | 0.18 |
| 中等（60 字，单段） | 3.9s | 7.1s | 0.54* |
| 中等（60 字，词边界版） | 0.8s | 4.6s | 0.18 |
| 长文本（80 字，3 段流式） | 7.4s | 16.3s | 0.46 |
| 流式首句出声 | 2.2s | — | — |

*q8 时代数据；fp32 + 词边界优化后同场景 0.18。

## 技术栈

| 组件 | 作用 |
|---|---|
| [kokoro-js](https://www.npmjs.com/package/kokoro-js) 1.2.1 | ONNX 推理封装（tokenizer + `generate_from_ids`） |
| [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) 3.8.1 | onnxruntime-node 后端（kokoro-js 依赖，v4 不支持此模型） |
| [pinyin-pro](https://www.npmjs.com/package/pinyin-pro) | 汉字→拼音（多音字消歧 + 变调），纯 JS 词典 |
| [@node-rs/jieba](https://www.npmjs.com/package/@node-rs/jieba) | 中文分词（词边界），Rust binding |
| [phonemizer](https://www.npmjs.com/package/phonemizer) | espeak-ng WASM，英文→IPA |
| Express | HTTP 服务 + 静态页 + chunked 流式 |

## License

- 本仓库代码：随仓库 LICENSE
- Kokoro-82M 模型：Apache-2.0（hexgrad）
- misaki G2P 映射参照：Apache-2.0（hexgrad，改编自 PaddlePaddle Apache-2.0）
