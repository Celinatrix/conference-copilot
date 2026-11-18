# Conference AI Copilot

Trợ lý phiên dịch và trả lời câu hỏi cho hội nghị, cuộc thi thuyết trình bằng tiếng Anh:

- **Nghe** người nói (giám khảo, diễn giả) và chuyển thành văn bản theo thời gian thực.
- **Dịch sang tiếng Việt** sau khoảng 1–2 giây, và **đọc bản dịch bằng một giọng nữ** qua tai nghe.
- **Phát hiện câu hỏi dành cho đội mình**, hiện popup có tiếng "ting" để bạn chọn **Trả lời** hoặc **Skip**.
- **Gợi ý câu trả lời chỉ dựa trên tài liệu bạn tải lên** (báo cáo, slide, kịch bản), có trích dẫn nguồn, không bịa
  thêm nội dung.
- **Lưu toàn bộ transcript**, xuất file PDF tiếng Việt, và cho cả nhóm cùng xem một phiên trên nhiều thiết bị.

> **Trạng thái:** đã chạy thật với Deepgram và Claude. Bản đám mây gồm giao diện trên Vercel, server + PostgreSQL trên
> Railway (xem [docs/DEPLOY.md](docs/DEPLOY.md)). Có 84 test tự động, chạy lại trên GitHub Actions.

---

## Mục lục

1. [Tính năng](#tính-năng)
2. [Cách hoạt động](#cách-hoạt-động)
3. [Cài đặt và chạy trên máy](#cài-đặt-và-chạy-trên-máy)
4. [Hướng dẫn sử dụng](#hướng-dẫn-sử-dụng)
5. [Câu hỏi và gợi ý trả lời](#câu-hỏi-và-gợi-ý-trả-lời)
6. [Nghe bản dịch trên iPhone](#nghe-bản-dịch-trên-iphone)
7. [Cấu hình (.env)](#cấu-hình-env)
8. [Chi phí và giới hạn](#chi-phí-và-giới-hạn)
9. [Bảo mật](#bảo-mật)
10. [Kiểm thử](#kiểm-thử)
11. [Cấu trúc mã nguồn](#cấu-trúc-mã-nguồn)
12. [API](#api)
13. [Cơ sở dữ liệu và migration](#cơ-sở-dữ-liệu-và-migration)
14. [Triển khai lên đám mây](#triển-khai-lên-đám-mây)
15. [Hạn chế đã biết](#hạn-chế-đã-biết)
16. [Xử lý sự cố](#xử-lý-sự-cố)

---

## Tính năng

| Tính năng | Trạng thái | Ghi chú |
| --- | --- | --- |
| Đăng nhập, workspace, mời thành viên bằng link | ✅ | Tài khoản đầu tiên là Owner; sau đó chỉ vào bằng link mời |
| Tạo / sửa / xóa hội nghị, tìm kiếm, lịch sử | ✅ | Riêng tư hoặc chia sẻ trong workspace |
| Thu âm micro, USB audio interface, âm thanh tab | ✅ | Ẩn micro ảo và micro trùng lặp trong danh sách |
| Nhận dạng giọng nói streaming (Deepgram nova-3) | ✅ Đã chạy thật | Có glossary để nghe đúng thuật ngữ |
| Dịch tiếng Việt streaming (Claude Haiku 5.5) | ✅ Đã chạy thật | Ghép câu trước khi dịch, dịch song song 3 câu |
| Đọc bản dịch bằng giọng nữ qua tai nghe | ✅ | Chỉ giọng nữ (HoaiMy trên PC, Linh trên iPhone); không có giọng nam |
| Tải tài liệu: PDF, DOCX, PPTX, XLSX, CSV | ✅ | Cột "Trợ lý trả lời" |
| Phát hiện câu hỏi dành cho đội mình | ✅ Đã chạy thật | Bỏ qua câu hỏi cho đội khác và các mảnh câu bị cắt dở |
| Popup "Câu hỏi mới từ BTC": **Trả lời** / **Skip**, có tiếng "ting" | ✅ Đã chạy thật | Không tốn tiền trước khi bạn bấm Trả lời |
| Đánh số câu hỏi "Câu 1, 2, 3" | ✅ | Câu mới nhất ở trên; số không đổi khi xóa câu khác |
| Hỏi lại khi câu hỏi nghe không rõ | ✅ | Bạn sửa lại câu hỏi rồi xác nhận |
| Gợi ý trả lời có trích dẫn tài liệu | ✅ Đã chạy thật | Haiku soạn nháp nhanh; "Soạn kỹ hơn" dùng Sonnet |
| Chọn model trả lời: Haiku / Sonnet / Opus | ✅ | Chọn riêng cho từng hội nghị |
| Popup "Đã có gợi ý trả lời" (tự ẩn sau 5 giây) | ✅ | |
| Nút X xóa câu hỏi, dòng transcript, ẩn cột | ✅ | |
| Transcript tự lưu, sửa, dịch lại, đánh dấu ★ | ✅ | |
| Xuất PDF tiếng Việt | ✅ | Đủ dấu (nhúng font Be Vietnam Pro); API còn hỗ trợ Markdown / TXT |
| Nhiều người cùng xem một phiên | ✅ | Chi phí AI không tăng theo số người xem |
| Dùng trên điện thoại cùng mạng (LAN + HTTPS) | ✅ | Xem [Nghe bản dịch trên iPhone](#nghe-bản-dịch-trên-iphone) |
| Theo dõi chi phí, trần chi phí cứng | ✅ | |
| Chặn im lặng (VAD), báo cáo tổng hợp sau hội nghị, xuất DOCX | ❌ Chưa làm | |

---

## Cách hoạt động

```
Thiết bị thu âm (trình duyệt)
  micro / USB interface / âm thanh tab
  └─ AudioWorklet → PCM16 16 kHz, khung 100 ms ── WebSocket ──┐
                                                             ▼
Server Fastify ── LiveRoom (một phòng cho mỗi hội nghị)
  ├─ Deepgram: chữ tạm thời + câu đã chốt
  ├─ Ghép câu → lưu database → Claude Haiku dịch tiếng Việt (có glossary)
  ├─ Claude Haiku phát hiện câu hỏi:
  │    câu hỏi cho đội khác / mảnh câu dở  → bỏ qua
  │    nghe không rõ                       → chờ bạn sửa và xác nhận
  │    câu hỏi rõ                          → popup "Trả lời / Skip"
  ├─ Bấm Trả lời → Claude soạn câu trả lời từ tài liệu (có trích dẫn)
  └─ Phát mọi sự kiện tới tất cả người đang xem
Giao diện Next.js ── /api/* được chuyển tiếp sang server
```

Nguyên tắc chính:

- **Một luồng âm thanh cho mỗi hội nghị.** Chỉ một thiết bị thu âm; server xử lý một lần rồi phát cho mọi người xem.
- **Chỉ lưu câu đã chốt.** Chữ đang nghe hiện in nghiêng, không lưu và không dịch, nên bản dịch không nhảy chữ.
- **Không bịa câu trả lời.** Câu trả lời chỉ dựa vào tài liệu đã tải lên. Nếu tài liệu không có thông tin, app ghi rõ
  phần còn thiếu thay vì tự nghĩ ra.
- **Chịu lỗi.** Mất mạng thì trình duyệt giữ tối đa 2 phút âm thanh rồi gửi bù. Deepgram kết nối lại thì server giữ
  30 giây âm thanh. Thiết bị thu âm có 90 giây để quay lại trước khi phiên tự tạm dừng.
- **Không lưu audio.** Chỉ lưu văn bản.

---

## Cài đặt và chạy trên máy

### Yêu cầu

- **Node.js 22 trở lên**, kèm npm.
- **Chrome hoặc Edge** trên máy tính; **Safari** trên iPhone. Trình duyệt chỉ cho thu âm trên `localhost` hoặc HTTPS.
- **API key** (tạo riêng, tính tiền theo lượng dùng):
  - [Deepgram](https://console.deepgram.com): nhận dạng giọng nói.
  - [Anthropic](https://console.anthropic.com): dịch, phát hiện câu hỏi, gợi ý trả lời.
    Gói Claude Pro trên claude.ai **không** đi kèm API key.
- Không cần cài PostgreSQL: khi chạy trên máy, server dùng **PGlite** (dữ liệu lưu ở `data/pglite`).

### Các bước

```bash
git clone https://github.com/Celinatrix/conference-copilot.git
cd conference-copilot
npm install
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

Mở `.env` và điền hai key. **Không gửi file này cho ai và không commit nó** (`.gitignore` đã chặn sẵn).

```ini
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=...
```

Chạy server và giao diện ở hai cửa sổ terminal:

```bash
npm run dev:server     # API + WebSocket: http://127.0.0.1:4000
npm run dev:web        # Giao diện:       http://localhost:3000
```

Mở http://localhost:3000 và bấm **Đăng ký**. Tài khoản đầu tiên là **Owner**; sau đó muốn thêm người thì vào
**Cài đặt → Thành viên & lời mời** để tạo link mời (mỗi link dùng một lần, chỉ hiện một lần).

Chưa có key vẫn mở được app; phần thu âm và dịch sẽ báo "chưa cấu hình key".

---

## Hướng dẫn sử dụng

### 1. Tạo hội nghị

Ở Dashboard bấm **Bắt đầu hội nghị mới**:

- **Ngôn ngữ đầu vào:** chọn **English** nếu cả buổi nói tiếng Anh (chính xác hơn chế độ tự nhận diện).
- **Glossary:** mỗi dòng một thuật ngữ, dạng `thuật ngữ` (giữ nguyên) hoặc `thuật ngữ = cách dịch`. Dòng bắt đầu bằng
  `#` là ghi chú. Nên thêm tên riêng hay bị nghe nhầm, ví dụ:

  ```text
  # Tên riêng
  Gen Re
  InsuNovate
  UEH
  # Thuật ngữ
  loss ratio = tỷ lệ tổn thất
  reinsurance = tái bảo hiểm
  ```

### 2. Tải tài liệu

Ở cột **Trợ lý trả lời**, tải lên báo cáo, slide, kịch bản (PDF, DOCX, PPTX, XLSX, CSV). Đây là nguồn duy nhất app dùng
để soạn câu trả lời. PDF scan (ảnh chụp, không chọn được chữ) chưa đọc được.

### 3. Chọn nguồn âm thanh

Tốt nhất là dây line-out từ bàn mixer qua USB audio interface; tiếp theo là micro USB hoặc micro cài áo đặt gần loa;
micro laptop hoặc điện thoại dễ bị vang hơn. Kiểm tra trước ở **Cài đặt → Kiểm tra micro**.

### 4. Trong phiên live

- **Start Listening:** chọn micro và xác nhận được phép ghi âm. Có **Pause / Resume / Stop**.
- **Bố cục:** cột bản gốc, cột tiếng Việt, cột Trợ lý trả lời. Bấm **X** để ẩn cột không cần. Trên điện thoại các cột
  chuyển thành tab.
- **Đọc tiếng Việt qua tai nghe:** bấm **🔈** để nghe bản dịch bằng giọng nữ. Nếu thiết bị không có giọng nữ tiếng
  Việt, app im lặng chứ không dùng giọng nam.
- **Chữ:** **A− / A+** chỉnh cỡ chữ, **Chế độ chữ lớn** chỉ hiện bản dịch, **⛶** toàn màn hình. Màn hình được giữ sáng.
- **Sửa transcript:** rê chuột vào một câu để sửa, **Dịch lại**, **★** đánh dấu, hoặc **X** xóa dòng.
- **Xuất PDF:** bấm **Export PDF** để tải transcript tiếng Việt.

---

## Câu hỏi và gợi ý trả lời

Luồng xử lý một câu hỏi của giám khảo:

1. **App nghe thấy câu hỏi.** Claude Haiku kiểm tra:
   - câu hỏi có dành cho **đội đang thuyết trình** không (câu hỏi cho đội khác bị bỏ qua);
   - có phải chỉ là **mảnh câu bị cắt dở** không (mảnh cũ tự bị xóa khi câu đầy đủ xuất hiện);
   - có **nghe rõ** không.
2. **Câu hỏi rõ:** popup **"🔔 Câu N · Câu hỏi mới từ BTC"** hiện giữa màn hình kèm tiếng "ting". Popup **không tự
   tắt**, bạn phải chọn:
   - **Trả lời:** app bắt đầu soạn gợi ý (Haiku mất khoảng 8 giây);
   - **Skip:** bỏ câu hỏi, không tốn tiền;
   - **Sửa lại câu hỏi:** sửa chữ nếu app nghe sai, rồi mới soạn.
3. **Câu hỏi nghe không rõ:** hiện thẻ **xác nhận** trong cột Trợ lý, kèm lý do. Bạn sửa lại rồi bấm xác nhận.
4. **Có gợi ý:** popup **"💡 Câu N · Đã có gợi ý trả lời"** hiện 5 giây. Mỗi gợi ý có bản tiếng Việt, bản tiếng Anh để
   nói, và trích dẫn trang/phần trong tài liệu.
5. **Muốn câu trả lời kỹ hơn:** bấm **✨ Soạn kỹ hơn (Sonnet)** trên thẻ câu hỏi.

Câu hỏi được đánh số **Câu 1, 2, 3…** theo thứ tự được hỏi; câu mới nhất ở trên cùng. Xóa một câu (nút **X**) không
làm đổi số các câu còn lại.

**Chọn model trả lời** cho từng hội nghị (ước tính mỗi câu):

| Model | Đặc điểm | Chi phí |
| --- | --- | --- |
| Haiku 5.5 (mặc định) | Nhanh, rẻ nhất | ~$0.002 |
| Sonnet 5.5 | Lập luận chặt hơn | ~$0.08 |
| Opus 5.5 | Tốt nhất, chậm hơn | ~$0.15 |

Muốn app tự soạn trả lời ngay mà không cần bấm, đặt `ANSWER_REQUIRE_CONFIRM=false` trong `.env`.

Bạn cũng có thể **tự gõ câu hỏi** ở cột Trợ lý để hỏi về tài liệu.

---

## Nghe bản dịch trên iPhone

**Hạn chế của iOS:** khi Safari đang dùng micro, mọi âm thanh của trang đều phát ra **loa ngoài**, không vào tai nghe.
Vì vậy cách nên dùng là:

> **Laptop (hoặc thiết bị khác) thu âm, iPhone chỉ để nghe và xem.**

### Cách 1: dùng bản đám mây (đơn giản nhất)

1. Laptop mở web Vercel, đăng nhập, mở hội nghị, bấm **Start Listening**.
2. iPhone mở **Safari** (không mở trong Zalo hay Messenger) tới cùng địa chỉ, đăng nhập cùng tài khoản hoặc tài khoản
   cùng workspace, mở cùng hội nghị.
3. Cắm tai nghe vào iPhone, bấm **🔈 Đọc tiếng Việt qua tai nghe**. Giữ màn hình sáng (giảm độ sáng xuống thấp nhất).

### Cách 2: chạy trên laptop, iPhone vào qua mạng LAN

1. Nối iPhone và laptop chung mạng (cùng Wi-Fi, hoặc iPhone bật **Điểm truy cập cá nhân** rồi cắm dây USB).
2. Trên laptop chạy:

   ```bash
   npm run dev:server:lan
   npm run dev:web:lan
   npm run dev:https        # chỉ cần khi iPhone phải tự thu âm hoặc cần HTTPS
   ```

3. Lấy IP của laptop bằng `ipconfig` (với dây USB thường là `172.20.10.x`).
4. iPhone mở Safari tới `http://<IP-laptop>:3000`, hoặc `https://<IP-laptop>:3443` khi chạy `dev:https`.
   - Lần đầu dùng HTTPS: mở `http://<IP-laptop>:3080` → **Tải chứng chỉ** → cài hồ sơ → **Cài đặt chung → Giới thiệu →
     Cài đặt tin cậy chứng nhận** → bật **Conference Copilot Local CA**.
   - Thư mục `certs/` chứa khóa riêng của chứng chỉ: **không gửi `certs/ca.key` cho ai**.

Chế độ LAN mở app cho mọi máy cùng mạng (vẫn phải đăng nhập). Dùng xong thì quay lại `npm run dev:server` /
`npm run dev:web`.

**Nghe khi khóa màn hình:** server có luồng MP3 đọc bản dịch (nút **🎧**). Nút này chỉ hiện khi máy Windows chạy server
có giọng đọc tiếng Việt **nữ**; Windows mặc định chỉ có giọng nam ("Microsoft An") nên nút thường bị ẩn.

---

## Cấu hình (.env)

File `.env` ở thư mục gốc do **server** đọc. Biến của giao diện (cuối bảng) đặt trong `web/.env.local` hoặc trong
Environment Variables của Vercel.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | trống | Key nhận dạng giọng nói |
| `DEEPGRAM_MODEL` | `nova-3` | Mô hình Deepgram |
| `DEEPGRAM_USD_PER_MIN` | `0.0092` | Đơn giá để **ước tính** chi phí |
| `ANTHROPIC_API_KEY` | trống | Key Claude |
| `TRANSLATION_MODEL` | `claude-haiku-5-5` | Mô hình dịch và phát hiện câu hỏi |
| `ANSWER_REQUIRE_CONFIRM` | `true` | Chờ bạn bấm Trả lời / Skip trước khi soạn. `false` = tự soạn ngay |
| `ANSWER_FAST_MODEL` | `claude-haiku-5-5` | Mô hình soạn nháp nhanh |
| `ANSWER_MODEL` | `claude-sonnet-5-5` | Mô hình cho nút "Soạn kỹ hơn" |
| `*_USD_PER_MTOK` | xem `.env.example` | Đơn giá ước tính cho từng mô hình |
| `ANSWER_AUTO_BUDGET_USD` | `1` | Chi cho trả lời vượt mức này trong một hội nghị thì chuyển sang chờ bấm |
| `AI_CONFERENCE_CAP_USD` | `10` | Trần chi phí AI cho một hội nghị (`0` = tắt) |
| `AI_WORKSPACE_DAILY_CAP_USD` | `25` | Trần chi phí AI cho workspace trong 24 giờ (`0` = tắt) |
| `AI_QUESTIONS_PER_MINUTE` / `AI_RETRANSLATE_PER_MINUTE` | `10` / `15` | Giới hạn mỗi người mỗi phút |
| `LOW_CONFIDENCE_THRESHOLD` | `0.75` | Dưới mức này câu bị gắn cờ "nghe chưa rõ" |
| `TTS_LANG` / `TTS_RATE` | `vi` / `1.1` | Ngôn ngữ và tốc độ của luồng MP3 đọc bản dịch |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | Địa chỉ server. Trên Railway đặt `HOST=0.0.0.0` |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | Địa chỉ web được phép gọi API (phân cách bằng dấu phẩy) |
| `COOKIE_SECURE` | `false` | `true` khi chạy HTTPS |
| `TRUST_PROXY` | `loopback` | Proxy được tin header `X-Forwarded-For`. Trên Railway đặt `2` |
| `ALLOW_SIGNUP` / `REGISTER_PER_HOUR` | `false` / `5` | Đăng ký công khai và giới hạn đăng ký mỗi IP |
| `DATABASE_URL` | trống | Trống = PGlite. Production: chuỗi kết nối PostgreSQL |
| `PGLITE_DIR` / `LOG_LEVEL` | `./data/pglite` / `info` | |
| `API_ORIGIN` *(web)* | `http://127.0.0.1:4000` | Nơi Next.js chuyển tiếp `/api/*` |
| `NEXT_PUBLIC_WS_URL` *(web)* | `ws(s)://<host>:4000` | Địa chỉ WebSocket trình duyệt kết nối |

Sửa `.env` xong thì khởi động lại server.

---

## Chi phí và giới hạn

- **Ước tính** khoảng **$1–2 mỗi giờ** hội nghị, gồm nhận dạng giọng nói, dịch và vài chục câu hỏi (trả lời bằng
  Haiku). Số chính xác xem trên trang billing của Deepgram và Anthropic.
- Ô **Chi phí ước tính** trong mỗi hội nghị tính theo đơn giá trong `.env`.
- Câu hỏi bị **Skip** hoặc bị bỏ qua (cho đội khác, mảnh câu dở) **không tốn tiền soạn trả lời**.
- **Trần cứng:** chạm trần thì app không mở phiên mới, không soạn trả lời và không dịch lại; phiên đang chạy vẫn dịch
  tiếp để không cắt ngang người nói.
- **Giới hạn khác:** 300 request/phút mỗi người; tài liệu tối đa 25 MB mỗi file (**4,5 MB** khi đi qua Vercel), 2 triệu
  ký tự sau khi trích xuất; mỗi hội nghị tối đa 10 triệu ký tự.

---

## Bảo mật

- Mật khẩu băm scrypt; token phiên lưu dạng hash; cookie `HttpOnly` + `SameSite=Lax`, hết hạn sau 30 ngày.
- Mọi route (trừ health, đăng nhập/đăng ký, tra cứu lời mời) cần đăng nhập; quyền kiểm tra trên **từng bản ghi**.
- Mọi đầu vào qua schema; SQL luôn tham số hóa; request thay đổi dữ liệu phải có `Origin` hợp lệ.
- WebSocket dùng vé một lần (60 giây), kiểm tra Origin, giới hạn 64 KB mỗi frame.
- Upload kiểm tra chữ ký file, chặn bom giải nén, phân tích trong worker riêng (512 MB RAM, 30 giây); file gốc không
  được ghi ra đĩa.
- API key chỉ nằm ở server. Có audit log cho đăng nhập, upload, xuất file, sửa transcript, mời thành viên.
- Audio không bao giờ được lưu. Nội dung transcript và tài liệu được xử lý như dữ liệu, không phải chỉ thị cho AI.

**Chưa xử lý:** WebSocket chưa đóng khi người dùng đăng xuất hay bị đổi quyền; chưa có CSP và HSTS; PGlite không mã hóa
trên đĩa. Audio được gửi tới Deepgram, còn transcript và đoạn tài liệu được gửi tới Anthropic: kiểm tra chính sách hai
bên trước khi dùng cho nội dung mật.

---

## Kiểm thử

```bash
npm run check                          # typecheck server + web, rồi chạy test
npm test                               # 84 test của server (AI được giả lập, không tốn tiền)
npm run bench:fanout -w server         # độ trễ phát tới 1/5/10/20 người xem
cd server && npx tsx scripts/security-probe.ts   # 38 bài tấn công thử, in PASS/FAIL
```

`npm run bench:live -w server -- talk.wav --ref talk.txt` chạy một file ghi âm qua Deepgram và Claude thật để đo độ trễ
và tỷ lệ lỗi từ. **Lệnh này tốn credit API.** File phải là WAV 16 kHz mono
(`ffmpeg -i talk.mp3 -ar 16000 -ac 1 -c:a pcm_s16le talk.wav`).

GitHub Actions chạy typecheck, test và build cho mỗi pull request và mỗi lần đẩy lên `main`; Dependabot tự đề xuất cập nhật thư viện.

---

## Cấu trúc mã nguồn

```
conference-copilot/
├─ .github/                    CI và Dependabot
├─ docs/DEPLOY.md              hướng dẫn triển khai Vercel + Railway
├─ scripts/https-proxy.mjs     HTTPS trong mạng LAN (cho iPhone)
├─ railway.json                cấu hình chạy server trên Railway
├─ server/                     API + WebSocket (Fastify, TypeScript)
│  ├─ migrations/              SQL migration, tự chạy khi server khởi động
│  ├─ scripts/                 benchmark và kiểm tra bảo mật
│  ├─ src/
│  │  ├─ app.ts, config.ts, db.ts, auth.ts, access.ts
│  │  ├─ export-pdf.ts         xuất transcript ra PDF tiếng Việt
│  │  ├─ live/                 Deepgram, ghép câu, dịch, đồng hồ phiên, phòng live
│  │  ├─ kb/                   đọc tài liệu, kiểm tra an toàn, tìm đoạn liên quan
│  │  ├─ ai/                   phát hiện câu hỏi, soạn trả lời có trích dẫn, trần chi phí
│  │  ├─ tts/                  luồng MP3 đọc bản dịch (giọng Windows)
│  │  └─ routes/               auth, conferences, documents, questions, listen, workspace
│  └─ test/                    vitest
└─ web/                        giao diện (Next.js 16, React 19, Tailwind 4)
   ├─ app/                     trang đăng nhập, dashboard, hội nghị, cài đặt
   ├─ components/live/         transcript, cột Trợ lý trả lời, luồng nghe
   └─ lib/                     gọi API, thu âm, WebSocket, giọng đọc, tiếng "ting"
```

---

## API

Tất cả dưới `/api`, dạng JSON, cần cookie phiên (trừ khi ghi chú khác).

| Method | Đường dẫn | Mô tả |
| --- | --- | --- |
| GET | `/api/health` | Kiểm tra sống (không cần đăng nhập) |
| GET | `/api/system/status` | Trạng thái key và mô hình |
| POST | `/api/auth/register` · `/login` · `/logout` | Đăng ký / đăng nhập / đăng xuất |
| GET | `/api/auth/me` | Người dùng hiện tại |
| GET | `/api/invites/:token` | Thông tin lời mời (không cần đăng nhập) |
| GET / POST / DELETE | `/api/workspace/members`, `/api/workspace/invites[/:id]` | Thành viên và lời mời |
| GET | `/api/dashboard` | Hội nghị gần đây, số liệu tổng |
| GET / POST | `/api/conferences` | Danh sách / tạo hội nghị |
| GET / PATCH / DELETE | `/api/conferences/:id` | Chi tiết / sửa (kể cả `answer_model`, `response_modes`) / xóa |
| GET | `/api/conferences/:id/segments` | Transcript (`?q=`, `?important=1`, `?since=`) |
| PATCH | `/api/segments/:id` | Sửa câu, đánh dấu quan trọng |
| POST | `/api/segments/:id/retranslate` | Dịch lại một câu |
| GET | `/api/conferences/:id/export` | `format=pdf\|md\|txt`, `view=vi\|original\|both` |
| GET | `/api/conferences/:id/usage` | Chi phí theo loại |
| GET / POST | `/api/conferences/:id/documents` | Danh sách / tải tài liệu (multipart, trường `file`) |
| DELETE | `/api/documents/:id` | Xóa tài liệu |
| GET / POST | `/api/conferences/:id/questions` | Danh sách câu hỏi / tự gõ câu hỏi |
| POST | `/api/questions/:id/answer` | Soạn trả lời: `{ text?, quality? }` (sửa câu hỏi, soạn kỹ hơn) |
| POST | `/api/questions/:id/dismiss` | Skip / xóa câu hỏi |
| GET | `/api/tts/status` · `/api/conferences/:id/listen.mp3` | Trạng thái và luồng MP3 đọc bản dịch |
| POST | `/api/conferences/:id/listen/test` | Đọc câu thử |
| POST | `/api/conferences/:id/ws-ticket` | Vé WebSocket một lần |

**WebSocket** `/ws?ticket=<vé>`: trình duyệt gửi audio PCM16 16 kHz (khung nhị phân) và lệnh `start`, `pause`,
`resume`, `stop`, `reclaim`, `ping`. Server gửi `state`, `partial`, `segment`, `translation.delta`,
`translation.done`, `question`, `answer.delta`, `error`, `pong`…

---

## Cơ sở dữ liệu và migration

| Migration | Nội dung |
| --- | --- |
| `001_init.sql` | users, phiên, workspaces, hội nghị, phiên nghe, segments, chi phí, audit log |
| `002_segments_updated_idx.sql` | Index cho đồng bộ bù khi kết nối lại |
| `003_knowledge_and_questions.sql` | Tài liệu, đoạn tài liệu (full-text), câu hỏi |
| `004_invitations.sql` | Lời mời thành viên |
| `005_question_confirmation.sql` | Trạng thái chờ xác nhận câu hỏi |
| `006_conference_answer_model.sql` | Model trả lời riêng cho từng hội nghị |
| `007_question_number.sql` | Số thứ tự "Câu N" (đánh số lại cả câu hỏi cũ theo thời gian) |

Migration tự chạy khi server khởi động (`npm run migrate -w server` để chạy riêng) và chỉ **thêm** bảng hoặc cột.
Sao lưu PGlite: dừng server rồi sao chép thư mục `data/pglite`.

---

## Triển khai lên đám mây

Xem chi tiết trong [docs/DEPLOY.md](docs/DEPLOY.md). Tóm tắt:

- **Railway:** server + PostgreSQL. Cần `DATABASE_URL`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `HOST=0.0.0.0`,
  `COOKIE_SECURE=true`, `TRUST_PROXY=2`, `ALLOWED_ORIGINS=<địa chỉ Vercel>`.
- **Vercel:** giao diện, Root Directory = `web`. Cần `API_ORIGIN=https://<domain Railway>` và
  `NEXT_PUBLIC_WS_URL=wss://<domain Railway>`.
- Merge vào `main` thì Vercel và Railway tự deploy. Nếu Railway không tự chạy: mở dịch vụ trên Railway → **Ctrl+K** →
  **Deploy latest commit**.

Live room nằm trong một tiến trình server; muốn chạy nhiều tiến trình cần thêm Redis pub/sub (chưa làm).

---

## Hạn chế đã biết

- **iOS:** khi Safari dùng micro, âm thanh ra loa ngoài thay vì tai nghe; khóa màn hình thì micro bị tắt.
- **Tên riêng dễ bị nghe nhầm** (ví dụ "Gen Re" thành "Genre"): thêm vào glossary của hội nghị.
- **Độ trễ** phụ thuộc khoảng ngừng của người nói, mạng và chất lượng âm thanh.
- **Nhãn người nói** có thể sai khi nhiều người nói cùng lúc.
- **Âm thanh tab** chỉ chạy trên Chrome/Edge máy tính.
- **Tài liệu:** PDF scan và ảnh chưa đọc được; file Word được trích dẫn theo "phần", không theo số trang.
- **Rate limit lưu trong RAM** nên reset khi khởi động lại server.

---

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
| --- | --- |
| "Chưa cấu hình DEEPGRAM_API_KEY / ANTHROPIC_API_KEY" | Điền key vào `.env` (hoặc Variables trên Railway) rồi khởi động lại server |
| "Trình duyệt bị từ chối quyền thu âm" | Bấm ổ khóa trên thanh địa chỉ → cho phép Microphone. Trang phải là `localhost` hoặc HTTPS |
| Link mở trong Zalo / Messenger không thu âm được | Mở bằng Safari hoặc Chrome |
| Không nghe tiếng đọc trên iPhone khi đang thu âm | Hạn chế của iOS: để thiết bị khác thu âm, iPhone chỉ nghe |
| Không có tiếng đọc nào | Thiết bị không có giọng nữ tiếng Việt. Trên Windows: Settings → Time & Language → Speech → thêm Vietnamese |
| Export PDF báo `expected one of "md"\|"txt"` | Server trên Railway chạy bản cũ: **Deploy latest commit** |
| Không có popup câu hỏi | Câu hỏi có thể dành cho đội khác, hoặc nghe không rõ (xem thẻ xác nhận ở cột Trợ lý) |
| Popup không kêu "ting" | Bấm vào trang ít nhất một lần (trình duyệt chặn âm thanh trước khi người dùng tương tác) và kiểm tra âm lượng |
| "Origin không được phép" (403) | Mở app đúng địa chỉ có trong `ALLOWED_ORIGINS` |
| "Đã dùng hết trần chi phí AI" | Tăng `AI_CONFERENCE_CAP_USD` / `AI_WORKSPACE_DAILY_CAP_USD` rồi khởi động lại server |
| Tải tài liệu lỗi trên bản đám mây | File phải dưới 4,5 MB (giới hạn của Vercel) |
| "Chỉ đăng ký được bằng link mời" | Đúng thiết kế: xin link từ Owner hoặc Admin |
