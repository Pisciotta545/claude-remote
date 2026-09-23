package tailnet

import "tailscale.com/net/netmon"

func init() {
	// En Android 11+ Go no puede listar interfaces por netlink: las provee Java
	// (SetInterfaces) antes de Start.
	netmon.RegisterInterfaceGetter(getInterfaces)
}

func setDefaultIface(name string) { netmon.UpdateLastKnownDefaultRouteInterface(name) }
