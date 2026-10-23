# 平台登入 Cookie（Netscape 格式）

X.com（NSFW/受限推文）、Instagram、Facebook 的登入牆內容需要瀏覽器 cookie 才能下載。
將 cookie 檔以 **Netscape 格式** 放入本目錄，檔名對應平台，存在即自動掛載（gallery-dl 引擎使用）：

| 檔名 | 平台 | 用途 |
|---|---|---|
| `x.txt` | X.com / Twitter | NSFW、受限推文、相片/圖集 |
| `instagram.txt` | Instagram | 貼文 / Reels / 圖集（IG 反爬嚴格，強烈建議提供） |
| `facebook.txt` | Facebook | 受限相片 / 相簿 |
| `xhs.txt` | 小紅書 | 作品解析（多數內容需登入；自動轉為 Cookie header 傳給 XHS-Downloader） |

## 取得方式（約 1 分鐘）

1. 安裝瀏覽器擴充「**Get cookies.txt LOCALLY**」（Chrome / Edge / Firefox 皆有）。
2. 以要使用的帳號**登入該平台**（建議使用小號，降低被限流風險）。
3. 停留在該平台頁面上，點擊擴充圖示 → **Export**（格式選 Netscape）。
4. 將匯出的檔案改名為上表對應檔名（如 `x.txt`），放入本目錄即可，**無需重啟服務**。

## 注意事項

- cookie 有失效週期（IG 數天～數週、X/FB 數週），下載開始回報登入類錯誤時請重新匯出。
- cookie 檔為**登入憑證，等同密碼**：已由 `.gitignore` 排除版控（`config/cookies/*.txt`），請勿外流。
- 未放置 cookie 時公開內容仍可下載；受限內容會回覆「此平台受限內容需登入 cookie，請放置 config/cookies/{platform}.txt」的降級訊息。
