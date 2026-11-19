#
# Copyright (C) 2026 OpenWrt Custom Theme
#
# This is free software, licensed under the Apache License, Version 2.0.
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=Falcon / Hardware Topology LuCI Theme
LUCI_DESCRIPTION:=Modern clean card-based LuCI theme featuring visual hardware topology, PON optical power gauge, and chip-level telemetry.
LUCI_DEPENDS:=+luci-base

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=OpenWrt Developer

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
