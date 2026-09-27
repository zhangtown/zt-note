// Command mkicon 生成「云栖笔记」应用图标（fnOS 风格：浅蓝渐变圆角底 + 磨砂玻璃文档 + 云）。
//
// 用符号距离场（SDF）逐像素渲染，支持线性渐变、半透明叠加与柔和投影，
// 不需要任何第三方依赖。3x 超采样后盒式降采样，边缘干净。
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

const ss = 3 // 超采样倍数

// ---- 基础工具 ----

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func lerp(a, b, t float64) float64 { return a + (b-a)*t }

// rgb 把 0xRRGGBB 转成 0..1 三元组。
func rgb(hex uint32) (float64, float64, float64) {
	return float64(hex>>16&0xff) / 255, float64(hex>>8&0xff) / 255, float64(hex&0xff) / 255
}

// ---- 形状（符号距离场，返回像素距离：负=内，正=外） ----

// 圆角盒：中心 (cx,cy)，半宽半高 (hx,hy)，圆角半径 r。
func sdRoundBox(x, y, cx, cy, hx, hy, r float64) float64 {
	qx := math.Abs(x-cx) - (hx - r)
	qy := math.Abs(y-cy) - (hy - r)
	ax := math.Max(qx, 0)
	ay := math.Max(qy, 0)
	return math.Hypot(ax, ay) + math.Min(math.Max(qx, qy), 0) - r
}

func sdCircle(x, y, cx, cy, r float64) float64 {
	return math.Hypot(x-cx, y-cy) - r
}

// 椭圆（近似距离，足够抗锯齿与柔影用）。
func sdEllipse(x, y, cx, cy, rx, ry float64) float64 {
	dx := (x - cx) / rx
	dy := (y - cy) / ry
	return (math.Hypot(dx, dy) - 1) * math.Min(rx, ry)
}

func sdUnion(a, b float64) float64 { return math.Min(a, b) }

// ---- 图层 ----

// shade 返回某像素的非预乘颜色与不透明度（0..1）。
type shadeFunc func(x, y float64) (r, g, b, a float64)

type layer struct {
	sdf     func(x, y float64) float64
	feather float64 // 边缘过渡宽度（像素）：1≈锐利抗锯齿，越大越柔（用于投影/辉光）
	shade   shadeFunc
}

// solid 返回固定颜色（a 为不透明度）的 shader。
func solid(hex uint32, a float64) shadeFunc {
	r, g, b := rgb(hex)
	return func(x, y float64) (float64, float64, float64, float64) { return r, g, b, a }
}

// vgrad 返回垂直线性渐变（y0→y1，c0→c1，a0→a1）的 shader。
func vgrad(y0, y1 float64, c0, c1 uint32, a0, a1 float64) shadeFunc {
	r0, g0, b0 := rgb(c0)
	r1, g1, b1 := rgb(c1)
	return func(x, y float64) (float64, float64, float64, float64) {
		t := clamp01((y - y0) / (y1 - y0))
		return lerp(r0, r1, t), lerp(g0, g1, t), lerp(b0, b1, t), lerp(a0, a1, t)
	}
}

// render 按图层从后到前合成 size×size 的图标。
func render(size int, layers []layer) *image.RGBA {
	S := size * ss
	pix := make([]float64, S*S*4) // 预乘 RGBA，0..1
	for py := 0; py < S; py++ {
		fy := float64(py) + 0.5
		for px := 0; px < S; px++ {
			fx := float64(px) + 0.5
			i := (py*S + px) * 4
			for _, L := range layers {
				d := L.sdf(fx, fy)
				cov := clamp01(0.5 - d/L.feather)
				if cov <= 0 {
					continue
				}
				r, g, b, a := L.shade(fx, fy)
				a *= cov
				if a <= 0 {
					continue
				}
				ia := 1 - a
				pix[i] = r*a + pix[i]*ia
				pix[i+1] = g*a + pix[i+1]*ia
				pix[i+2] = b*a + pix[i+2]*ia
				pix[i+3] = a + pix[i+3]*ia
			}
		}
	}

	// 盒式降采样（预乘域平均）+ 反预乘
	out := image.NewRGBA(image.Rect(0, 0, size, size))
	area := float64(ss * ss)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var sr, sg, sb, sa float64
			for dy := 0; dy < ss; dy++ {
				for dx := 0; dx < ss; dx++ {
					j := ((y*ss+dy)*S + (x*ss + dx)) * 4
					sr += pix[j]
					sg += pix[j+1]
					sb += pix[j+2]
					sa += pix[j+3]
				}
			}
			r, g, b, a := sr/area, sg/area, sb/area, sa/area
			var R, G, B uint8
			if a > 0 {
				R = uint8(clamp01(r/a)*255 + 0.5)
				G = uint8(clamp01(g/a)*255 + 0.5)
				B = uint8(clamp01(b/a)*255 + 0.5)
			}
			out.SetRGBA(x, y, color.RGBA{R, G, B, uint8(clamp01(a)*255 + 0.5)})
		}
	}
	return out
}

// scene 返回 N1 设计的全部图层（坐标为 0..1，渲染时乘 S）。
func scene(S float64) []layer {
	u := func(v float64) float64 { return v * S } // 归一化 → 像素

	// 底板（圆角方块）：0.0156..0.984，圆角 0.2266
	tile := sdRoundBox
	tileBox := func(x, y float64) float64 {
		return tile(x, y, u(0.5), u(0.5), u(0.484), u(0.484), u(0.2266))
	}
	// 文档：x 0.289..0.711，y 0.336..0.797，圆角 0.070
	docBox := func(dy float64) func(x, y float64) float64 {
		return func(x, y float64) float64 {
			return sdRoundBox(x, y, u(0.5), u(0.566+dy), u(0.211), u(0.2305), u(0.070))
		}
	}
	// 云：椭圆 + 三个圆的并集
	cloud := func(x, y float64) float64 {
		d := sdEllipse(x, y, u(0.461), u(0.3125), u(0.18), u(0.1016))
		d = sdUnion(d, sdCircle(x, y, u(0.352), u(0.281), u(0.078)))
		d = sdUnion(d, sdCircle(x, y, u(0.469), u(0.242), u(0.1016)))
		d = sdUnion(d, sdCircle(x, y, u(0.586), u(0.281), u(0.078)))
		return d
	}
	// 描边环（取底板距离的绝对值，得到一圈细边）
	ring := func(x, y float64) float64 {
		return math.Abs(tileBox(x, y)) - u(0.004)
	}

	// 文档内的三条文字线
	line := func(cx, cy, hw, a float64) layer {
		return layer{
			sdf:     func(x, y float64) float64 { return sdRoundBox(x, y, u(cx), u(cy), u(hw), u(0.0215), u(0.0215)) },
			feather: 1,
			shade:   solid(0xffffff, a),
		}
	}

	return []layer{
		// 1 底板：浅蓝渐变（白底上也能看清，又保持通透）
		{sdf: tileBox, feather: 1, shade: vgrad(u(0.0156), u(0.984), 0xeef5fd, 0xd3e4fb, 1, 1)},
		// 2 内辉光：柔和蓝光晕
		{sdf: func(x, y float64) float64 { return sdEllipse(x, y, u(0.5), u(0.461), u(0.4375), u(0.375)) },
			feather: u(0.16), shade: solid(0xcfe4ff, 0.55)},
		// 3 文档柔影（向下偏移、宽过渡）
		{sdf: docBox(0.023), feather: u(0.055), shade: solid(0x274a86, 0.30)},
		// 4 云（白→浅蓝，微透）
		{sdf: cloud, feather: 1, shade: vgrad(u(0.20), u(0.42), 0xffffff, 0xd8ecff, 0.98, 0.98)},
		// 5 文档本体：亮蓝渐变
		{sdf: docBox(0), feather: 1, shade: vgrad(u(0.336), u(0.797), 0x6aa6ff, 0x2f6fe0, 1, 1)},
		// 6 文档顶部高光
		{sdf: func(x, y float64) float64 { return sdRoundBox(x, y, u(0.5), u(0.4495), u(0.211), u(0.1135), u(0.070)) },
			feather: 1, shade: solid(0xffffff, 0.18)},
		// 7 文字线（磨砂白，深浅不一）
		line(0.5, 0.4985, 0.141, 0.92),
		line(0.4725, 0.5915, 0.1135, 0.70),
		line(0.4375, 0.6855, 0.0785, 0.50),
		// 8 左侧镜面高光
		{sdf: func(x, y float64) float64 { return sdRoundBox(x, y, u(0.3398), u(0.4375), u(0.0273), u(0.0785), u(0.0273)) },
			feather: 1, shade: solid(0xffffff, 0.35)},
		// 9 底板描边（极淡，白底上勾出轮廓）
		{sdf: ring, feather: 1, shade: solid(0x2b5fe0, 0.10)},
	}
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
			img = render(t.size, scene(float64(t.size*ss)))
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
