# 公共留言板

所有人都可以发布留言（自定义名字 + 标题 + 内容）的公共网站。
运行在 **Cloudflare Workers + D1 数据库**上，免费额度足够个人使用（每天 10 万次请求）。

## 功能

- 任何人都能发留言，名字可自选，留空则显示“匿名”，浏览器会记住上次用的名字
- 留言按时间倒序显示，每页 20 条，可“加载更多”
- 防滥用：同一 IP 每 30 秒最多发 1 条、每小时最多 10 条；隐藏字段拦截简单机器人；长度限制（名字 30 / 标题 100 / 内容 2000 字）
- 用户输入一律按纯文本显示，不会被当成 HTML 执行
- 管理员可用密钥删除留言
- 数据库只保存 IP 的加盐哈希（用于限流），不保存原始 IP

## 项目结构

```
public/index.html   前端页面
src/index.js        后端 API（Cloudflare Worker）
schema.sql          数据库表结构
wrangler.toml       Cloudflare 配置
```

## 本地运行

```bash
npm install
npm run db:init:local
npm run dev
```

打开 http://localhost:8787

## 部署上线

1. 注册 Cloudflare 账号：https://dash.cloudflare.com/sign-up
2. 登录（会打开浏览器授权）：
   ```bash
   npx wrangler login
   ```
3. 创建数据库，把输出里的 `database_id` 填进 `wrangler.toml`：
   ```bash
   npx wrangler d1 create message-board
   ```
4. 在线上数据库建表：
   ```bash
   npm run db:init:remote
   ```
5. 设置管理员密钥和 IP 哈希盐（各自输入一串随便的长随机字符串）：
   ```bash
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put IP_SALT
   ```
6. 部署：
   ```bash
   npm run deploy
   ```
   完成后会得到一个 `https://agent-message-board.<你的子域>.workers.dev` 地址，全世界都能访问。

之后改了代码，再跑一次 `npm run deploy` 即可更新。

## 绑定自己的域名

### 1. 买域名

| 注册商 | 说明 |
| --- | --- |
| **Cloudflare Registrar**（推荐） | 成本价，无溢价，`.com` 约 $10/年；买完自动接入 Cloudflare，最省事。Dashboard → Domain Registration → Register Domains |
| Porkbun / Namecheap | 便宜、支持的后缀更多；买完需要把域名的 Nameserver 改成 Cloudflare 给的两个 |
| 阿里云 / 腾讯云 | 国内注册需实名认证；只要网站不放在中国大陆服务器上，就**不需要备案** |

选名字建议：短、好拼、优先 `.com`；避开带连字符和数字的。

### 2. 把域名绑定到网站

在 `wrangler.toml` 末尾加上（把 `example.com` 换成你的域名）：

```toml
routes = [
  { pattern = "example.com", custom_domain = true }
]
```

然后再 `npm run deploy`，Cloudflare 会自动配置 DNS 和 HTTPS 证书，几分钟后就能用 `https://example.com` 访问。

（也可以在网页上操作：Workers & Pages → agent-message-board → Settings → Domains & Routes → Add → Custom domain。）

> 中国大陆访问提示：`*.workers.dev` 默认地址在大陆基本打不开，绑定自己的域名后通常可以访问，但速度可能不稳定。

## 管理留言

删除某条留言（ID 可在浏览器开发者工具的 `/api/messages` 响应里看到）：

```bash
curl -X DELETE https://你的域名/api/messages/123 -H "Authorization: Bearer 你的ADMIN_TOKEN"
```

批量查看或清理也可以直接在 Cloudflare Dashboard → D1 → message-board 的控制台里执行 SQL。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/messages?before=<id>` | 获取留言（倒序，每页 20 条） |
| POST | `/api/messages` | 发布，JSON：`{ "name", "title", "content" }` |
| DELETE | `/api/messages/<id>` | 删除，需要 `Authorization: Bearer <ADMIN_TOKEN>` |
