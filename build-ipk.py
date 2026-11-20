#!/usr/bin/env python3
"""
Build a genuine OpenWrt .ipk (gzipped tarball, as produced by
openwrt/scripts/ipkg-build) for luci-theme-falcon.
"""

import os
import io
import time
import shutil
import tarfile

BASE = os.path.abspath(os.path.dirname(__file__))
PKG = "luci-theme-falcon"
VERSION = "1.5.1"
RELEASE = "1"
ARCH = "all"
OUT_NAME = f"{PKG}_{VERSION}-{RELEASE}_{ARCH}.ipk"

# LuCI 给视图 JS 加的缓存键只跟 LuCI 自身版本走，换主题文件时 URL 不变，
# 浏览器会一直吃旧缓存。把版本号写进文件名即可强制换 URL。
REV = VERSION.replace(".", "_")


def versioned(path):
    """status/overview-falcon -> status/overview-falcon_1_4_9"""
    return f"{path}_{REV}"


# 构建时对文本文件做的替换（源文件保持干净，包内才是改过的）
TRANSFORM = {
    "root/usr/share/luci/menu.d/zz-luci-theme-falcon.json": [
        ("status/overview-falcon", versioned("status/overview-falcon")),
        ("status/topology-falcon", versioned("status/topology-falcon")),
    ],
    "ucode/template/themes/falcon/sysauth.ut": [
        ("'falcon.sysauth'", f"'falcon.sysauth_{REV}'"),
    ],
}

# source path -> install path inside the rootfs
FILES = [
	("ucode/template/themes/falcon/header.ut", "usr/share/ucode/luci/template/themes/falcon/header.ut", 0o644),
	("ucode/template/themes/falcon/footer.ut", "usr/share/ucode/luci/template/themes/falcon/footer.ut", 0o644),
	("ucode/template/themes/falcon/sysauth.ut", "usr/share/ucode/luci/template/themes/falcon/sysauth.ut", 0o644),
	("htdocs/luci-static/falcon/cascade.css", "www/luci-static/falcon/cascade.css", 0o644),
	("htdocs/luci-static/falcon/mobile.css", "www/luci-static/falcon/mobile.css", 0o644),
	("htdocs/luci-static/falcon/theme.css", "www/luci-static/falcon/theme.css", 0o644),
	("htdocs/luci-static/resources/view/status/overview-falcon.js", f"www/luci-static/resources/view/status/overview-falcon_{REV}.js", 0o644),
	("htdocs/luci-static/resources/view/status/topology-falcon.js", f"www/luci-static/resources/view/status/topology-falcon_{REV}.js", 0o644),
    ("htdocs/luci-static/resources/view/falcon/sysauth.js", f"www/luci-static/resources/view/falcon/sysauth_{REV}.js", 0o644),
    ("root/usr/libexec/falcon-wifi-temp", "usr/libexec/falcon-wifi-temp", 0o755),
    ("root/usr/share/rpcd/acl.d/luci-theme-falcon.json",
     "usr/share/rpcd/acl.d/luci-theme-falcon.json", 0o644),
	("root/usr/share/luci/menu.d/zz-luci-theme-falcon.json", "usr/share/luci/menu.d/zz-luci-theme-falcon.json", 0o644),
	("htdocs/luci-static/falcon/logo.svg", "www/luci-static/falcon/logo.svg", 0o644),
	("htdocs/luci-static/falcon/logo_48.png", "www/luci-static/falcon/logo_48.png", 0o644),
	("root/etc/uci-defaults/30_luci-theme-falcon", "etc/uci-defaults/30_luci-theme-falcon", 0o755),
]

CONTROL = f"""Package: {PKG}
Version: {VERSION}-{RELEASE}
Depends: libc, luci-base
Provides: luci-theme
Section: luci
Architecture: {ARCH}
Installed-Size: {{size}}
Maintainer: lecheng2018
Description: Modern card-based LuCI theme with fibre/PON hardware overview.
 A Bootstrap-compatible LuCI theme that re-skins every stock view (status,
 network, firewall, system, packages, login) with a light card layout and
 adds a physical fibre / PON link card to the status overview page.
"""

POSTINST = """#!/bin/sh
[ -n "$IPKG_INSTROOT" ] || {
	( . /etc/uci-defaults/30_luci-theme-falcon ) && rm -f /etc/uci-defaults/30_luci-theme-falcon
	rm -rf /tmp/luci-indexcache /tmp/luci-modulecache
	exit 0
}
"""

PRERM = """#!/bin/sh
[ -n "$IPKG_INSTROOT" ] || {
	uci -q delete luci.themes.Falcon
	[ "$(uci -q get luci.main.mediaurlbase)" = "/luci-static/falcon" ] && {
		uci -q set luci.main.mediaurlbase="/luci-static/bootstrap"
		uci -q commit luci
	}
	rm -rf /tmp/luci-indexcache /tmp/luci-modulecache
	exit 0
}
"""


def add_bytes(tar, name, data, mode, mtime, is_dir=False):
    ti = tarfile.TarInfo(name)
    ti.mtime = mtime
    ti.mode = mode
    ti.uid = 0
    ti.gid = 0
    ti.uname = "root"
    ti.gname = "root"

    if is_dir:
        # 目录条目必须是 DIRTYPE：opkg 才会 mkdir 而不是尝试 wfopen 一个目录
        ti.type = tarfile.DIRTYPE
        ti.size = 0
        tar.addfile(ti)
    else:
        ti.type = tarfile.REGTYPE
        ti.size = len(data)
        tar.addfile(ti, io.BytesIO(data))


def main():
    stage = os.path.join(BASE, "dist", ".stage")
    if os.path.exists(stage):
        shutil.rmtree(stage)
    os.makedirs(stage)
    mtime = int(time.time())

    # ---- data.tar.gz -----------------------------------------------------
    total = 0
    entries = []
    for src, dst, mode in FILES:
        full = os.path.join(BASE, src)
        if not os.path.exists(full):
            raise SystemExit(f"missing source file: {src}")
        with open(full, "rb") as fh:
            data = fh.read()
        for old_text, new_text in TRANSFORM.get(src, ()):
            data = data.replace(old_text.encode(), new_text.encode())
        total += len(data)
        entries.append((dst, data, mode))

    data_buf = io.BytesIO()
    with tarfile.open(fileobj=data_buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        for dst, data, mode in entries:
            # collect parent dirs so tar contains them too
            parts = dst.split("/")[:-1]
            acc = ""
            for p in parts:
                acc = f"{acc}{p}/"
                add_bytes(tar, "./" + acc, b"", 0o755, mtime, is_dir=True)
            add_bytes(tar, "./" + dst, data, mode, mtime)

    # ---- control.tar.gz --------------------------------------------------
    installed_size = max(1, total // 1024)
    ctrl = CONTROL.format(size=installed_size).encode()
    ctrl_buf = io.BytesIO()
    with tarfile.open(fileobj=ctrl_buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        add_bytes(tar, "./control", ctrl, 0o644, mtime)
        add_bytes(tar, "./postinst", POSTINST.encode(), 0o755, mtime)
        add_bytes(tar, "./prerm", PRERM.encode(), 0o755, mtime)

    # ---- outer gzipped tarball -------------------------------------------
    out = os.path.join(BASE, "dist", OUT_NAME)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with tarfile.open(out, mode="w:gz", format=tarfile.GNU_FORMAT) as tar:
        add_bytes(tar, "./debian-binary", b"2.0\n", 0o644, mtime)
        add_bytes(tar, "./data.tar.gz", data_buf.getvalue(), 0o644, mtime)
        add_bytes(tar, "./control.tar.gz", ctrl_buf.getvalue(), 0o644, mtime)

    shutil.rmtree(stage)
    print(f"built {out} ({os.path.getsize(out)} bytes, Installed-Size {installed_size} KB)")


if __name__ == "__main__":
    main()