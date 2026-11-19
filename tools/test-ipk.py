#!/usr/bin/env python3
"""
IPK 结构验证：防止打包回归。
历史 bug：build-ipk.py 的 add_bytes 未设 TarInfo.type，导致所有目录条目
被写成 0 字节普通文件，opkg 安装时报 "Is a directory" 并整体失败。
"""
import sys, os, io, tarfile, glob

def fail(msg):
    print(f'FAIL: {msg}')
    sys.exit(1)

def main():
    pkgs = sorted(glob.glob(os.path.join(os.path.dirname(__file__), '..', 'dist', '*.ipk')))
    if not pkgs:
        fail('dist/ 下没有 IPK')

    pkg = pkgs[-1]
    print(f'checking {os.path.basename(pkg)}')

    with tarfile.open(pkg, 'r:gz') as t:
        names = {m.name for m in t.getmembers()}
        for need in ('./debian-binary', './data.tar.gz', './control.tar.gz'):
            if need not in names:
                fail(f'缺少外层条目 {need}')
        dbin = t.extractfile('./debian-binary').read()
        if dbin != b'2.0\n':
            fail(f'debian-binary 内容应为 "2.0\\n"，实际 {dbin!r}')
        data = t.extractfile('./data.tar.gz').read()
        ctrl = t.extractfile('./control.tar.gz').read()
    print('ok    outer tarball (debian-binary 2.0 + data + control)')

    # data.tar.gz: 目录必须是 DIRTYPE，文件必须是 REGTYPE，不能有“0 字节普通文件”冒充目录
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as dd:
        mem = dd.getmembers()
        bad_type = [m for m in mem if not m.isdir() and not m.isfile()]
        fake_dirs = [m for m in mem if m.isfile() and m.name.endswith('/')]
        dirs = [m for m in mem if m.isdir()]
        files = [m for m in mem if m.isfile()]

        if bad_type:
            fail(f'非法条目类型: {[m.name for m in bad_type][:3]}')
        if fake_dirs:
            fail('目录被写成普通文件（会导致 opkg "Is a directory"）: '
                 + ', '.join(m.name for m in fake_dirs))
        if not dirs:
            fail('data.tar.gz 里没有任何目录条目')
        if not files:
            fail('data.tar.gz 里没有任何文件条目')

        # 每个文件的所有父目录都必须存在且为目录
        dirset = {m.name.rstrip('/') for m in dirs}
        for m in files:
            parent = os.path.dirname(m.name).lstrip('./')
            if parent and parent not in {d.lstrip('./') for d in dirset}:
                fail(f'{m.name} 的父目录缺失: {parent}')

        # 权限检查：可执行文件必须 755
        execs = [m for m in files if m.mode & 0o111]
        for m in execs:
            if m.mode & 0o777 != 0o755:
                fail(f'{m.name} 权限应为 755，实际 {oct(m.mode & 0o777)}')

    print(f'ok    data.tar.gz: {len(dirs)} DIRTYPE + {len(files)} REGTYPE, 无伪目录')
    print('ok    所有文件父目录存在，可执行文件权限 755')

    with tarfile.open(fileobj=io.BytesIO(ctrl), mode='r:gz') as ct:
        cnames = {m.name for m in ct.getmembers()}
        for need in ('./control', './postinst', './prerm'):
            if need not in cnames:
                fail(f'control.tar.gz 缺少 {need}')
        control = ct.extractfile('./control').read().decode()
        for field in ('Package:', 'Version:', 'Architecture:', 'Installed-Size:'):
            if field not in control:
                fail(f'control 缺少字段 {field}')
    print('ok    control.tar.gz (control + postinst + prerm, 关键字段齐全)')

    print('\nPASS: IPK 结构正确，可安全安装')

if __name__ == '__main__':
    main()
