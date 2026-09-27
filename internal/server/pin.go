package server

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"ztnote/internal/users"
)

// PIN 门接口。
//
// 每个 NAS 账号第一次打开应用时设置一个 6 位 PIN，之后每次打开要输入；
// 校验通过才发会话 Cookie，未解锁时所有笔记数据接口返回 401。

type pinBody struct {
	PIN string `json:"pin"`
	Old string `json:"old"`
	New string `json:"new"`
}

// handlePinSetup 首次设置 PIN；设置成功即视为已解锁。
func (s *Server) handlePinSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "只支持 POST")
		return
	}
	id := identity(r)
	var body pinBody
	if !decode(w, r, &body) {
		return
	}
	if err := s.Sessions.SetPIN(id.UID, body.PIN); err != nil {
		switch {
		case errors.Is(err, ErrBadPIN):
			fail(w, http.StatusBadRequest, "PIN 需要 6 位数字")
		case errors.Is(err, ErrHasPIN):
			fail(w, http.StatusConflict, "PIN 已设置，请直接解锁")
		default:
			fail(w, http.StatusInternalServerError, "保存 PIN 失败: "+err.Error())
		}
		return
	}
	onboarded := s.grant(w, r, id)
	ok(w, map[string]any{
		"weak":      WeakPIN(body.PIN),
		"onboarded": onboarded,
		"user":      userJSON(id),
	})
}

// handlePinUnlock 校验 PIN 并开会话。
func (s *Server) handlePinUnlock(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "只支持 POST")
		return
	}
	id := identity(r)
	var body pinBody
	if !decode(w, r, &body) {
		return
	}
	res, err := s.Sessions.VerifyPIN(id.UID, body.PIN)
	if err != nil {
		if errors.Is(err, ErrNoPIN) {
			fail(w, http.StatusConflict, "这个帐号还没设置 PIN")
			return
		}
		fail(w, http.StatusInternalServerError, err.Error())
		return
	}
	if res.LockFor > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int(res.LockFor.Seconds())+1))
		fail(w, http.StatusTooManyRequests, "试错次数太多，请 "+lockMessage(res.LockFor)+"后再试")
		return
	}
	if !res.OK {
		fail(w, http.StatusUnauthorized, fmt.Sprintf("PIN 不对，还能试 %d 次", res.Remaining))
		return
	}
	onboarded := s.grant(w, r, id)
	ok(w, map[string]any{"onboarded": onboarded, "user": userJSON(id)})
}

// handlePinLock 锁定：丢掉当前会话。
func (s *Server) handlePinLock(w http.ResponseWriter, r *http.Request) {
	s.Sessions.Drop(sessionToken(r))
	http.SetCookie(w, sessionCookie(r, cookiePath(s.Prefix), "", -1))
	ok(w, map[string]any{"locked": true})
}

// handlePinChange 改 PIN（需要已解锁，并校验原 PIN）。
func (s *Server) handlePinChange(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "只支持 POST")
		return
	}
	id := identity(r)
	if !s.Sessions.Lookup(sessionToken(r), id.UID) {
		fail(w, http.StatusUnauthorized, "locked")
		return
	}
	var body pinBody
	if !decode(w, r, &body) {
		return
	}
	if err := s.Sessions.ChangePIN(id.UID, body.Old, body.New); err != nil {
		switch {
		case errors.Is(err, ErrBadPIN):
			fail(w, http.StatusBadRequest, "新 PIN 需要 6 位数字")
		case errors.Is(err, ErrBadOld), errors.Is(err, ErrNoPIN):
			fail(w, http.StatusUnauthorized, "原 PIN 不正确")
		default:
			fail(w, http.StatusInternalServerError, "保存 PIN 失败: "+err.Error())
		}
		return
	}
	// 其它设备上的会话作废，当前设备换一枚新会话继续用。
	s.Sessions.DropUser(id.UID)
	onboarded := s.grant(w, r, id)
	ok(w, map[string]any{"weak": WeakPIN(body.New), "onboarded": onboarded, "user": userJSON(id)})
}

// handlePinRevoke 撤销其它设备上的解锁（当前设备换一枚新会话继续用）。
//
// 用于「手机丢了 / 在别人电脑上忘了锁」这类场景：全部会话作废，只留发出请求的这个。
func (s *Server) handlePinRevoke(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fail(w, http.StatusMethodNotAllowed, "只支持 POST")
		return
	}
	id := identity(r)
	if !s.Sessions.Lookup(sessionToken(r), id.UID) {
		fail(w, http.StatusUnauthorized, "locked")
		return
	}
	dropped := s.Sessions.DropUser(id.UID)
	onboarded := s.grant(w, r, id)
	// dropped 里含发出请求的这枚令牌，所以「其它设备」= dropped-1
	revoked := dropped - 1
	if revoked < 0 {
		revoked = 0
	}
	ok(w, map[string]any{"revoked": revoked, "sessions": 1, "onboarded": onboarded, "user": userJSON(id)})
}

// grant 给当前身份发一枚会话 Cookie，并处理「第一次进入」的建库。
// 建库失败只记日志（前端随后调用数据接口时会看到具体错误）。
func (s *Server) grant(w http.ResponseWriter, r *http.Request, id users.Identity) bool {
	token := s.Sessions.Create(id.UID)
	if token == "" {
		s.Log.Printf("创建会话失败 (%s)", id.UID)
		return false
	}
	http.SetCookie(w, sessionCookie(r, cookiePath(s.Prefix), token, int(sessionTTL/time.Second)))
	st, err := s.openStore(id.UID)
	if err != nil {
		s.Log.Printf("打开工作区失败 (%s): %v", id.UID, err)
		return false
	}
	onboarded, err := s.ensureOnboarded(id.UID, st)
	if err != nil {
		s.Log.Printf("首次建库失败 (%s): %v", id.UID, err)
	}
	return onboarded
}

// lockMessage 把剩余锁定时长说成人话。
func lockMessage(d time.Duration) string {
	sec := int(d.Seconds())
	if sec < 60 {
		if sec < 1 {
			sec = 1
		}
		return fmt.Sprintf("%d 秒", sec)
	}
	return fmt.Sprintf("%d 分钟", (sec+59)/60)
}
