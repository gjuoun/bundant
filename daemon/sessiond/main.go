//go:build linux

// sessiond is a tiny host-side liveness observer shipped as a static image.
// Agents send one hello line; it watches the pid with pidfd (cgroup v2 and
// kill polling as fallbacks) and appends signed ndjson events. Stdlib only,
// because the target host may have no internet and no Go toolchain.
package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultSocket = "/run/bundant/sessiond.sock"
	defaultLog    = "/var/lib/bundant/sessions.ndjson"
	defaultKey    = "/var/lib/bundant/sessiond.key"
	// SYS_PIDFD_OPEN is 434 on both linux/amd64 and linux/arm64.
	sysPidfdOpen = 434
	pollEvery = 500 * time.Millisecond
)

type hello struct {
	Session string `json:"session"`
	Agent   string `json:"agent"`
	PID     int    `json:"pid"`
}

type event struct {
	V       int    `json:"v"`
	Time    string `json:"time"`
	Event   string `json:"event"`
	Session string `json:"session"`
	Agent   string `json:"agent"`
	PID     int    `json:"pid"`
	Mode    string `json:"mode"`
	Host    string `json:"host"`
	Pub     string `json:"pub"`
	Sig     string `json:"sig"`
}

type signer struct {
	mu   sync.Mutex
	priv ed25519.PrivateKey
	file *os.File
}

func newSigner(path string) (*signer, error) {
	seed := make([]byte, ed25519.SeedSize)
	raw, err := os.ReadFile(path)
	if err == nil && len(raw) == ed25519.SeedSize {
		copy(seed, raw)
	} else {
		if _, err := io.ReadFull(rand.Reader, seed); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, seed, 0o600); err != nil {
			return nil, err
		}
	}
	logFile, err := os.OpenFile(defaultLog, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	return &signer{priv: ed25519.NewKeyFromSeed(seed), file: logFile}, nil
}

func (s *signer) emit(ev event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	ev.V = 1
	ev.Time = time.Now().UTC().Format(time.RFC3339Nano)
	ev.Host, _ = os.Hostname()
	ev.Pub = base64.StdEncoding.EncodeToString(s.priv.Public().(ed25519.PublicKey))
	// Sign exactly the fields that are written; Sig is added afterwards.
	unsigned, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	ev.Sig = base64.StdEncoding.EncodeToString(ed25519.Sign(s.priv, unsigned))
	line, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	_, err = s.file.Write(append(line, '\n'))
	return err
}

// peerPID overrides the claimed pid. Trusting the hello field would let any
// local client watch (and close) another process.
func peerPID(conn *net.UnixConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pid int
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, err := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if err != nil {
			credErr = err
			return
		}
		pid = int(cred.Pid)
	}); err != nil {
		return 0, err
	}
	return pid, credErr
}

func pidfdOpen(pid int) (int, error) {
	fd, _, errno := syscall.Syscall(sysPidfdOpen, uintptr(pid), 0, 0)
	if errno != 0 {
		return -1, errno
	}
	return int(fd), nil
}

// pidfdReady blocks up to one second and reports readability (= exit).
func pidfdReady(fd int) bool {
	var set syscall.FdSet
	set.Bits[fd/64] |= 1 << (uint(fd) % 64)
	tv := syscall.Timeval{Sec: 1}
	n, err := syscall.Select(fd+1, &set, nil, nil, &tv)
	return err == nil && n > 0
}

func cgroupPath(pid int) (string, bool) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return "", false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.HasPrefix(line, "0::") {
			continue
		}
		path := strings.TrimPrefix(line, "0::")
		if path == "" {
			return "", false
		}
		events := "/sys/fs/cgroup" + strings.TrimSuffix(path, "/") + "/cgroup.events"
		if _, err := os.Stat(events); err == nil {
			return events, true
		}
	}
	return "", false
}

func cgroupPopulated(path string) (bool, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "populated ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "populated ")) == "1", true
		}
	}
	return false, false
}

func alive(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return err == syscall.EPERM
	}
	// A zombie still answers kill(0); the agent is gone once it is reaped by
	// init, but the cgroup may linger. Report exit at Z so events stay prompt.
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	fields := strings.Fields(string(raw))
	return len(fields) < 3 || fields[2] != "Z"
}

// watch blocks until the process is gone and returns how it was detected.
func watch(pid int) string {
	if fd, err := pidfdOpen(pid); err == nil {
		defer syscall.Close(fd)
		for !pidfdReady(fd) {
			// select timed out: loop until the pidfd is readable.
		}
		return "pidfd"
	}
	if events, ok := cgroupPath(pid); ok {
		for {
			populated, readable := cgroupPopulated(events)
			if !readable || !populated {
				return "cgroupv2"
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	for alive(pid) {
		time.Sleep(pollEvery)
	}
	return "poll"
}

func handle(conn *net.UnixConn, sign *signer) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return
	}
	var msg hello
	if err := json.Unmarshal([]byte(line), &msg); err != nil || msg.Session == "" {
		return
	}
	pid, err := peerPID(conn)
	if err != nil || pid <= 0 {
		return
	}
	base := event{Session: msg.Session, Agent: msg.Agent, PID: pid}
	base.Event, base.Mode = "session.open", "pidfd"
	// Probe the mode before open so both lines report the same mechanism.
	if fd, err := pidfdOpen(pid); err != nil {
		if _, ok := cgroupPath(pid); ok {
			base.Mode = "cgroupv2"
		} else {
			base.Mode = "poll"
		}
	} else {
		syscall.Close(fd)
	}
	if err := sign.emit(base); err != nil {
		fmt.Fprintln(os.Stderr, "sessiond: emit open:", err)
		return
	}
	closed := base
	closed.Event, closed.Mode = "session.closed", watch(pid)
	if err := sign.emit(closed); err != nil {
		fmt.Fprintln(os.Stderr, "sessiond: emit closed:", err)
	}
}

func listen() (net.Listener, error) {
	if fds := os.Getenv("LISTEN_FDS"); fds != "" {
		if n, err := strconv.Atoi(fds); err == nil && n >= 1 {
			return net.FileListener(os.NewFile(3, "systemd-listen"))
		}
	}
	path := os.Getenv("BUNDANT_SESSIOND_SOCKET")
	if path == "" {
		path = defaultSocket
	}
	_ = os.MkdirAll(strings.TrimSuffix(path, "/sessiond.sock"), 0o755)
	_ = os.Remove(path)
	return net.Listen("unix", path)
}

func main() {
	if err := os.MkdirAll("/var/lib/bundant", 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "sessiond: log dir:", err)
		os.Exit(1)
	}
	keyPath := os.Getenv("BUNDANT_SESSIOND_KEY")
	if keyPath == "" {
		keyPath = defaultKey
	}
	sign, err := newSigner(keyPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "sessiond: init:", err)
		os.Exit(1)
	}
	defer sign.file.Close()

	ln, err := listen()
	if err != nil {
		fmt.Fprintln(os.Stderr, "sessiond: listen:", err)
		os.Exit(1)
	}
	defer ln.Close()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		_ = ln.Close()
	}()

	fmt.Fprintln(os.Stderr, "sessiond: listening on", ln.Addr().String())
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		unixConn, ok := conn.(*net.UnixConn)
		if !ok {
			conn.Close()
			continue
		}
		go handle(unixConn, sign)
	}
}
