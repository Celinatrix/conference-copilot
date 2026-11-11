# Conference AI Copilot

Trợ lý phiên dịch hội nghị theo thời gian thực: nghe diễn giả nói bằng bất kỳ ngôn ngữ nào, chuyển thành văn bản,
dịch sang **tiếng Việt** sau khoảng 1–2 giây, lưu toàn bộ transcript, và cho cả nhóm 10–20 người cùng theo dõi một phiên.

> **Trạng thái:** bản phát triển (chưa triển khai production). Lõi dịch realtime, quản lý hội nghị, lời mời thành viên
> và các lớp bảo mật đã có, kèm 78 test tự động. Ứng dụng **chưa được chạy với API key thật** của Deepgram và Anthropic,
> nên độ trễ và độ chính xác thực tế chưa được đo. Xem [Trạng thái tính năng](#trạng-thái-tính-năng) để biết chính xác
> phần nào đã chạy, phần nào mới có backend.

---

## Mục lục

1. [Trạng thái tính năng](#trạng-thái-tính-năng)
2. [Cách hoạt động](#cách-hoạt-động)
3. [Yêu cầu hệ thống](#yêu-cầu-hệ-thống)
4. [Cài đặt và chạy lần đầu](#cài-đặt-và-chạy-lần-đầu)
5. [Hướng dẫn sử dụng](#hướng-dẫn-sử-dụng)
6. [Cấu hình (.env)](#cấu-hình-env)
7. [Chi phí và giới hạn](#chi-phí-và-giới-hạn)
8. [Bảo mật](#bảo-mật)
9. [Kiểm thử, benchmark và kiểm tra bảo mật](#kiểm-thử-benchmark-và-kiểm-tra-bảo-mật)
10. [Cấu trúc mã nguồn](#cấu-trúc-mã-nguồn)
11. [API](#api)
12. [Cơ sở dữ liệu và migration](#cơ-sở-dữ-liệu-và-migration)
13. [Triển khai production](#triển-khai-production)
14. [Hạn chế đã biết](#hạn-chế-đã-biết)
15. [Xử lý sự cố](#xử-lý-sự-cố)
16. [Lộ trình](#lộ-trình)

---

## Trạng thái tính năng

| Tính năng | Trạng thái | Ghi chú |
| --- | --- | --- |
| Đăng nhập, phiên cookie, đăng xuất | ✅ Hoạt động | Mật khẩu băm scrypt, token phiên lưu dạng hash |
| Workspace, mời thành viên bằng link (Owner / Admin / Thành viên) | ✅ Hoạt động | Đăng ký công khai tắt sau tài khoản đầu tiên |
| Tạo / sửa / xóa hội nghị, lịch sử, tìm kiếm | ✅ Hoạt động | Mỗi hội nghị có chế độ riêng tư hoặc chia sẻ workspace |
| Thu âm micro / USB audio interface / âm thanh tab | ✅ Có code, ⚠️ chưa thử với micro thật | AudioWorklet 16 kHz PCM16 |
| Nhận dạng giọng nói streaming (Deepgram) | ⚠️ Chưa chạy với API thật | Có test với bản giả lập |
| Dịch tiếng Việt streaming (Claude Haiku) | ⚠️ Chưa chạy với API thật | Có test với bản giả lập |
| Ghép câu trước khi dịch, dịch song song 3 câu | ✅ Hoạt động (test) | Tránh câu dịch bị cắt vụn |
| Transcript tự lưu, sửa, dịch lại, đánh dấu ★, tìm kiếm | ✅ Hoạt động | |
| Cờ cảnh báo đoạn đáng ngờ (nghe không rõ, số liệu lệch, thuật ngữ sai) | ✅ Hoạt động | Hiện ngay dưới câu dịch; glossary dạng `thuật ngữ = cách dịch` |
| Xuất Markdown / TXT | ✅ Hoạt động | PDF / DOCX chưa có |
| Nhiều người cùng xem một phiên | ✅ Hoạt động | Đo được dưới 8 ms để đẩy tới 20 người (phần server) |
| Tự kết nối lại khi rớt mạng, giữ 2 phút âm thanh | ✅ Có code, ⚠️ chưa thử rớt mạng thật | |
| Chế độ chữ lớn, toàn màn hình, giữ màn hình sáng | ✅ Hoạt động | |
| Knowledge Base: upload PDF, DOCX, PPTX, XLSX, CSV | ✅ Hoạt động | Cột Công cụ của trang live; tối đa 25 MB mỗi file |
| Phát hiện câu hỏi + gợi ý trả lời có trích dẫn tài liệu | ✅ Có giao diện, ⚠️ chưa chạy với API thật | Chọn 1–3 trong 5 kiểu trả lời ở Thông tin hội nghị; tiếng Việt + tiếng Anh |
| Theo dõi chi phí, trần chi phí cứng | ✅ Hoạt động | |
| Giọng đọc bản dịch, chặn im lặng (VAD), thanh điều khiển cho điện thoại | ❌ Chưa làm | Đã lên kế hoạch |
| Báo cáo tổng hợp sau hội nghị | ❌ Chưa làm | |

---

## Cách hoạt động

```
Thiết bị thu âm (trình duyệt)
  micro / USB interface / âm thanh tab
  └─ AudioWorklet → PCM16 16 kHz, khung 100 ms ── WebSocket nhị phân ──┐
                                                                     ▼
Server Fastify ── LiveRoom (một phòng cho mỗi hội nghị)
  ├─ Deepgram streaming: kết quả tạm thời + kết quả đã chốt, ngôn ngữ, người nói
  ├─ Bộ ghép câu: gom các mẩu đã chốt thành câu hoàn chỉnh
  ├─ Lưu câu vào database ngay lập tức
  ├─ Claude Haiku dịch tiếng Việt (tối đa 3 câu cùng lúc, có ngữ cảnh + glossary)
  ├─ Phát hiện câu hỏi → Claude Sonnet soạn câu trả lời từ tài liệu (có trích dẫn)
  └─ Phát mọi sự kiện tới WebSocket của từng người xem
Giao diện Next.js ── /api/* được proxy sang server (cookie phiên cùng nguồn)
```

Một vài nguyên tắc thiết kế:

- **Một luồng âm thanh cho mỗi hội nghị.** Chỉ thiết bị đang thu âm gửi audio lên; server xử lý một lần rồi phát cho
  mọi người xem. Chi phí AI tính theo giờ hội nghị, không tăng theo số người xem.
- **Tạm thời và đã chốt.** Chữ đang nghe hiện in nghiêng và không được lưu. Chỉ câu đã chốt mới được lưu và dịch, nên
  bản dịch không bị nhảy chữ liên tục.
- **Chịu lỗi.**
  - Mất mạng: trình duyệt giữ tối đa 2 phút âm thanh rồi gửi bù khi có mạng lại.
  - Deepgram kết nối lại: server giữ 30 giây âm thanh trong lúc chờ.
  - Thiết bị thu âm mất kết nối: có 90 giây để quay lại trước khi phiên tự tạm dừng.
  - Server khởi động lại: các phiên bị treo được đóng sạch.
- **Mốc thời gian theo đồng hồ phiên.** Không tính theo lượng audio đã gửi, nên khi tạm dừng hay ngắt quãng, giờ hiển
  thị vẫn khớp với thực tế.

---

## Yêu cầu hệ thống

- **Node.js 20 trở lên** (đã thử trên Node 26), kèm npm.
- **Trình duyệt Chrome hoặc Edge.** Trình duyệt chỉ cho thu âm khi trang chạy trên `localhost` hoặc HTTPS.
- **API key:**
  - [Deepgram](https://console.deepgram.com): nhận dạng giọng nói. Bắt buộc để thu âm.
  - [Anthropic](https://console.anthropic.com): dịch và gợi ý trả lời. Bắt buộc để dịch.
  > Gói **Claude Pro** trên claude.ai **không** đi kèm API key. API key tạo riêng ở console.anthropic.com và tính tiền riêng theo lượng dùng.
- Không cần cài Docker hay PostgreSQL khi chạy trên máy cá nhân: server dùng **PGlite** (PostgreSQL chạy nhúng, dữ
  liệu lưu ở `data/pglite`).
- **Tùy chọn:** `ffmpeg`, chỉ cần khi muốn chuyển file ghi âm để chạy benchmark chất lượng.

---

## Cài đặt và chạy lần đầu

### 1. Tải code và cài thư viện

```bash
git clone https://github.com/Celinatrix/conference-copilot.git
cd conference-copilot
npm install
```

### 2. Tạo file cấu hình

```bash
cp backend/.env.example backend/.env
```

Trên Windows PowerShell:

```powershell
Copy-Item backend\.env.example backend\.env
```

Mở `backend/.env` và điền hai dòng sau. Mọi API key chỉ nằm ở backend, frontend không bao giờ thấy key. Đừng gửi nội dung file này cho ai, và đừng commit nó (`.gitignore` đã chặn sẵn).

```ini
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=...
```

Chưa có key vẫn chạy được app: giao diện, đăng nhập, quản lý hội nghị đều dùng được. Phần thu âm và dịch sẽ báo
"chưa cấu hình key" thay vì lỗi khó hiểu.

### 3. Chạy backend và frontend (hai cửa sổ terminal)

```bash
npm run dev:backend
```

```bash
npm run dev:frontend
```

- **Backend (API và WebSocket):** `http://127.0.0.1:4000`. Lần chạy đầu tự tạo database và chạy migration.
- **Frontend (giao diện):** http://localhost:3001

Cả hai server chỉ lắng nghe trên `127.0.0.1`, nên máy khác trong cùng Wi-Fi không truy cập được.

### 4. Tạo tài khoản Owner

Mở http://localhost:3001 → **Đăng ký**. **Tài khoản đầu tiên** trở thành **Owner** của workspace. Sau đó đăng ký công
khai tự động đóng lại.

### 5. Mời thành viên

Vào **Cài đặt & Âm thanh → Thành viên & lời mời**:

1. Chọn vai trò: **Thành viên**, hoặc **Admin** (chỉ Owner mới mời được Admin).
2. Có thể giới hạn link chỉ cho một email, và chọn thời hạn 1–14 ngày.
3. Bấm **Tạo link mời** rồi gửi link cho người được mời.
   - Link **chỉ hiện một lần**. Nếu làm mất, hãy thu hồi và tạo link mới.
   - Mỗi link chỉ dùng được **một lần**.
   - Workspace tối đa 25 chỗ, tính cả lời mời đang chờ.

---

## Hướng dẫn sử dụng

### Tạo hội nghị

Ở Dashboard, bấm **Bắt đầu hội nghị mới** rồi điền:

- **Ngôn ngữ đầu vào:** để *Tự động nhận diện* khi có nhiều ngôn ngữ. Nếu cả buổi chỉ dùng một ngôn ngữ, chọn đúng
  ngôn ngữ đó để nhận dạng chính xác hơn.
- **Quyền riêng tư:**
  - *Riêng tư:* chỉ bạn thấy, kể cả Owner cũng không thấy.
  - *Chia sẻ với workspace:* mọi thành viên được xem; Owner và Admin được quản lý.
- **Glossary:** mỗi dòng một thuật ngữ, theo dạng `thuật ngữ` (giữ nguyên khi dịch) hoặc `thuật ngữ = cách dịch`.
  Dòng bắt đầu bằng `#` là ghi chú. Ví dụ:

  ```text
  # Actuarial
  IBNR
  loss ratio = tỷ lệ tổn thất
  chain ladder = phương pháp chain ladder
  ```

### Chọn nguồn âm thanh tại hội trường

Xếp theo chất lượng, từ tốt nhất:

1. **Dây line-out từ bàn mixer** của ban kỹ thuật, cắm vào USB audio interface, rồi vào laptop. Âm sạch nhất.
2. **Micro cài áo hoặc micro USB** đặt gần loa hoặc bục diễn giả.
3. **Micro laptop hoặc điện thoại** ở ghế ngồi. Dễ bị vang, độ chính xác thấp hơn.
4. **Âm thanh tab** (cho hội nghị online): chọn tab đang phát rồi bật "Chia sẻ âm thanh". Chỉ chạy trên Chrome/Edge;
   trên macOS chỉ chia sẻ được âm thanh của tab.

Kiểm tra micro trước buổi họp ở **Cài đặt → Kiểm tra micro**. Âm thanh chỉ được đo ngay trên máy, không gửi đi đâu.

### Trong phiên live

- **Start Listening:** chọn nguồn âm thanh và xác nhận bạn được phép ghi âm. App **không lưu audio thô**, chỉ lưu văn bản.
- **Pause / Resume / Stop Session.** Có thể bắt đầu nhiều phiên trong cùng một hội nghị (ví dụ hội nghị kéo dài nhiều ngày).
- **Bố cục:** cột trái là bản gốc, cột giữa là tiếng Việt. Trên điện thoại, các cột chuyển thành tab.
- **Chữ:** **A− / A+** chỉnh cỡ chữ (14–48 px). **Chế độ chữ lớn** chỉ hiện bản dịch. **⛶** bật toàn màn hình. Màn
  hình được giữ sáng khi đang thu âm hoặc đang xem phiên live.
- **Sửa nội dung:** rê chuột vào một câu để sửa chỗ nhận dạng sai, bấm **Dịch lại**, hoặc bấm **★** để đánh dấu quan trọng.
- **Tìm kiếm:** ô tìm kiếm tra theo cả bản gốc lẫn bản dịch.
- **Export:** Markdown hoặc văn bản, chọn xuất cả hai ngôn ngữ, chỉ tiếng Việt, hoặc chỉ bản gốc. **Copy Translation**
  sao chép toàn bộ bản dịch.
- **Nhiều thiết bị:** thiết bị khác của cùng người hoặc của thành viên khác chỉ cần mở hội nghị là xem được bản dịch
  trực tiếp. Mỗi lúc chỉ một thiết bị được thu âm.

---

## Cấu hình (.env)

Cấu hình chia làm hai file:

- `backend/.env`: do **backend** đọc, chứa mọi API key và cài đặt server (mẫu: `backend/.env.example`).
- `frontend/.env.local`: tùy chọn, chỉ chứa hai biến của **frontend** ở cuối bảng (mẫu: `frontend/.env.example`).
  Không đặt key vào đây: biến `NEXT_PUBLIC_*` bị gửi xuống trình duyệt.

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | trống | Key nhận dạng giọng nói |
| `DEEPGRAM_MODEL` | `nova-3` | Mô hình Deepgram. Chế độ tự nhận diện (`multi`) chỉ hỗ trợ một số ngôn ngữ |
| `DEEPGRAM_USD_PER_MIN` | `0.0092` | Đơn giá dùng để **ước tính** chi phí; sửa theo gói Deepgram thực tế |
| `ANTHROPIC_API_KEY` | trống | Key Claude cho dịch, phát hiện câu hỏi, gợi ý trả lời |
| `TRANSLATION_MODEL` | `claude-haiku-5-5` | Mô hình dịch (cũng dùng để phát hiện câu hỏi) |
| `TRANSLATION_INPUT_USD_PER_MTOK` / `_OUTPUT_` | `0.10` / `0.50` | Đơn giá ước tính cho mô hình dịch |
| `ANSWER_MODEL` | `claude-sonnet-5-5` | Mô hình soạn câu trả lời |
| `ANSWER_INPUT_USD_PER_MTOK` / `_OUTPUT_` / `_CACHE_READ_` / `_CACHE_WRITE_` | `2` / `10` / `0.2` / `2.5` | Đơn giá ước tính cho mô hình trả lời |
| `ANSWER_AUTO_BUDGET_USD` | `1` | Quá mức này trong một hội nghị thì ngừng tự gợi ý, chuyển sang bấm mới gợi ý |
| `AI_CONFERENCE_CAP_USD` | `10` | Trần cứng cho mọi chi phí AI của một hội nghị (`0` = tắt) |
| `AI_WORKSPACE_DAILY_CAP_USD` | `25` | Trần cứng cho chi phí AI của workspace trong 24 giờ (`0` = tắt) |
| `AI_QUESTIONS_PER_MINUTE` | `10` | Số yêu cầu gợi ý trả lời tối đa mỗi phút cho một người |
| `AI_RETRANSLATE_PER_MINUTE` | `15` | Số lần dịch lại tối đa mỗi phút cho một người |
| `LOW_CONFIDENCE_THRESHOLD` | `0.75` | Câu có độ tin cậy nhận dạng dưới mức này bị gắn cờ "nghe chưa rõ" |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | Địa chỉ server API |
| `ALLOWED_ORIGINS` | `http://localhost:3001,http://127.0.0.1:3001` | Origin trình duyệt được phép gọi API và mở WebSocket (phân cách bằng dấu phẩy) |
| `COOKIE_SECURE` | `false` | Đặt `true` khi chạy sau HTTPS |
| `TRUST_PROXY` | `loopback` | Proxy nào được tin header `X-Forwarded-For`. Không bao giờ đặt `true` |
| `ALLOW_SIGNUP` | `false` | Bật đăng ký công khai. Chỉ dùng trong mạng kín tin cậy |
| `REGISTER_PER_HOUR` | `5` | Số lần thử đăng ký tối đa mỗi giờ cho một IP |
| `DATABASE_URL` | trống | Để trống thì dùng PGlite. Production: `postgres://user:pass@host:5432/copilot` |
| `PGLITE_DIR` | `backend/data/pglite` | Thư mục dữ liệu PGlite |
| `LOG_LEVEL` | `info` | Mức log của server |
| `API_ORIGIN` *(frontend/.env.local)* | `http://127.0.0.1:4000` | Nơi Next.js chuyển tiếp `/api/*` |
| `NEXT_PUBLIC_WS_URL` *(frontend/.env.local)* | `ws(s)://<host hiện tại>:4000` | Địa chỉ WebSocket mà trình duyệt kết nối |

Sau khi sửa `backend/.env`, khởi động lại `npm run dev:backend`.

---

## Chi phí và giới hạn

- **Ước tính** khoảng **$1–2 mỗi giờ hội nghị** cho cả nhóm, gồm nhận dạng giọng nói, dịch và vài chục câu hỏi. Chi phí
  không tăng theo số người xem. Đây là ước tính từ bảng giá, **chưa đo với hóa đơn thật**.
- Mỗi hội nghị có ô **Chi phí ước tính** (cột Công cụ phiên). Số liệu tính từ đơn giá trong `.env`; số chính xác hãy xem
  trên trang billing của Deepgram và Anthropic.
- **Trần cứng:** khi hội nghị hoặc workspace chạm trần, app từ chối mở phiên nghe mới, phát hiện câu hỏi, gợi ý trả lời
  và dịch lại. **Phiên đang chạy vẫn dịch tiếp**, để không cắt ngang diễn giả.
- **Giới hạn khác:**
  - Toàn API: 300 request/phút mỗi người.
  - Tạo hội nghị: 20/phút. Upload tài liệu: 10/phút. Tạo lời mời: 20/giờ. Đăng ký: 5/giờ mỗi IP.
  - Tài liệu: tối đa 25 MB mỗi file, 2 triệu ký tự sau khi trích xuất; mỗi hội nghị tối đa 10 triệu ký tự.

---

## Bảo mật

Đã qua một đợt kiểm toán bảo mật, gồm 38 bài tấn công thử có thể chạy lại. Kết quả hiện tại: **0 lỗ hổng High,
2 Medium, 6 Low**.

**Đang có:**

- **Mật khẩu và phiên:** mật khẩu băm scrypt. Token phiên lưu dạng hash, cookie `HttpOnly` + `SameSite=Lax`, hết hạn
  sau 30 ngày. Đăng xuất là vô hiệu phiên ngay ở server.
- **Phân quyền:** mọi route (trừ health, đăng nhập/đăng ký, tra cứu lời mời) đều yêu cầu đăng nhập. Quyền được kiểm tra
  trên **từng bản ghi** ở backend (đã thử 16 kiểu truy cập chéo, đều bị chặn).
- **Đầu vào và CSRF:** mọi đầu vào (body, query, tin nhắn WebSocket) đều qua schema. Query SQL luôn tham số hóa. Không
  thể tự sửa các trường như `role`, `workspace_id`, `status`. Request thay đổi dữ liệu mà mang cookie phải có header
  `Origin` hợp lệ.
- **WebSocket:** dùng vé một lần, hết hạn sau 60 giây, có kiểm tra Origin và giới hạn 64 KB mỗi frame.
- **Upload:**
  - Chỉ nhận PDF, DOCX, PPTX, XLSX, CSV, và kiểm tra cả chữ ký file chứ không chỉ đuôi.
  - Chặn bom giải nén ngay từ danh mục ZIP. File được phân tích trong worker riêng, giới hạn 512 MB RAM và 30 giây.
  - File gốc không bao giờ được ghi ra đĩa hay thực thi.
- **Lời mời:** dùng một lần, có hạn, có thể giới hạn theo email; database chỉ lưu hash của token.
- **Chống dò email:** không lộ email nào đã đăng ký, cả qua thông báo lỗi lẫn qua thời gian phản hồi.
- **API key và nhật ký:** API key chỉ nằm ở server. Có audit log cho đăng nhập, upload, xuất file, sửa transcript và
  mời thành viên.
- **Quyền riêng tư:** audio không bao giờ được lưu. Xóa hội nghị là xóa toàn bộ transcript, tài liệu và câu hỏi của nó.
  Nội dung transcript và tài liệu được xử lý như dữ liệu, không phải chỉ thị cho AI (chống prompt injection).

**Chưa xử lý (đợt tiếp theo):**

- **WebSocket:** chưa đóng kết nối khi người dùng đăng xuất hoặc bị đổi quyền; chưa giới hạn số kết nối và tốc độ tin nhắn.
- **Header:** chưa có CSP và HSTS.
- **Mã hóa:** cookie `Secure` phải tự bật khi chạy HTTPS. Database PGlite **không mã hóa** trên đĩa; hãy bật BitLocker
  cho ổ đĩa nếu máy chứa dữ liệu nhạy cảm.
- **Chính sách lưu dữ liệu của bên thứ ba:** audio được gửi tới Deepgram; transcript, câu hỏi và đoạn tài liệu được gửi
  tới Anthropic. Hãy kiểm tra hợp đồng và chính sách của hai bên trước khi dùng cho hội nghị mật.

---

## Kiểm thử, benchmark và kiểm tra bảo mật

```bash
npm test
```

Chạy 71 test của server: unit test và test tích hợp REST/WebSocket trên PGlite chạy trong bộ nhớ, với AI được giả lập.

```bash
npm run typecheck
```

Kiểm tra kiểu cho cả backend và frontend, kể cả việc hai bên còn khớp hợp đồng chung trong `shared/`.

```bash
npm run lint      # Biome; CI yêu cầu 0 lỗi
npm run check     # lint + typecheck + test, chạy trước khi gửi thay đổi
npm run format    # tùy chọn: định dạng lại code theo biome.json
```

CI (`.github/workflows/ci.yml`) chạy lint, typecheck, test và build cho mỗi pull request và mỗi lần push lên `main`.

```bash
npm run bench:fanout -w backend
```

Đo độ trễ phân phối của server với 1/5/10/20 người xem, cùng thời gian tải và tìm kiếm cho một transcript 8 tiếng.
Không gọi API ngoài.

```bash
npm run bench:live -w backend -- talk.wav --ref talk.txt --glossary terms.txt --language multi
```

Phát một file ghi âm qua **Deepgram và Claude thật**, theo đúng tốc độ thật. Kết quả gồm độ trễ (p50/p95), tỷ lệ lỗi từ
(WER) và tỷ lệ nghe đúng thuật ngữ, kèm một bảng chấm điểm bản dịch lưu trong `backend/data/bench/`. **Lệnh này tốn credit API**,
xấp xỉ độ dài file ghi âm. File phải là WAV 16 kHz mono; chuyển đổi trước bằng:

```bash
ffmpeg -i talk.mp3 -ar 16000 -ac 1 -c:a pcm_s16le talk.wav
```

Kiểm tra bảo mật (chạy trong thư mục `backend/`):

```bash
npx tsx scripts/security-probe.ts
```

Chạy 38 bài tấn công thử trên một bản app dựng trong bộ nhớ, in PASS/FAIL kèm bằng chứng. Không gọi ra ngoài, không
đụng tới dữ liệu thật. Lưu ý bài thử bom giải nén cần còn trống khoảng 2 GB RAM.

---

## Cấu trúc mã nguồn

```
conference-copilot/
├─ shared/                      HỢP ĐỒNG CHUNG: kiểu dữ liệu và giao thức WebSocket mà backend và frontend cùng import
├─ backend/                     BACKEND: API + WebSocket (Fastify, TypeScript)
│  ├─ .env.example              mẫu cấu hình + API key (chép thành .env)
│  ├─ data/                     database PGlite (tự tạo, không commit)
│  ├─ migrations/               SQL migration, tự chạy khi server khởi động
│  ├─ scripts/                  bench-fanout, bench-live, security-probe
│  ├─ src/
│  │  ├─ app.ts                 dựng app: plugin, hook bảo mật, rate limit, route, WebSocket
│  │  ├─ config.ts              đọc backend/.env
│  │  ├─ db.ts                  PGlite / PostgreSQL + chạy migration
│  │  ├─ auth.ts, access.ts     mật khẩu, phiên, vé WebSocket, quy tắc phân quyền, audit
│  │  ├─ http.ts                tiện ích dùng chung cho route: kiểm tra UUID, định dạng thời gian, trả 404/403
│  │  ├─ live/                  phiên realtime
│  │  │  ├─ deepgram.ts         adapter Deepgram: kết nối lại, đệm, keep-alive
│  │  │  ├─ assembler.ts        ghép các mẩu nhận dạng thành câu
│  │  │  ├─ translator.ts       dịch streaming bằng Claude
│  │  │  ├─ timeline.ts         đổi thời gian audio sang đồng hồ phiên
│  │  │  └─ room.ts             điều phối phiên, lưu, phát sự kiện, hàng chờ dịch
│  │  ├─ kb/                    Knowledge Base: đọc tài liệu, kiểm tra an toàn, worker, tìm kiếm
│  │  ├─ ai/                    phát hiện câu hỏi, soạn trả lời có trích dẫn, cờ cảnh báo, trần chi phí
│  │  ├─ repos/                 SQL theo từng bảng: conferences, segments, workspace (route không viết SQL trực tiếp)
│  │  ├─ services/              nghiệp vụ dùng chung giữa route: sửa transcript, dịch lại
│  │  └─ routes/                REST: auth, conferences, documents, questions, workspace
│  └─ test/                     vitest
└─ frontend/                    FRONTEND: giao diện (Next.js, React, Tailwind)
   ├─ .env.example              mẫu cấu hình frontend (tùy chọn, chép thành .env.local)
   ├─ app/                      các trang: login, dashboard, hội nghị, live, cài đặt
   ├─ components/               UI dùng chung, thành viên & lời mời
   │  └─ live/                  trang live: LiveHeader, columns (3 cột), rows, parts và các hook
   │                            useTranscript, useLiveSession, useUsage
   ├─ lib/                      gọi API, thu âm, WebSocket client, giữ màn hình sáng
   └─ public/pcm-worklet.js     chuyển âm thanh sang 16 kHz PCM16 trên luồng audio
```

---

## API

Tất cả nằm dưới `/api/v1` (địa chỉ ổn định, có phiên bản) và `/api` (bí danh cho giao diện hiện tại), dữ liệu dạng JSON.
Mọi route (trừ ghi chú khác) đều cần cookie phiên. Request thay đổi dữ liệu cần header `Origin` hợp lệ. Kiểu dữ liệu
của request/response nằm trong `shared/src/index.ts`.

| Method | Đường dẫn | Mô tả |
| --- | --- | --- |
| GET | `/api/health` | Kiểm tra sống (không cần đăng nhập) |
| GET | `/api/system/status` | Trạng thái cấu hình key và mô hình |
| POST | `/api/auth/register` | Đăng ký: tài khoản đầu tiên, hoặc kèm `invite` (không cần đăng nhập) |
| POST | `/api/auth/login` · `/api/auth/logout` | Đăng nhập (không cần đăng nhập) / đăng xuất |
| GET | `/api/auth/me` | Người dùng hiện tại và workspace |
| GET | `/api/invites/:token` | Thông tin lời mời cho trang đăng ký (không cần đăng nhập, có rate limit) |
| GET | `/api/workspace/members` | Danh sách thành viên |
| GET / POST | `/api/workspace/invites` | Xem / tạo lời mời (Owner, Admin) |
| DELETE | `/api/workspace/invites/:id` | Thu hồi lời mời |
| GET | `/api/dashboard` | Hội nghị gần đây, phiên đang chạy, số liệu tổng |
| GET / POST | `/api/conferences` | Danh sách (`?q=`, phân trang `?limit=` tối đa 200 + `?offset=`, trả `nextOffset`) / tạo hội nghị |
| GET / PATCH / DELETE | `/api/conferences/:id` | Chi tiết / sửa (kể cả `response_modes`) / xóa vĩnh viễn |
| GET | `/api/conferences/:id/segments` | Transcript; lọc `?q=`, `?important=1`; đồng bộ bù `?since=`; phân trang theo `seq`: `?afterSeq=` + `?limit=` (mặc định 1000, tối đa 2000), lặp lại với `nextAfterSeq` đến khi là `null` |
| PATCH | `/api/segments/:id` | Sửa bản gốc / bản dịch, đánh dấu quan trọng |
| POST | `/api/segments/:id/retranslate` | Dịch lại một câu |
| GET | `/api/conferences/:id/export` | Tải về: `format=md\|txt`, `view=both\|original\|vi` |
| GET | `/api/conferences/:id/usage` | Chi phí theo từng loại |
| GET / POST | `/api/conferences/:id/documents` | Danh sách / upload tài liệu (multipart, trường `file`) |
| DELETE | `/api/documents/:id` | Xóa tài liệu |
| GET / POST | `/api/conferences/:id/questions` | Danh sách câu hỏi / hỏi thủ công (`segmentId` hoặc `text`) |
| POST | `/api/questions/:id/answer` | Soạn (lại) câu trả lời |
| POST | `/api/conferences/:id/ws-ticket` | Lấy vé WebSocket một lần |

**WebSocket:** `ws://127.0.0.1:4000/ws?ticket=<vé>`

- **Trình duyệt gửi lên:** khung nhị phân là audio PCM16 16 kHz. Tin JSON điều khiển gồm `start` (kèm `audioSource`,
  `consent: true`), `pause`, `resume`, `stop`, `reclaim`, `ping`.
- **Server gửi xuống:** `state`, `partial`, `partial.clear`, `segment`, `segment.updated`, `translation.delta`,
  `translation.done` (kèm `flags`), `translation.error`, `question`, `answer.delta`, `error`, `pong`.

---

## Cơ sở dữ liệu và migration

| Migration | Nội dung |
| --- | --- |
| `001_init.sql` | users, phiên, workspaces, thành viên, hội nghị, phiên nghe, segments, chi phí, audit log |
| `002_segments_updated_idx.sql` | Index phục vụ đồng bộ bù khi kết nối lại |
| `003_knowledge_and_questions.sql` | Tài liệu, đoạn tài liệu (full-text), câu hỏi; cột `flags`, `response_modes` |
| `004_invitations.sql` | Lời mời thành viên |
| `005_usage_workspace_time_idx.sql` | Index cho bước kiểm tra trần chi phí theo workspace trong 24 giờ |
| `006_restrict_user_delete.sql` | Không cho xóa người dùng còn sở hữu hội nghị, tài liệu hoặc phiên nghe (trước đây xóa lan cả transcript) |

Migration tự chạy khi server khởi động. Muốn chạy riêng:

```bash
npm run migrate -w backend
```

Mọi migration đều chỉ **thêm** bảng hoặc cột, không xóa hay sửa dữ liệu cũ.

**Sao lưu PGlite:** dừng server rồi sao chép cả thư mục `backend/data/pglite`.

---

## Triển khai production

> Phần này **chưa được thử nghiệm**. Đây là danh sách việc cần làm, không phải quy trình đã kiểm chứng.

1. Đặt server sau một reverse proxy **HTTPS** (Caddy, Nginx, Cloudflare Tunnel…) và chuyển tiếp cả WebSocket `/ws`.
2. Cấu hình `backend/.env`:
   - `COOKIE_SECURE=true`
   - `ALLOWED_ORIGINS=https://ten-mien-cua-ban`
   - `TRUST_PROXY=<địa chỉ proxy>`
   - `HOST` theo cấu hình mạng của máy chủ
3. Cấu hình `frontend/.env.local`:
   - `NEXT_PUBLIC_WS_URL=wss://ten-mien-cua-ban`
   - `API_ORIGIN=http://127.0.0.1:4000`
4. Database: dùng **PostgreSQL 16+** qua `DATABASE_URL`, với một role chỉ có quyền trên database của app, kết nối TLS,
   và bật backup mã hóa.
5. Build và chạy:
   - `npm ci` rồi `npm run build`: backend được biên dịch ra `backend/dist/` (chạy bằng `node`, không cần `tsx`), frontend ra `.next/`.
   - Database: `npm run migrate:prod -w backend` (hoặc để backend tự chạy migration khi khởi động).
   - Chạy: `npm run start:backend` và `npm run start:frontend`.
6. Trước khi mở cho người ngoài: làm xong các mục bảo mật còn tồn đọng (WebSocket, CSP, HSTS) và chạy lại
   `security-probe.ts`.

Live room nằm trong một tiến trình server. Nếu chạy nhiều tiến trình, cần thêm Redis pub/sub (chưa làm).

---

## Hạn chế đã biết

- **Ngôn ngữ phụ thuộc mô hình Deepgram.** Chế độ tự nhận diện (`multi`) của `nova-3` chỉ hỗ trợ một nhóm ngôn ngữ. Với
  ngôn ngữ khác, chọn ngôn ngữ cụ thể khi tạo hội nghị, hoặc đổi `DEEPGRAM_MODEL`. Hãy kiểm tra bảng ngôn ngữ của Deepgram
  trước buổi quan trọng.
- **Độ trễ không được bảo đảm.** Chỉ câu đã chốt mới được dịch, nên độ trễ bằng khoảng ngừng của người nói cộng thời gian
  Claude dịch. Nó còn phụ thuộc mạng và chất lượng âm thanh, và chưa được đo với API thật.
- **Nhãn người nói** ("Speaker 1/2…") có thể sai khi nhiều người nói cùng lúc.
- **Âm thanh tab** chỉ chạy trên Chrome/Edge. Safari, Firefox và điện thoại không hỗ trợ.
- **Rate limit lưu trong RAM** nên reset mỗi lần khởi động lại server.
- **Tài liệu:** PDF scan (không có chữ chọn được) và ảnh chưa đọc được. File Word được trích dẫn theo "phần", không theo số trang.
- **Tạm thời chỉ chạy được trên máy tính:** muốn dùng trên điện thoại phải triển khai HTTPS, vì trình duyệt chỉ cho thu
  âm trên `localhost` hoặc HTTPS.

---

## Xử lý sự cố

| Hiện tượng | Cách xử lý |
| --- | --- |
| "Chưa cấu hình DEEPGRAM_API_KEY / ANTHROPIC_API_KEY" | Điền key vào `backend/.env` rồi khởi động lại `npm run dev:backend` |
| "Trình duyệt bị từ chối quyền thu âm" | Bấm biểu tượng ổ khóa trên thanh địa chỉ → cho phép Microphone. Phải mở qua `localhost` hoặc HTTPS |
| "Thiết bị thu âm đang bị ứng dụng khác chiếm dụng" | Tắt Zoom, Teams hoặc app ghi âm khác |
| "Không kết nối được Deepgram … HTTP 400" | Tổ hợp mô hình và ngôn ngữ không được hỗ trợ: chọn ngôn ngữ cụ thể hoặc đổi `DEEPGRAM_MODEL` |
| "Chỉ đăng ký được bằng link mời" | Đúng thiết kế. Xin link từ Owner hoặc Admin, hoặc đặt `ALLOW_SIGNUP=true` trong mạng kín |
| "Origin không được phép" (403) | Mở app đúng địa chỉ có trong `ALLOWED_ORIGINS` (mặc định `http://localhost:3001`) |
| "Đã dùng hết trần chi phí AI" | Tăng `AI_CONFERENCE_CAP_USD` hoặc `AI_WORKSPACE_DAILY_CAP_USD`, rồi khởi động lại server |
| Máy khác trong mạng không mở được app | Đúng thiết kế: dev server chỉ lắng nghe `127.0.0.1`. Dùng cho nhóm thì cần triển khai HTTPS |
| Tải file "bị từ chối: nghi là bom giải nén" | File có cấu trúc nén bất thường. Lưu lại file bằng Office (Save As) rồi thử lại |

---

## Lộ trình

1. **Smart Response với API thật:** chạy thử phát hiện câu hỏi và gợi ý trả lời với Anthropic key, đo độ trễ và chất lượng trích dẫn.
2. **Dùng tại hội trường:** giọng đọc bản dịch, chặn im lặng (VAD), thanh điều khiển dưới đáy cho điện thoại, khóa màn hình, nút "Nghe ngay".
3. **Bảo mật đợt 3–4:** WebSocket thu hồi quyền và giới hạn kết nối, CSP/HSTS, scrypt mạnh hơn, xóa tài khoản và xuất dữ liệu.
4. **Sau hội nghị:** báo cáo tổng hợp có trích dẫn về từng đoạn transcript, xuất DOCX/PDF.
5. **Production:** chạy thử với API thật bằng `bench:live`, triển khai HTTPS, chuyển sang PostgreSQL.
