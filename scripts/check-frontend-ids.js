'use strict';
/**
 * 前端 id 静态检查 —— 捕捉「改了 id、JS 里还按旧名字取元素」这类静默错误。
 *
 * 规则：
 *   · 前端 JS（`public/app.mjs` + `public/modules/*.mjs`）里 $('x') / getElementById('x')
 *     引用的 id，必须出现在 index.html，或出现在前端 JS 自己的模板字符串里
 *     （弹窗、策略面板是动态注入的）。
 *   · index.html 里重复的 id 一律报错（HTML 无效，浏览器只认第一个）。
 *   · HTML 声明但没人引用、CSS 里写了但元素不存在的 id —— 只提示，不阻断。
 *
 * 为什么不是只扫 $('x')：动态注入的节点在页面初始 HTML 里不存在，
 * 只看 index.html 会把它误报成"缺失"。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = {
  html: path.join(ROOT, 'panel', 'public', 'index.html'),
  css: path.join(ROOT, 'panel', 'public', 'style.css'),
};

/** 前端所有 JS 源文件：入口 app.mjs + modules/*.mjs。 */
function listJsFiles() {
  const out = [];
  const ls = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) ls(full);
      else if (entry.name.endsWith('.mjs')) out.push(full);
    }
  };
  ls(path.join(ROOT, 'panel', 'public'));
  return out.sort();
}

/** 扫描一个字符串里形如 id="xxx" 的属性。 */
function idsInMarkup(text) {
  const ids = [];
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) ids.push(m[1]);
  return ids;
}

/** JS 里读取元素的写法：$('#x') / $('x') / getElementById('x') / deps.query('#x')（可注入的选择器）。 */
function referencedIds(js) {
  const ids = new Set();
  let m;
  const reJq = /\$\('(?:#)?([A-Za-z0-9_-]+)'\)/g;
  while ((m = reJq.exec(js))) ids.add(m[1]);
  const reQuery = /\.query\('(?:#)?([A-Za-z0-9_-]+)'\)/g;
  while ((m = reQuery.exec(js))) ids.add(m[1]);
  const reDom = /getElementById\('([A-Za-z0-9_-]+)'\)/g;
  while ((m = reDom.exec(js))) ids.add(m[1]);
  return ids;
}

/** CSS 里的 #id 选择器（排除 #fff 这类颜色值）。 */
function cssIds(css) {
  const ids = new Set();
  const re = /#([A-Za-z][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = re.exec(css))) {
    if (/^[0-9a-fA-F]{3,8}$/.test(m[1])) continue; // #fff / #1a2b3c
    ids.add(m[1]);
  }
  return ids;
}

/**
 * 纯函数入口：喂文本，返回分析结果（供单测直接调用）。
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
function analyze({ html, js, css }) {
  const errors = [];
  const warnings = [];

  const htmlIdsList = idsInMarkup(html);
  const counts = new Map();
  for (const id of htmlIdsList) counts.set(id, (counts.get(id) || 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) errors.push(`index.html 里 id="${id}" 重复出现 ${n} 次`);
  }

  const declaredInHtml = new Set(htmlIdsList);
  const declaredInJs = new Set(idsInMarkup(js)); // 动态注入的模板
  const declared = new Set([...declaredInHtml, ...declaredInJs]);
  const refs = referencedIds(js);

  for (const id of refs) {
    if (!declared.has(id)) errors.push(`前端 JS 引用了 #${id}，但 index.html 与前端模板里都没有这个 id`);
  }
  for (const id of declaredInHtml) {
    if (!refs.has(id)) warnings.push(`index.html 声明了 #${id}，但前端 JS 没有引用（可能是死代码）`);
  }
  for (const id of cssIds(css)) {
    if (!declared.has(id)) warnings.push(`style.css 里有 #${id} 选择器，但页面/模板里没有这个 id`);
    else if (!refs.has(id)) warnings.push(`style.css 里有 #${id} 选择器，但前端 JS 没有引用它`);
  }

  return { errors, warnings, stats: { referenced: refs.size, declaredHtml: declaredInHtml.size, declaredTemplate: declaredInJs.size, css: cssIds(css).size } };
}

function main() {
  const html = fs.readFileSync(FILES.html, 'utf8');
  const jsFiles = listJsFiles();
  const js = jsFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const css = fs.readFileSync(FILES.css, 'utf8');
  const { errors, warnings, stats } = analyze({ html, js, css });

  for (const w of warnings) console.log('warn  ' + w);
  for (const e of errors) console.log('ERROR ' + e);
  console.log(
    `前端 id 检查：${jsFiles.length} 个 JS 文件，引用 ${stats.referenced}，HTML 声明 ${stats.declaredHtml}，模板声明 ${stats.declaredTemplate}，` +
    `CSS 选择器 ${stats.css}，错误 ${errors.length}，提示 ${warnings.length}`
  );
  return errors.length === 0 ? 0 : 1;
}

if (require.main === module) process.exitCode = main();

module.exports = { analyze, idsInMarkup, referencedIds, cssIds, listJsFiles };
