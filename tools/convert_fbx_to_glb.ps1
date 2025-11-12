param(
    [Parameter(Mandatory=$true)]
    [string]$InputDir,
    
    [Parameter(Mandatory=$true)]
    [string]$OutputDir,
    
    [switch]$Recursive,
    [switch]$Overwrite
)

# 检查输入目录
if (-not (Test-Path $InputDir)) {
    Write-Error "输入目录不存在: $InputDir"
    exit 1
}

# 创建输出目录
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

# 检查 fbx2gltf 是否可用
$fbx2gltfCmd = "D:\Vtuber\FBX2glTF\FBX2glTF-windows-x64.exe"
if (-not (Test-Path $fbx2gltfCmd)) {
    Write-Error "找不到 fbx2gltf.exe 在路径: $fbx2gltfCmd"
    Write-Host "请确认文件存在或修改脚本中的路径。"
    exit 1
}

Write-Host "开始批量转换 FBX -> GLB"
Write-Host "输入目录: $InputDir"
Write-Host "输出目录: $OutputDir"
Write-Host "递归搜索: $Recursive"
Write-Host ""

# 查找 FBX 文件
$fbxFiles = Get-ChildItem -Path $InputDir -Filter "*.fbx" -Recurse:$Recursive

if ($fbxFiles.Count -eq 0) {
    Write-Warning "在 $InputDir 中未找到 FBX 文件"
    exit 0
}

Write-Host "找到 $($fbxFiles.Count) 个 FBX 文件"
Write-Host ""

$successCount = 0
$failCount = 0

foreach ($fbxFile in $fbxFiles) {
    $outputFileName = [System.IO.Path]::GetFileNameWithoutExtension($fbxFile.Name) + ".glb"
    $outputPath = Join-Path $OutputDir $outputFileName
    
    if ((Test-Path $outputPath) -and (-not $Overwrite)) {
        Write-Host "跳过（已存在）: $outputFileName"
        continue
    }
    
    Write-Host "转换: $($fbxFile.Name) -> $outputFileName"
    
    try {
        & $fbx2gltfCmd --input $fbxFile.FullName --output $outputPath --binary
        if ($LASTEXITCODE -eq 0) {
            $successCount++
            Write-Host "  成功" -ForegroundColor Green
        } else {
            $failCount++
            Write-Host "  失败 (退出码: $LASTEXITCODE)" -ForegroundColor Red
        }
    } catch {
        $failCount++
        Write-Host "  异常: $($_.Exception.Message)" -ForegroundColor Red
    }
    Write-Host ""
}

Write-Host "转换完成！"
Write-Host "成功: $successCount 个文件"
Write-Host "失败: $failCount 个文件"
Write-Host "输出目录: $OutputDir"