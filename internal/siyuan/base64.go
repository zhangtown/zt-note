package siyuan

import "encoding/base64"

func base64Decode(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}

func base64Encode(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }
