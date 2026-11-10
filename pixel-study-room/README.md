# 📚 像素自習室

像素風的線上自習室：在地圖上走動，走近朋友就會自動接通視訊和語音，走開就會斷線。

## 功能

- **走近自動接通**：距離約 2～3 格以內會接通視訊和語音，距離越遠聲音越小
- **🔔 自動接通開關**（右上角）：關掉之後，走近別人時畫面下方會出現「📞 接通」按鈕，要雙方都同意才會接通。別人想跟你通話時，對方的名字會變成橘色並響鈴，按「接聽」就會接通；通話中隨時可以按「掛斷」
- **🤫 安靜自習區**（左邊的綠色地毯）：走進去就不會跟任何人接通，適合專心讀書
- **💬 討論區 / ☕ 休息區**：同一區的人走近就能聊天，牆的另一邊聽不到
- **🍅 共同番茄鐘**：任何人按下「開始」，全部的人一起計時，切換階段時會響提示音
- **🏆 今日自習時間排行**：記錄每個人今天在線多久（台灣時間午夜歸零）
- **💬 文字聊天室**：不想開麥克風的時候可以打字
- 手機也能用，畫面上會出現方向鍵

操作方式：方向鍵或 WASD 移動，按 Enter 開始打字，按 Esc 回到移動。

---

## 方法一：在自己電腦上開（最快，約 10 分鐘）

適合「今晚就想跟朋友用」。你的電腦要一直開著，朋友才連得進來。

1. **安裝 Node.js**：到 https://nodejs.org 下載 **LTS 版本**，一路按「下一步」安裝完成。
2. **解壓縮**這個資料夾，在資料夾裡開啟終端機：
   - Windows：在資料夾空白處按右鍵 →「在終端機中開啟」
   - Mac：在資料夾上按右鍵 →「服務」→「新增位於檔案夾位置的終端機視窗」
3. 輸入下面兩行指令（每行輸入完按 Enter）：
   ```
   npm install
   npm start
   ```
   看到 `像素自習室已啟動：http://localhost:3000` 就代表成功了。打開瀏覽器進入 http://localhost:3000 就可以先自己試試看。
4. **產生分享網址給朋友**：再開一個新的終端機視窗，安裝 Cloudflare 的免費工具（不用註冊帳號）：
   - Windows：`winget install --id Cloudflare.cloudflared`
   - Mac：`brew install cloudflared`（如果沒有 brew，可以從 Cloudflare 官網下載）
   
   接著執行：
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
   畫面會出現一個 `https://xxxx-xxxx.trycloudflare.com` 的網址，把它傳給朋友就可以了。

> 每次重新執行，網址都會不一樣。用完把兩個終端機視窗關掉就好。

---

## 方法二：放上 Render（免費雲端主機，不用一直開電腦）

適合要長期固定使用。設定一次之後就有一個固定網址。

1. **上傳到 GitHub**
   - 到 https://github.com 註冊帳號 → 右上角「+」→「New repository」→ 隨便取個名字（例如 `study-room`）→ Create
   - 點「uploading an existing file」，把資料夾裡的所有檔案拖進去（**`node_modules` 資料夾不要上傳**）→ Commit changes
2. **部署到 Render**
   - 到 https://render.com 用 GitHub 帳號登入
   - 「New +」→「Web Service」→ 選剛剛建立的 repository
   - 設定以下欄位：
     - Build Command：`npm install`
     - Start Command：`npm start`
     - Instance Type：**Free**
   - （選填）在「Environment Variables」新增 `ROOM_PASSWORD`，值設成你要的密碼，這樣只有知道密碼的人才能進入
   - 按「Create Web Service」，等幾分鐘就會得到一個 `https://xxxx.onrender.com` 的網址

**Render 免費方案要注意：**
- 15 分鐘沒人連線就會休眠，下一個人進來時要等大約 1 分鐘才會醒來
- 主機休眠或重啟時，「今日自習時間排行」會歸零

---

## 常見問題

**Q：朋友看不到我的畫面／一直連不上？**
- 請用 Chrome、Edge 或 Safari 的最新版本，並允許相機和麥克風權限
- 一定要用 `https://` 開頭的網址（上面兩種方法都是），用 http 瀏覽器不會允許開相機
- 有些學校或公司的網路會擋點對點連線。可以先改用手機熱點試試看；如果還是不行，就需要設定 TURN 伺服器（在環境變數填入 `TURN_URL`、`TURN_USERNAME`、`TURN_CREDENTIAL`）

**Q：最多可以幾個人？**
視訊是兩兩直接連線的，所以「同時圍在一起」的人建議 2～6 人。整個地圖上的人數可以更多，因為只有靠近的人才會連線。

**Q：想改地圖？**
編輯 `public/map.js` 裡的 `ROWS`。每個字元代表一格：`#` 牆、`B` 書架、`D` 書桌、`T` 討論桌、`P` 盆栽、`q` 安靜區、`.` 地板、`r` 地毯。每一行的字數要一樣長。

## 檔案結構

```
server.js         伺服器（接近偵測、番茄鐘、排行、聊天）
public/map.js     地圖
public/client.js  畫面、移動、視訊連線
public/index.html
public/style.css
```
