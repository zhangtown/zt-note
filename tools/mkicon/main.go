// Command mkicon 生成「云栖笔记」应用图标（深蓝圆角方块 + 笔记本页）。
//
// 4x 超采样后降采样，得到边缘干净的两套 PNG：64px 与 256px。
// 用法：go run ./tools/mkicon -out deploy/fnos-app/zt-note
package main

import (
	"flag"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
)

const ss = 4 // 超采样倍数

type rect struct{ x0, y0, x1, y1, r float64 }

func (r rect) inside(x, y float64) bool {
	if x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1 {
		return false
	}
	cx := math.Min(math.Max(x, r.x0+r.r), r.x1-r.r)
	cy := math.Min(math.Max(y, r.y0+r.r), r.y1-r.r)
	dx, dy := x-cx, y-cy
	return dx*dx+dy*dy <= r.r*r.r+1e-9
}

func (r rect) frac(n float64) rect {
	return rect{r.x0 * n, r.y0 * n, r.x1 * n, r.y1 * n, r.r * n}
}

func blend(dst *image.RGBA, x, y int, c color.RGBA, alpha float64) {
	if alpha <= 0 {
		return
	}
	if alpha > 1 {
		alpha = 1
	}
	old := dst.RGBAAt(x, y)
	a := float64(c.A) / 255 * alpha
	dst.SetRGBA(x, y, color.RGBA{
		R: uint8(float64(c.R)*a + float64(old.R)*(1-a)),
		G: uint8(float64(c.G)*a + float64(old.G)*(1-a)),
		B: uint8(float64(c.B)*a + float64(old.B)*(1-a)),
		A: uint8(math.Min(255, float64(old.A)+255*a)),
	})
}

func fill(dst *image.RGBA, r rect, col color.RGBA) {
	for y := int(math.Floor(r.y0)); y <= int(math.Ceil(r.y1)); y++ {
		if y < 0 || y >= dst.Bounds().Dy() {
			continue
		}
		for x := int(math.Floor(r.x0)); x <= int(math.Ceil(r.x1)); x++ {
			if x < 0 || x >= dst.Bounds().Dx() {
				continue
			}
			if r.inside(float64(x)+0.5, float64(y)+0.5) {
				blend(dst, x, y, col, 1)
			}
		}
	}
}

// render 画出 size×size 的图标（内部按 ss 倍分辨率绘制再降采样）。
func render(size int) *image.RGBA {
	n := size * ss
	big := image.NewRGBA(image.Rect(0, 0, n, n))
	fn := float64(n)

	// 背景：深蓝渐变圆角方块
	card := rect{0, 0, 1, 1, 0.22}.frac(fn)
	top := color.RGBA{0x33, 0x74, 0xBF, 0xff}    // 亮蓝
	bottom := color.RGBA{0x14, 0x2A, 0x4C, 0xff} // 深靛蓝
	for y := 0; y < n; y++ {
		t := float64(y) / fn
		row := color.RGBA{
			R: uint8(float64(top.R)*(1-t) + float64(bottom.R)*t),
			G: uint8(float64(top.G)*(1-t) + float64(bottom.G)*t),
			B: uint8(float64(top.B)*(1-t) + float64(bottom.B)*t),
			A: 0xff,
		}
		for x := 0; x < n; x++ {
			if card.inside(float64(x)+0.5, float64(y)+0.5) {
				big.SetRGBA(x, y, row)
			}
		}
	}

	// 装订脊
	fill(big, rect{0.150, 0.255, 0.232, 0.745, 0.041}.frac(fn), color.RGBA{0xff, 0xff, 0xff, 0x66})
	// 页面
	fill(big, rect{0.262, 0.195, 0.795, 0.805, 0.055}.frac(fn), color.RGBA{0xff, 0xff, 0xff, 0xf2})
	// 正文线条
	line := color.RGBA{0x2B, 0x5C, 0xA0, 0xff}
	fill(big, rect{0.352, 0.360, 0.700, 0.410, 0.025}.frac(fn), line)
	fill(big, rect{0.352, 0.480, 0.700, 0.530, 0.025}.frac(fn), line)
	fill(big, rect{0.352, 0.600, 0.572, 0.650, 0.025}.frac(fn), line)

	// 降采样
	out := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var sr, sg, sb, sa uint32
			for dy := 0; dy < ss; dy++ {
				for dx := 0; dx < ss; dx++ {
					c := big.RGBAAt(x*ss+dx, y*ss+dy)
					sr += uint32(c.R)
					sg += uint32(c.G)
					sb += uint32(c.B)
					sa += uint32(c.A)
				}
			}
			m := uint32(ss * ss)
			out.SetRGBA(x, y, color.RGBA{uint8(sr / m), uint8(sg / m), uint8(sb / m), uint8(sa / m)})
		}
	}
	return out
}

func writePNG(path string, img image.Image) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	return enc.Encode(f, img)
}

func main() {
	out := flag.String("out", "deploy/fnos-app/zt-note", "fpk 包目录")
	flag.Parse()

	targets := []struct {
		size int
		name string
	}{
		{64, "ICON.PNG"},
		{256, "ICON_256.PNG"},
		{64, "app/ui/images/icon_64.png"},
		{256, "app/ui/images/icon_256.png"},
	}
	cache := map[int]image.Image{}
	for _, t := range targets {
		img, ok := cache[t.size]
		if !ok {
			img = render(t.size)
			cache[t.size] = img
		}
		path := filepath.Join(*out, filepath.FromSlash(t.name))
		if err := writePNG(path, img); err != nil {
			panic(err)
		}
		info, _ := os.Stat(path)
		println("写入", path, info.Size(), "字节")
	}
}
