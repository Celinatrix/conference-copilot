# Triển khai lên đám mây (Vercel + Railway)

App có hai phần chạy ở hai nơi:

```
Trình duyệt (PC / iPhone)
   │  https://<tên>.vercel.app        ← giao diện Next.js (Vercel)
   │     └─ /api/*  được Vercel chuyển tiếp ─┐
   └─ WebSocket wss:// trực tiếp ───────────┤
                                            ▼
                     Server API + WebSocket (Railway)  ──  PostgreSQL (Railway)
                                            │
                              Deepgram (giọng nói → chữ), Claude (dịch, gợi ý)
```

Vercel không giữ được kết nối WebSocket lâu dài nên server không đặt trên Vercel.

## 1. Railway: server + database

1. railway.com → đăng nhập bằng GitHub → **New Project → Deploy from GitHub repo** → chọn repo.
   File `railway.json` ở thư mục gốc đã khai báo lệnh cài, lệnh chạy và đường kiểm tra `/api/health`.
2. **+ Create → Database → PostgreSQL**.
3. Dịch vụ của app → **Variables**:

   | Biến | Giá trị |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `ANTHROPIC_API_KEY` | key Claude |
   | `DEEPGRAM_API_KEY` | key Deepgram |
   | `HOST` | `0.0.0.0` |
   | `COOKIE_SECURE` | `true` |
   | `TRUST_PROXY` | `2` (trình duyệt → Vercel → Railway) |
   | `ALLOWED_ORIGINS` | địa chỉ Vercel, ví dụ `https://conference-copilot-wb8z.vercel.app` (không có `/` ở cuối) |

   Các biến tuỳ chọn (model, giá, trần chi phí…) xem `.env.example`.
4. **Settings → Networking → Generate Domain**. Kiểm tra `https://<domain>/api/health` trả `{"ok":true}`.

Migration database chạy tự động mỗi lần server khởi động.

## 2. Vercel: giao diện web

1. vercel.com → **Add New → Project** → chọn repo → ở dòng **web (Next.js)** bấm **Import single project**
   (không dùng chế độ “Services”, không chọn dòng server).
2. Kiểm tra **Root Directory = `web`**, **Framework = Next.js**.
3. **Environment Variables**:

   | Biến | Giá trị |
   | --- | --- |
   | `API_ORIGIN` | `https://<domain Railway>` |
   | `NEXT_PUBLIC_WS_URL` | `wss://<domain Railway>` |

4. **Deploy**, rồi đặt `ALLOWED_ORIGINS` trên Railway bằng địa chỉ Vercel vừa có (bước 1.3).

## 3. Sau khi deploy

- **Đăng ký ngay tài khoản đầu tiên**: tài khoản đầu tiên là chủ (owner); sau đó chỉ vào được qua link mời.
- Tải lại tài liệu cho hội nghị (dữ liệu trên máy cá nhân không tự chuyển sang). Mỗi file nên **dưới 4,5 MB**
  (giới hạn kích thước request khi đi qua Vercel).
- Mỗi lần merge vào `main`, Vercel và Railway tự deploy lại.

## Khác biệt so với chạy trên máy cá nhân

| | Máy cá nhân (`npm run dev:*`) | Đám mây |
| --- | --- | --- |
| Database | PGlite trong `data/` | PostgreSQL trên Railway |
| Nút 🎧 (đọc khi khoá màn hình) | Có nếu Windows có giọng nữ tiếng Việt | Không (server Linux không có giọng Windows) |
| iPhone truy cập | Cùng mạng, cần `dev:*:lan` (+ `dev:https` để thu âm) | Mọi nơi qua `https://…vercel.app` |

## Chi phí tham khảo

Vercel Hobby: miễn phí. Railway: dùng thử 30 ngày / $5, sau đó khoảng $5/tháng. Chi phí AI theo mức dùng
(Deepgram, Claude), có trần trong biến `AI_CONFERENCE_CAP_USD`, `AI_WORKSPACE_DAILY_CAP_USD`.
