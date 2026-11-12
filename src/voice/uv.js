// uv 的下载源（语音一键装 edge-tts 时用）。
// 原先在 song 模块的 studio.js，功能移除后搬到这里，保持下载源与校验值不变。
// uv 的下载源：PyPI 上的 uv 安装包（固定版本，里面带 uv.exe）走国内镜像，最后才试 GitHub。
const UV_WHEEL = 'packages/32/ea/771744a784b16aa21d195cb5d5d5a2878d72fa00fc26f11ea3f9646994fe/uv-0.13.5-py3-none-win_amd64.whl'
export const UV_SOURCES = [
  { url: `https://mirrors.aliyun.com/pypi/${UV_WHEEL}`, sha256: '1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f' },
  { url: `https://files.pythonhosted.org/${UV_WHEEL}`, sha256: '1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f' },
  { url: 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' },
]
