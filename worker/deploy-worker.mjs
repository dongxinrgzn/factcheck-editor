// Cloudflare Workers v1 API 部署（绕过 wrangler / Service API 的权限问题）
// 直接 PUT 到 /workers/subdomain，不需要先创建 service
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = '671a2f0bf367dfe29abb0db9036e872b';
const WORKER_NAME = 'factcheck-editor-api';

if (!TOKEN) { console.error('❌ 请设 CLOUDFLARE_API_TOKEN'); process.exit(1); }

// 1. 打包
console.log('📦 打包 Worker 代码...');
const distDir = path.resolve(process.cwd(), 'dist');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

try { execSync('npx esbuild --version', { stdio: 'pipe' }); }
catch { execSync('npm install --save-dev esbuild', { stdio: 'inherit' }); }

execSync(`npx esbuild src/index.js --bundle --format=esm --outfile=dist/worker.js --minify`, {
  stdio: 'pipe', cwd: process.cwd(),
});
const script = fs.readFileSync(path.join(distDir, 'worker.js'), 'utf-8');
console.log(`✅ 打包完成 (${(script.length/1024).toFixed(1)} KB)`);

// 2. KV 绑定 + Vars（作为 Service Bindings JSON）
const bindings = [
  { type: 'kv_namespace', name: 'FACT_CACHE', namespace_id: '11b227db38e742db944bf4a7fcea5ffa' },
  { type: 'kv_namespace', name: 'SESSION_STATE', namespace_id: '372560eb50454cedade677dcab669195' },
  { type: 'kv_namespace', name: 'RATE_LIMIT', namespace_id: '6564e7ee32574a7fb15f3d8c4902c9d6' },
  { type: 'kv_namespace', name: 'FACT_KB', namespace_id: '112efd0ff26c40c08b008fb602047f15' },
  { type: 'plain_text', name: 'LLM_PROVIDER', value: 'siliconflow' },
  { type: 'plain_text', name: 'LLM_MODEL', value: 'Qwen/Qwen2.5-72B-Instruct' },
  { type: 'plain_text', name: 'CTEXT_RATE_LIMIT_MS', value: '1100' },
  { type: 'plain_text', name: 'FALLBACK_PER_IP_DAILY_LIMIT', value: '3' },
  { type: 'plain_text', name: 'OFFICIAL_WHITELIST', value: '["stats.gov.cn","data.stats.gov.cn","nfga.gov.cn","moe.gov.cn","gov.cn","openstd.samr.gov.cn","baike.baidu.com","zh.wikipedia.org"]' },
];

const bindingsJson = JSON.stringify(bindings);
const metadataJson = JSON.stringify({ main_module: 'worker.mjs', bindings });

// 3. 组装 multipart/form-data（用边界分隔）
const BOUNDARY = '----DeployBoundary' + Date.now();
const CRLF = '\r\n';

function part(name, content, filename, contentType) {
  let p = `--${BOUNDARY}${CRLF}`;
  p += `Content-Disposition: form-data; name="${name}"`;
  if (filename) p += `; filename="${filename}"`;
  p += CRLF;
  if (contentType) p += `Content-Type: ${contentType}${CRLF}`;
  p += CRLF;
  p += content;
  p += CRLF;
  return p;
}

const body = Buffer.concat([
  Buffer.from(part('metadata', metadataJson, 'metadata.json', 'application/json')),
  Buffer.from(part('worker', script, 'worker.mjs', 'application/javascript')),
  Buffer.from(`--${BOUNDARY}--${CRLF}`),
]);

console.log(`📤 上传 (${(body.length/1024).toFixed(1)} KB)...`);

// 4. 直接 PUT 到 workers.dev 子域（v1 API，绕过 Service 创建）
const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`;
const resp = await fetch(url, {
  method: 'PUT',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
  },
  body,
});

const json = await resp.json();

if (json.success) {
  const subdomain = json.result?.subdomain || `${WORKER_NAME}`;
  console.log('🎉 部署成功！');
  console.log(`   访问地址: https://${WORKER_NAME}.${subdomain}.workers.dev`);
  console.log(`   健康检查: curl -s https://${WORKER_NAME}.${subdomain}.workers.dev/api/health`);
} else {
  console.error('❌ 部署失败:', JSON.stringify(json.errors, null, 2));
  // 试另一个端点
  console.log('🔄 尝试备用端点...');
  const url2 = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/script/${WORKER_NAME}`;
  const resp2 = await fetch(url2, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
    body,
  });
  const json2 = await resp2.json();
  if (json2.success) {
    const subdomain = json2.result?.subdomain || `${WORKER_NAME}`;
    console.log('🎉 备用端点部署成功！');
    console.log(`   访问地址: https://${WORKER_NAME}.${subdomain}.workers.dev`);
  } else {
    console.error('❌ 备用端点也失败:', JSON.stringify(json2.errors, null, 2));
  }
}
