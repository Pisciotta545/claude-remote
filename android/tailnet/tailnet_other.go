//go:build !android

package tailnet

// Fuera de Android (pruebas en la PC) no hace falta informar la interfaz.
func setDefaultIface(string) {}
