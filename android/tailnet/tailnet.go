// Package tailnet embebe un nodo Tailscale (tsnet, en espacio de usuario: sin
// VPN ni la app de Tailscale) dentro de la app Android y expone un reenvío local
// 127.0.0.1:<puerto> → servidor de la PC por la tailnet. El WebView carga esa
// dirección local. Se compila a .aar con gomobile (ver build.ps1).
package tailnet

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tailscale.com/net/netmon"
	"tailscale.com/paths"
	"tailscale.com/tsnet"
)

// CookieName es la cookie que exige el reenvío local: sin ella, otras apps del
// celular podrían usar 127.0.0.1:<puerto> para llegar a la terminal de la PC.
const CookieName = "cr_ts"

var (
	mu     sync.Mutex
	srv    *tsnet.Server
	ln     net.Listener
	target string // "host:puerto" del servidor en la tailnet
	secret string // valor esperado de la cookie

	ifaces atomic.Value // string con las interfaces que manda Java
	logs   = newRing(300)
)

// --- API expuesta a Java (gomobile) -----------------------------------------

// Init prepara el entorno y el diagnóstico. Llamar antes que todo lo demás:
// un cierre fatal de Go (panic) queda en dir/crash.txt y el registro en
// dir/tailnet.log, para mostrarlos en la app al volver a abrirla.
func Init(dir string) {
	os.MkdirAll(filepath.Join(dir, "tmp"), 0o700)
	// En Android no hay HOME ni un TMPDIR escribible: se usan carpetas de la app.
	os.Setenv("HOME", dir)
	os.Setenv("TMPDIR", filepath.Join(dir, "tmp"))
	paths.AppSharedDir.Store(dir)
	if f, err := os.OpenFile(filepath.Join(dir, "crash.txt"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
		debug.SetCrashOutput(f, debug.CrashOptions{})
		f.Close()
	}
	logs.setFile(filepath.Join(dir, "tailnet.log"))
}

// Start levanta el nodo (idempotente) y el reenvío local. dir guarda el estado
// (login) entre ejecuciones; authKey es opcional (si falta, login interactivo).
// Devuelve el puerto local efectivo (port si está libre; si no, uno al azar).
func Start(dir, hostname, authKey, targetAddr, cookieSecret string, port int) (_ int, err error) {
	mu.Lock()
	defer mu.Unlock()
	defer func() {
		if r := recover(); r != nil {
			logs.printf("panic en Start: %v\n%s", r, debug.Stack())
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	target, secret = targetAddr, cookieSecret
	if srv == nil {
		s := &tsnet.Server{
			Dir:      dir,
			Hostname: hostname,
			AuthKey:  authKey,
			Logf:     logs.printf,
			UserLogf: logs.printf,
		}
		if err := s.Start(); err != nil {
			logs.printf("Start: %v", err)
			return 0, err
		}
		srv = s
	}
	if ln == nil {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			l, err = net.Listen("tcp", "127.0.0.1:0")
		}
		if err != nil {
			return 0, err
		}
		ln = l
		go serve(l)
	}
	return ln.Addr().(*net.TCPAddr).Port, nil
}

// Status devuelve JSON {state, authURL, ip, name, error}. state es el de
// Tailscale: NoState, NeedsLogin, NeedsMachineAuth, Starting, Running, Stopped.
func Status() string {
	out := map[string]string{"state": "Stopped"}
	mu.Lock()
	s := srv
	mu.Unlock()
	if s != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		lc, err := s.LocalClient()
		if err == nil {
			st, err2 := lc.StatusWithoutPeers(ctx)
			err = err2
			if err == nil {
				out["state"] = st.BackendState
				out["authURL"] = st.AuthURL
				if len(st.TailscaleIPs) > 0 {
					out["ip"] = st.TailscaleIPs[0].String()
				}
				if st.Self != nil {
					out["name"] = strings.TrimSuffix(st.Self.DNSName, ".")
				}
			}
		}
		if err != nil {
			out["error"] = err.Error()
		}
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// Login pide un link de inicio de sesión nuevo (tras Logout o si caducó).
func Login() error {
	mu.Lock()
	s := srv
	mu.Unlock()
	if s == nil {
		return fmt.Errorf("tailscale no iniciado")
	}
	lc, err := s.LocalClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return lc.StartLoginInteractive(ctx)
}

// Logout cierra la sesión de Tailscale de este dispositivo.
func Logout() error {
	mu.Lock()
	s := srv
	mu.Unlock()
	if s == nil {
		return nil
	}
	lc, err := s.LocalClient()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return lc.Logout(ctx)
}

// SetInterfaces recibe las interfaces de red desde Java. Una por línea:
// "nombre índice mtu up broadcast loopback pointtopoint multicast | ip/prefijo ..."
func SetInterfaces(s string) { ifaces.Store(s) }

// NetworkChanged avisa un cambio de red (Wi-Fi ↔ datos) para reconectar ya,
// en vez de esperar al sondeo lento que tsnet usa en Android.
func NetworkChanged(defaultIface string) {
	setDefaultIface(defaultIface)
	mu.Lock()
	s := srv
	mu.Unlock()
	if s == nil || s.Sys() == nil {
		return
	}
	if nm, ok := s.Sys().NetMon.GetOK(); ok && nm != nil {
		nm.InjectEvent()
	}
}

// Logs devuelve las últimas líneas del registro (para diagnóstico en la app).
func Logs() string { return logs.String() }

// --- Reenvío local ----------------------------------------------------------

func serve(l net.Listener) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		go handle(c)
	}
}

func handle(c net.Conn) {
	defer c.Close()
	// Lee el encabezado de la primera petición para validar la cookie.
	c.SetReadDeadline(time.Now().Add(15 * time.Second))
	br := bufio.NewReaderSize(c, 16<<10)
	head, err := readHeader(br)
	if err != nil {
		return
	}
	c.SetReadDeadline(time.Time{})

	mu.Lock()
	s, t, sec := srv, target, secret
	mu.Unlock()
	if sec == "" || !hasCookie(head, sec) {
		io.WriteString(c, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	up, err := s.Dial(ctx, "tcp", t)
	cancel()
	if err != nil {
		logs.printf("dial %s: %v", t, err)
		msg := "No se pudo llegar al servidor por Tailscale: " + err.Error()
		fmt.Fprintf(c, "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s", len(msg), msg)
		return
	}
	defer up.Close()
	if _, err := up.Write(head); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, br); done <- struct{}{} }()
	go func() { io.Copy(c, up); done <- struct{}{} }()
	<-done // al cortarse un lado, se cierran ambos (defers)
}

// readHeader lee hasta la línea vacía que cierra el encabezado HTTP (máx. 32 KB).
func readHeader(br *bufio.Reader) ([]byte, error) {
	var buf bytes.Buffer
	for buf.Len() < 32<<10 {
		line, err := br.ReadSlice('\n')
		buf.Write(line)
		if err != nil {
			return nil, err
		}
		if len(bytes.TrimRight(line, "\r\n")) == 0 {
			return buf.Bytes(), nil
		}
	}
	return nil, fmt.Errorf("encabezado demasiado largo")
}

func hasCookie(head []byte, sec string) bool {
	want := CookieName + "=" + sec
	for _, line := range strings.Split(string(head), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), "cookie") {
			continue
		}
		for _, p := range strings.Split(v, ";") {
			if strings.TrimSpace(p) == want {
				return true
			}
		}
	}
	return false
}

// --- Interfaces provistas por Java ------------------------------------------

func getInterfaces() ([]netmon.Interface, error) {
	s, _ := ifaces.Load().(string)
	var out []netmon.Interface
	for _, line := range strings.Split(s, "\n") {
		meta, addrs, _ := strings.Cut(line, "|")
		f := strings.Fields(meta)
		if len(f) < 8 {
			continue
		}
		idx, _ := strconv.Atoi(f[1])
		mtu, _ := strconv.Atoi(f[2])
		var flags net.Flags
		for i, fl := range []net.Flags{net.FlagUp, net.FlagBroadcast, net.FlagLoopback, net.FlagPointToPoint, net.FlagMulticast} {
			if f[3+i] == "true" {
				flags |= fl
			}
		}
		ni := netmon.Interface{Interface: &net.Interface{Name: f[0], Index: idx, MTU: mtu, Flags: flags}}
		for _, a := range strings.Fields(addrs) {
			p, err := netip.ParsePrefix(a)
			if err != nil {
				continue
			}
			ni.AltAddrs = append(ni.AltAddrs, &net.IPNet{
				IP:   p.Addr().AsSlice(),
				Mask: net.CIDRMask(p.Bits(), p.Addr().BitLen()),
			})
		}
		out = append(out, ni)
	}
	return out, nil
}

// --- Registro en memoria ----------------------------------------------------

type ring struct {
	mu    sync.Mutex
	lines []string
	max   int
	file  *os.File // copia en disco: sobrevive a un cierre de la app
}

func (r *ring) setFile(path string) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	r.mu.Lock()
	if r.file != nil {
		r.file.Close()
	}
	r.file = f
	r.mu.Unlock()
}

func newRing(max int) *ring { return &ring{max: max} }

func (r *ring) printf(format string, args ...any) {
	line := time.Now().Format("15:04:05 ") + fmt.Sprintf(format, args...)
	r.mu.Lock()
	r.lines = append(r.lines, line)
	if r.file != nil {
		r.file.WriteString(line + "\n")
	}
	if len(r.lines) > r.max {
		r.lines = r.lines[len(r.lines)-r.max:]
	}
	r.mu.Unlock()
}

func (r *ring) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return strings.Join(r.lines, "\n")
}
