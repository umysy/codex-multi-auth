'use strict';
/**
 * 编码闸门：这个仓库里有三类对编码极其敏感的文件，
 * 被编辑器"顺手转成 UTF-8"就会静默失效（脚本能打开、运行却报错 / 中文全变问号）。
 *
 *   1. *.vbs          → 必须是 UTF-16LE + BOM，否则 wscript 读中文注释会乱码甚至报错；
 *   2. *.ps1/*.cs/*.csproj → 含非 ASCII 时必须带 UTF-8 BOM，
 *                        否则 Windows PowerShell 5.1 按 ANSI 解码，中文提示语全乱；
 *   3. 任何 UTF-16 文件 → 必须有 BOM，无 BOM 的 UTF-16 谁读都是概率性乱码。
 *
 * 另外顺带校验所有 *.json 可解析（配置模板坏了比代码坏了更难查）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = /[\\/](\.git|node_modules|bin|obj|versions|usage|cache|tmp|runtime-shadow-homes|app-bind)[\\/]/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const BOM_UTF8 = [0xef, 0xbb, 0xbf];
const hasPrefix = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const hasNonAscii = (text) => /[^\x00-\x7F]/.test(text);

const files = walk(ROOT).sort();
const errors = [];
let checked = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const ext = path.extname(file).toLowerCase();
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    errors.push(`${rel}: 无法读取 (${err.message})`);
    continue;
  }
  const utf8Bom = hasPrefix(buf, BOM_UTF8);
  const utf16leBom = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
  const utf16beBom = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;

  // 0. 重复 UTF-8 BOM：PowerShell 5.1 只吃掉第一个 BOM，第二个会变成命令名的一部分，
  //    首行 param(...) 直接报 CommandNotFoundException（脚本看着"能跑"、其实参数全丢）。
  if (utf8Bom && buf.length >= 6 && hasPrefix(buf.subarray(3), BOM_UTF8)) {
    checked++;
    errors.push(`${rel}: 开头有重复 UTF-8 BOM（EF BB BF ×2），应只保留一个`);
    continue;
  }

  // 1. VBS：wscript 需要 UTF-16LE + BOM
  if (ext === '.vbs') {
    checked++;
    if (!utf16leBom) {
      errors.push(`${rel}: .vbs 必须是 UTF-16LE + BOM（wscript 才能正确读中文），当前不是`);
    }
    continue;
  }

  // 2. PowerShell / C# / 工程文件：含非 ASCII 必须带 UTF-8 BOM
  if (ext === '.ps1' || ext === '.cs' || ext === '.csproj' || ext === '.xaml') {
    checked++;
    if (utf16leBom || utf16beBom) {
      errors.push(`${rel}: 不要用 UTF-16 存 ${ext}，请存成 UTF-8（含中文时带 BOM）`);
      continue;
    }
    const textBuf = utf8Bom ? buf.subarray(3) : buf;
    const text = textBuf.toString('utf8');
    if (hasNonAscii(text) && !utf8Bom) {
      errors.push(`${rel}: 含中文但没有 UTF-8 BOM，Windows PowerShell 5.1 / csc 会按 ANSI 解码导致乱码`);
    }
    continue;
  }

  // 3. 其他文件不允许无 BOM 的 UTF-16
  if ((utf16leBom || utf16beBom) && ext !== '.vbs') {
    errors.push(`${rel}: 非 .vbs 文件不要用 UTF-16 存储，请转成 UTF-8`);
    continue;
  }

  // 4. JSON 必须可解析（容忍 BOM）
  if (ext === '.json') {
    checked++;
    try {
      JSON.parse((utf8Bom ? buf.subarray(3) : buf).toString('utf8'));
    } catch (err) {
      errors.push(`${rel}: JSON 解析失败 - ${err.message}`);
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`[编码问题] ${e}`);
  console.error('');
}
console.log(`编码检查：${checked} 个敏感文件，${errors.length} 个问题`);
process.exit(errors.length === 0 ? 0 : 1);
