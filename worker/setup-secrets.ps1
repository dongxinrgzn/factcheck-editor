# ============================================================
# 编辑校次助手 - 一键设置 Secret + 重新部署
# 使用方法：复制整个脚本，粘贴到 PowerShell 里执行
# 安全提示：密钥只在你本地终端输入，不会发给任何人
# ============================================================

$ErrorActionPreference = "Stop"

# 1. 加载 Cloudflare Token
$env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "User")
if (-not $env:CLOUDFLARE_API_TOKEN) {
    Write-Host "❌ 找不到 CLOUDFLARE_API_TOKEN 环境变量" -ForegroundColor Red
    Write-Host "   请先执行: [Environment]::SetEnvironmentVariable('CLOUDFLARE_API_TOKEN', '你的Token', 'User')" -ForegroundColor Yellow
    exit 1
}

$acctId = "671a2f0bf367dfe29abb0db9036e872b"
$svcName = "factcheck-editor-api"
$envName = "production"

# 2. 让用户逐个输入 4 个 Secret
Write-Host ""
Write-Host "========== 设置 4 个 Secret ==========" -ForegroundColor Cyan
Write-Host ""

# Secret 1: SILICONFLOW_KEY
Write-Host "【1/4】SILICONFLOW_KEY" -ForegroundColor Yellow
Write-Host "  去 https://cloud.siliconflow.cn/ 获取 API Key（sk- 开头）" -ForegroundColor Gray
$siliconKey = Read-Host "  粘贴 SiliconFlow Key"

# Secret 2: WORKER_KEY
Write-Host ""
Write-Host "【2/4】WORKER_KEY（管理员密码）" -ForegroundColor Yellow
$workerKey = Read-Host "  自定义一个管理员密码，比如 fc-admin-2026"

# Secret 3: BRAVE_API_KEY
Write-Host ""
Write-Host "【3/4】BRAVE_API_KEY" -ForegroundColor Yellow
Write-Host "  去 https://brave.com/search/api/ 注册获取（免费额度够编辑团队用）" -ForegroundColor Gray
$braveKey = Read-Host "  粘贴 Brave API Key"

# Secret 4: KB_CURATOR_PASSWORD
Write-Host ""
Write-Host "【4/4】KB_CURATOR_PASSWORD（知识库审核员密码）" -ForegroundColor Yellow
$kbPassword = Read-Host "  自定义一个知识库审核密码，比如 fc-curator-2026"

# 3. 用 Cloudflare API 批量设置 Secret
Write-Host ""
Write-Host "========== 正在写入 Cloudflare ==========" -ForegroundColor Cyan

function Set-WorkerSecret {
    param([string]$SecretName, [string]$SecretValue)
    
    $body = @{ name = $SecretName; text = $SecretValue } | ConvertTo-Json -Compress
    $bodyFile = "$env:TEMP\cf-secret-$SecretName.json"
    Set-Content -Path $bodyFile -Value $body -Encoding ASCII -Force
    
    $resp = curl.exe -s -w "`nHTTP:%{http_code}" -X PUT `
        "https://api.cloudflare.com/client/v4/accounts/$acctId/workers/services/$svcName/environments/$envName/secrets" `
        -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN" `
        -H "Content-Type: application/json" `
        --data-binary "@$bodyFile"
    
    $httpCode = ($resp -split "`n")[-1]
    $json = ($resp -split "`n")[0] | ConvertFrom-Json
    
    if ($json.success) {
        Write-Host "  ✅ $SecretName 已设置" -ForegroundColor Green
    } else {
        Write-Host "  ❌ $SecretName 失败: $($json.errors.message)" -ForegroundColor Red
    }
}

Set-WorkerSecret "SILICONFLOW_KEY" $siliconKey
Set-WorkerSecret "WORKER_KEY" $workerKey
Set-WorkerSecret "BRAVE_API_KEY" $braveKey
Set-WorkerSecret "KB_CURATOR_PASSWORD" $kbPassword

# 4. 重新部署让 Secret 生效
Write-Host ""
Write-Host "========== 重新部署 Worker ==========" -ForegroundColor Cyan
Set-Location "G:\TraeSpace\factcheck-editor\worker"
npx wrangler deploy

Write-Host ""
Write-Host "========== 完成 ==========" -ForegroundColor Green
Write-Host "Worker 地址（国内需绑域名）: https://$svcName.dx17865.workers.dev"
Write-Host ""
Write-Host "下一步："
Write-Host "  1. 买域名（阿里云）"
Write-Host "  2. Cloudflare 控制台 → Workers → Custom Domains → 绑定域名"
Write-Host "  3. 前端 index.html 推 GitHub Pages"
