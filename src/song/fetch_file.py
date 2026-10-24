"""下载一个文件：断点续传、走系统代理（Windows 上 urllib 会读系统代理设置）、卡住就换下一个地址重试。

用法：python fetch_file.py <保存路径> <地址1> [地址2 ...]
成功退出码 0；每次进度打印一行 "progress <已下载> <总大小>"。
"""
import os
import socket
import sys
import time
import urllib.request

STALL = 30  # 秒：这么久没收到数据就算卡住
ROUNDS = 6  # 所有地址轮流试几轮


def total_size(opener, url):
    req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'aurabot'})
    with opener.open(req, timeout=STALL) as r:
        return int(r.headers.get('Content-Length') or 0)


def fetch(opener, url, part, want):
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if want and have >= want:
        return True
    headers = {'User-Agent': 'aurabot'}
    if have:
        headers['Range'] = 'bytes=%d-' % have
    req = urllib.request.Request(url, headers=headers)
    with opener.open(req, timeout=STALL) as r:
        # 服务器不支持续传就从头来
        mode = 'ab' if have and r.status == 206 else 'wb'
        if mode == 'wb':
            have = 0
        last_print = 0
        with open(part, mode) as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                have += len(chunk)
                if time.time() - last_print > 2:
                    print('progress', have, want, flush=True)
                    last_print = time.time()
    return not want or have >= want


def main():
    dest, urls = sys.argv[1], sys.argv[2:]
    socket.setdefaulttimeout(STALL)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()))
    part = dest + '.download'
    os.makedirs(os.path.dirname(dest) or '.', exist_ok=True)
    want = 0
    last_err = None
    for _ in range(ROUNDS):
        for url in urls:
            try:
                if not want:
                    want = total_size(opener, url)
                if fetch(opener, url, part, want):
                    if os.path.exists(dest):
                        os.remove(dest)
                    os.replace(part, dest)
                    print('done', os.path.getsize(dest), flush=True)
                    return 0
            except Exception as e:  # 断了、卡住、地址不行：换下一个地址，已下载的部分保留
                last_err = e
                print('retry', url.split('/')[2], type(e).__name__, str(e)[:120], flush=True)
    print('failed', last_err, flush=True)
    return 1


if __name__ == '__main__':
    sys.exit(main())
