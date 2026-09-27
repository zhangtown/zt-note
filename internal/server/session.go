package server

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// PIN 与会话（「PIN 门」）。
//
// 输入 6 位数字 PIN，服务端校验后发一枚会话令牌（HttpOnly Cookie）。
// PIN 用 PBKDF2-SHA256 + 随机盐存哈希；连续输错按 5/10/15 次逐级锁定。
// 未解锁前所有笔记数据（含标题、搜索、图片）都不下发。
const (
	pinDigits   = 6
	pinIters    = 120_000
	pinSaltLen  = 16
	pinKeyLen   = 32
	pinAlgo     = "pbkdf2-sha256"
	cookieName  = "ztnote_session"
	sessionTTL  = 30 * 24 * time.Hour
	maxAttempts = 5 // 每输错这么多次，锁定时长上升一级
)

// 错误
var (
	ErrNoPIN  = errors.New("尚未设置 PIN")
	ErrHasPIN = errors.New("PIN 已设置")
	ErrBadPIN = errors.New("PIN 需要 6 位数字")
	ErrLocked = errors.New("尝试过于频繁，已暂时锁定")
	ErrBadOld = errors.New("原 PIN 不正确")
)

// pinRecord 是落盘的 PIN 记录。
type pinRecord struct {
	Version   int    `json:"version"`
	Algo      string `json:"algo"`
	Iters     int    `json:"iters"`
	Salt      string `json:"salt"`
	Hash      string `json:"hash"`
	UpdatedAt string `json:"updatedAt"`
}

// VerifyResult 是一次 PIN 校验的结果。
type VerifyResult struct {
	OK        bool
	Remaining int           // 还允许输错几次（无锁定时为 0）
	LockFor   time.Duration // 已锁定时还要等多久
}

type sessionInfo struct {
	uid      string
	expires  time.Time
	lastSeen time.Time
}

type failInfo struct {
	count int
	until time.Time
}

// SessionManager 管理 PIN 记录与会话令牌（内存态，重启即失效）。
type SessionManager struct {
	mu       sync.Mutex
	sessions map[string]*sessionInfo
	fails    map[string]*failInfo
	pinPath  func(uid string) string
	now      func() time.Time
}

// NewSessionManager 创建会话管理器；pinPath 返回某用户的 PIN 文件路径。
func NewSessionManager(pinPath func(uid string) string) *SessionManager {
	return &SessionManager{
		sessions: map[string]*sessionInfo{},
		fails:    map[string]*failInfo{},
		pinPath:  pinPath,
		now:      time.Now,
	}
}

// ---------------------------------------------------------------- PIN 记录

// NeedsSetup 判断该用户是否还没设过 PIN。
func (m *SessionManager) NeedsSetup(uid string) bool {
	_, err := m.readPIN(uid)
	return errors.Is(err, ErrNoPIN)
}

// SetPIN 首次设置 PIN（已设置过会返回 ErrHasPIN）。
func (m *SessionManager) SetPIN(uid, pin string) error {
	if !ValidPIN(pin) {
		return ErrBadPIN
	}
	if _, err := m.readPIN(uid); err == nil {
		return ErrHasPIN
	} else if !errors.Is(err, ErrNoPIN) {
		return err
	}
	rec, err := newPINRecord(pin)
	if err != nil {
		return err
	}
	return m.writePIN(uid, rec)
}

// ChangePIN 修改 PIN（需要原 PIN 正确）。
func (m *SessionManager) ChangePIN(uid, oldPin, newPin string) error {
	if !ValidPIN(newPin) {
		return ErrBadPIN
	}
	res, err := m.VerifyPIN(uid, oldPin)
	if err != nil {
		return err
	}
	if !res.OK {
		return ErrBadOld
	}
	rec, err := newPINRecord(newPin)
	if err != nil {
		return err
	}
	return m.writePIN(uid, rec)
}

// VerifyPIN 校验 PIN，并维护失败计数与锁定。
func (m *SessionManager) VerifyPIN(uid, pin string) (VerifyResult, error) {
	rec, err := m.readPIN(uid)
	if err != nil {
		return VerifyResult{}, err
	}
	m.mu.Lock()
	f := m.fails[uid]
	if f != nil && m.now().Before(f.until) {
		left := f.until.Sub(m.now())
		m.mu.Unlock()
		return VerifyResult{LockFor: left}, nil
	}
	m.mu.Unlock()

	if !verifyPINRecord(rec, pin) {
		m.mu.Lock()
		defer m.mu.Unlock()
		f := m.fails[uid]
		if f == nil {
			f = &failInfo{}
			m.fails[uid] = f
		}
		f.count++
		lock := lockDuration(f.count)
		if lock > 0 {
			f.until = m.now().Add(lock)
			f.count = 0 // 锁定期间不再累加，解锁后重新计
			return VerifyResult{LockFor: lock}, nil
		}
		return VerifyResult{Remaining: maxAttempts - f.count}, nil
	}

	m.mu.Lock()
	delete(m.fails, uid)
	m.mu.Unlock()
	return VerifyResult{OK: true}, nil
}

// LockedFor 返回该用户当前剩余的锁定时长（0 表示没锁）。
func (m *SessionManager) LockedFor(uid string) time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	f := m.fails[uid]
	if f == nil || m.now().After(f.until) {
		return 0
	}
	return f.until.Sub(m.now())
}

// lockDuration 按累计失败次数决定锁定时长。
func lockDuration(count int) time.Duration {
	switch {
	case count < maxAttempts:
		return 0
	case count < 2*maxAttempts:
		return time.Minute
	case count < 3*maxAttempts:
		return 5 * time.Minute
	default:
		return 15 * time.Minute
	}
}

// ValidPIN 校验 PIN 格式：正好 6 位数字。
func ValidPIN(pin string) bool {
	if len(pin) != pinDigits {
		return false
	}
	for _, r := range pin {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// WeakPIN 判断是否为一眼能猜到的 PIN（只用于给用户提示，不阻断）。
func WeakPIN(pin string) bool {
	if !ValidPIN(pin) {
		return false
	}
	same := true
	for i := 1; i < len(pin); i++ {
		if pin[i] != pin[0] {
			same = false
			break
		}
	}
	if same {
		return true
	}
	up, down := true, true
	for i := 1; i < len(pin); i++ {
		if pin[i] != pin[i-1]+1 {
			up = false
		}
		if pin[i] != pin[i-1]-1 {
			down = false
		}
	}
	return up || down
}

func newPINRecord(pin string) (*pinRecord, error) {
	salt := make([]byte, pinSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key, err := hashPIN(pin, salt, pinIters)
	if err != nil {
		return nil, err
	}
	return &pinRecord{
		Version:   1,
		Algo:      pinAlgo,
		Iters:     pinIters,
		Salt:      base64.StdEncoding.EncodeToString(salt),
		Hash:      base64.StdEncoding.EncodeToString(key),
		UpdatedAt: time.Now().Format(time.RFC3339),
	}, nil
}

func verifyPINRecord(rec *pinRecord, pin string) bool {
	if rec == nil || !ValidPIN(pin) || rec.Hash == "" {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(rec.Salt)
	if err != nil {
		return false
	}
	want, err := base64.StdEncoding.DecodeString(rec.Hash)
	if err != nil {
		return false
	}
	iters := rec.Iters
	if iters <= 0 {
		iters = pinIters
	}
	got, err := hashPIN(pin, salt, iters)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

func hashPIN(pin string, salt []byte, iters int) ([]byte, error) {
	return pbkdf2.Key(sha256.New, pin, salt, iters, pinKeyLen)
}

func (m *SessionManager) readPIN(uid string) (*pinRecord, error) {
	data, err := os.ReadFile(m.pinPath(uid))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNoPIN
		}
		return nil, err
	}
	rec := &pinRecord{}
	if err := json.Unmarshal(data, rec); err != nil {
		return nil, fmt.Errorf("PIN 文件损坏: %w", err)
	}
	if rec.Hash == "" {
		return nil, ErrNoPIN
	}
	return rec, nil
}

func (m *SessionManager) writePIN(uid string, rec *pinRecord) error {
	path := m.pinPath(uid)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ---------------------------------------------------------------- 会话

// Create 为用户开一个会话，返回令牌。
func (m *SessionManager) Create(uid string) string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return ""
	}
	token := hex.EncodeToString(buf)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	m.sessions[token] = &sessionInfo{uid: uid, expires: m.now().Add(sessionTTL), lastSeen: m.now()}
	return token
}

// Lookup 用令牌换 uid；令牌属于别的用户时返回 false。
func (m *SessionManager) Lookup(token, uid string) bool {
	if token == "" {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[token]
	if s == nil {
		return false
	}
	if m.now().After(s.expires) {
		delete(m.sessions, token)
		return false
	}
	if s.uid != uid {
		return false // 令牌与当前网关身份不一致：别人用同一浏览器也不行
	}
	s.lastSeen = m.now()
	s.expires = m.now().Add(sessionTTL) // 滑动续期
	return true
}

// Drop 注销令牌。
func (m *SessionManager) Drop(token string) {
	if token == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, token)
}

// DropUser 注销某用户的全部会话（改 PIN / 撤销其它设备时用），返回注销掉的数量。
func (m *SessionManager) DropUser(uid string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for t, s := range m.sessions {
		if s.uid == uid {
			delete(m.sessions, t)
			n++
		}
	}
	return n
}

// CountFor 返回该用户当前还有几枚有效会话（含发起查询的这枚）。
func (m *SessionManager) CountFor(uid string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	n := 0
	for _, s := range m.sessions {
		if s.uid == uid && now.Before(s.expires) {
			n++
		}
	}
	return n
}

// Expires 查令牌的到期时间（只读，不续期）；令牌无效或不属于该用户时 ok=false。
func (m *SessionManager) Expires(token, uid string) (time.Time, bool) {
	if token == "" {
		return time.Time{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[token]
	if s == nil || s.uid != uid || m.now().After(s.expires) {
		return time.Time{}, false
	}
	return s.expires, true
}

func (m *SessionManager) pruneLocked() {
	now := m.now()
	for t, s := range m.sessions {
		if now.After(s.expires) {
			delete(m.sessions, t)
		}
	}
	for uid, f := range m.fails {
		if now.After(f.until) && f.count == 0 {
			delete(m.fails, uid)
		}
	}
}

// ---------------------------------------------------------------- Cookie

// sessionCookie 生成会话 Cookie。
func sessionCookie(r *http.Request, path, token string, maxAge int) *http.Cookie {
	c := &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     path,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   maxAge,
	}
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		c.Secure = true
	}
	return c
}

// cookiePath 返回应用自身的 Cookie 作用路径。
func cookiePath(prefix string) string {
	if prefix == "" {
		return "/"
	}
	return prefix + "/"
}

func sessionToken(r *http.Request) string {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return ""
	}
	return c.Value
}
