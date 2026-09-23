// claude-remote-ts pone el servidor de Claude Remote en tu tailnet sin la app de
// Tailscale en la PC: embebe un nodo Tailscale (tsnet, en espacio de usuario),
// escucha en la tailnet (:3000 por defecto) y reenvía cada conexión al servidor
// local (127.0.0.1:3000). Expone su estado en http://127.0.0.1:3099/status, que
// además hace de candado para que corra una sola instancia. server.js lo lanza y
// lo supervisa (con -watch-stdin: se cierra solo si el servidor muere).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

func main() {
	exeDir := "."
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}
	hostname := flag.String("hostname", envOr("TAILNET_HOSTNAME", "claude-remote-pc"), "nombre del equipo en la tailnet")
	dir := flag.String("dir", filepath.Join(exeDir, "tailscale-state"), "carpeta del estado (login) de Tailscale")
	target := flag.String("target", "127.0.0.1:3000", "servidor local al que se reenvía")
	port := flag.Int("port", 3000, "puerto en la tailnet")
	statusAddr := flag.String("status", "127.0.0.1:3099", "dirección local del estado (y candado de instancia única)")
	watchStdin := flag.Bool("watch-stdin", false, "cerrarse cuando se cierra stdin (lo usa server.js)")
	verbose := flag.Bool("v", false, "registro detallado de Tailscale")
	logFile := flag.String("logfile", "", "escribir el registro (detallado) en este archivo")
	flag.Parse()
	if *logFile != "" {
		if f, err := os.OpenFile(*logFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600); err == nil {
			log.SetOutput(f)
			*verbose = true
		}
	}

	// Una sola instancia: si el puerto de estado está tomado, ya hay otra corriendo.
	sl, err := net.Listen("tcp", *statusAddr)
	if err != nil {
		log.Printf("ya hay otra instancia en %s: %v", *statusAddr, err)
		os.Exit(3)
	}
	if *watchStdin {
		go func() {
			io.Copy(io.Discard, os.Stdin)
			log.Printf("stdin cerrado: el servidor terminó, salgo")
			os.Exit(0)
		}()
	}

	s := &tsnet.Server{
		Dir:      *dir,
		Hostname: *hostname,
		AuthKey:  os.Getenv("TS_AUTHKEY"),
		UserLogf: log.Printf,
		Logf:     func(string, ...any) {},
	}
	if *verbose {
		s.Logf = log.Printf
	}
	defer s.Close()
	if err := s.Start(); err != nil {
		log.Fatalf("no se pudo iniciar Tailscale: %v", err)
	}
	ln, err := s.Listen("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		log.Fatalf("no se pudo escuchar en la tailnet: %v", err)
	}
	go serveStatus(sl, s)
	log.Printf("Tailscale integrado: %s:%d (tailnet) → %s", *hostname, *port, *target)

	for {
		c, err := ln.Accept()
		if err != nil {
			log.Fatalf("accept: %v", err)
		}
		log.Printf("conexión desde %s", c.RemoteAddr())
		go forward(c, *target)
	}
}

// forward conecta una conexión de la tailnet con el servidor local.
func forward(c net.Conn, target string) {
	defer c.Close()
	up, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		log.Printf("no se pudo llegar a %s: %v", target, err)
		return
	}
	defer up.Close()
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, c); done <- struct{}{} }()
	go func() { io.Copy(c, up); done <- struct{}{} }()
	<-done
}

// serveStatus responde GET /status con {state, authURL, ip, name}. Con
// ?peers=1 agrega los equipos de la tailnet (online, relay, tráfico) para diagnóstico.
func serveStatus(l net.Listener, s *tsnet.Server) {
	http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		out := map[string]string{"state": "Starting"}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		if lc, err := s.LocalClient(); err == nil {
			if st, err := lc.StatusWithoutPeers(ctx); err == nil {
				out["state"] = st.BackendState
				out["authURL"] = st.AuthURL
				if len(st.TailscaleIPs) > 0 {
					out["ip"] = st.TailscaleIPs[0].String()
				}
				if st.Self != nil {
					out["name"] = strings.TrimSuffix(st.Self.DNSName, ".")
				}
			} else {
				out["error"] = err.Error()
			}
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("peers") == "" {
			json.NewEncoder(w).Encode(out)
			return
		}
		var peers []map[string]any
		if lc, err := s.LocalClient(); err == nil {
			if st, err := lc.Status(ctx); err == nil {
				for _, p := range st.Peer {
					peers = append(peers, map[string]any{
						"name": p.HostName, "ips": p.TailscaleIPs, "os": p.OS, "online": p.Online,
						"active": p.Active, "relay": p.Relay, "addr": p.CurAddr,
						"rx": p.RxBytes, "tx": p.TxBytes, "handshake": p.LastHandshake,
					})
				}
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"self": out, "peers": peers})
	}))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
