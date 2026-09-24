# Agent Trading Journal (tiếng Việt)

**Nhật ký giao dịch do AI agent ghi hộ bạn.** Dán screenshot chart vào Claude Code, Codex hoặc bất kỳ MCP client nào. Agent đọc chart, điền các field theo **chiến lược của bạn**, chấm lệnh theo **rule của bạn**, ghi lại lệnh và đính kèm ảnh. Dashboard chạy trên máy cho bạn thấy cái gì đang hiệu quả.

Không cần form nhập, không cần API key LLM, không cần tài khoản. Mọi dữ liệu nằm trên máy bạn, trong một file SQLite.

English: [README.md](README.md)

## Khác gì các journal có AI khác

| | Journal AI thông thường | Agent Trading Journal |
|---|---|---|
| Ai nhập lệnh | Bạn tự nhập vào form | Agent của bạn, từ screenshot hoặc file sao kê broker |
| AI kết nối kiểu gì | App gọi LLM bằng API key của bạn | Qua MCP: agent (Claude Code / Codex…) **chính là** AI |
| Đo cái gì | Field cố định + tag tự do | Field và checklist rule theo **chiến lược của chính bạn** |
| Rule | Chỉ là ghi chú | Mỗi rule được chấm `pass`/`fail` trên từng lệnh → so kết quả khi theo rule và khi phá rule |
| Kèo đứng ngoài | Không theo dõi | Có ghi lại, review sau xem đứng ngoài có đúng không |
| Luật quỹ | Hiếm khi có | Canh daily loss, max drawdown, số lệnh/ngày, chuỗi thua |

## Bắt đầu

1. **Kết nối với agent.**
   - Claude Code: `claude mcp add journal -- npx -y agent-trading-journal`
   - Codex: thêm `[mcp_servers.journal]` với `command = "npx"`, `args = ["-y", "agent-trading-journal"]` vào `~/.codex/config.toml`.
   - Chạy `npx agent-trading-journal setup` để in sẵn cấu hình cho mọi client.
2. **Nói với agent:** *"Setup trading journal cho tôi."* Agent sẽ phỏng vấn bạn bằng tiếng Việt về thị trường, luật rủi ro, cách xác định xu hướng, setup, điểm vào, SL/TP và khi nào không trade. Từ câu trả lời, nó đề xuất **field** (thứ cần đo trên từng lệnh) và **rule** (checklist vào lệnh); bạn duyệt xong thì nó lưu. Kịch bản phỏng vấn đầy đủ: [docs/ONBOARDING.md](docs/ONBOARDING.md).
3. **Trade hoặc backtest như bình thường.** Dán screenshot và nói *"ghi lệnh này"*. Muốn xem tổng kết thì nói *"review tuần này"*, trước phiên thì *"check trước phiên"*. Nói *"mở dashboard"* để xem ở <http://localhost:3777>. Dashboard có nút EN/VI.

Chỉ muốn xem thử: chạy `npx agent-trading-journal demo`.

## Dữ liệu

Dữ liệu mặc định nằm ở `~/.agent-trading-journal`; đổi chỗ bằng biến môi trường `JOURNAL_DATA_DIR`. Muốn backup thì copy nguyên thư mục đó.

## An toàn

Đây là công cụ ghi chép và phân tích. Nó không đặt lệnh và không đưa ra lời khuyên đầu tư. Giao dịch có đòn bẩy rủi ro rất cao. AI có thể đọc chart sai: mọi giá trị đã ghi đều xem và sửa được, và phần chấm rule nói rõ rule nào không đạt và vì sao.

MIT © 2026 [smizxe](https://github.com/smizxe). Phần đọc file sao kê dùng thư viện MIT của [LuxAlgo Trade Journal](https://github.com/LuxAlgo/trade-journal). Dự án này không liên kết với LuxAlgo.
