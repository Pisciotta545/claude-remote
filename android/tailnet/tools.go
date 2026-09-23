//go:build tools

// Mantiene golang.org/x/mobile/bind en go.mod: lo necesita "gomobile bind".
package tailnet

import _ "golang.org/x/mobile/bind"
