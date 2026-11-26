# Troubleshooting / 故障排查

## Common Issues / 常见问题

---

### 1. 429 Rate Limit Errors / 429 限速错误

**Symptoms / 症状:**
```
429: Rate limited >> [邮箱]
```

**Causes / 原因:**
- Account or organization quota is exhausted / 账号或组织配额已耗尽
- Short-term rate limiting or temporary model capacity limits / 短时限速或模型容量限制
- Request concurrency is higher than the authorized plan allows / 并发高于已授权计划

**Solutions / 解决方案:**
1. Reduce request frequency and concurrency / 降低请求频率与并发
2. Respect `Retry-After` and the reset time shown in Quota / 遵守 `Retry-After` 与配额面板显示的重置时间
3. Verify that the configured accounts are owned or authorized for this use / 确认账号由本人拥有或获得明确授权
4. Purchase or request additional authorized capacity from the provider when needed / 需要时向提供商购买或申请更多获授权容量
5. Do **not** create free-tier accounts or add accounts to evade a limit / **不要** 通过创建免费账号或加号来规避限制

Console example / 控制台示例:
```
429: Rate limited >> [邮箱]
→ Cooling down authorized account
```

---

### 2. Tunnel / Remote Access Issues / 远程隧道问题

**Symptoms / 症状:**
```
Set ANTI_API_PUBLIC_TOKEN before starting a tunnel.
```
or the tunnel starts but management pages remain local-only.

**Causes / 原因:**
- Public inference token is not configured / 未配置公开推理 Token
- ngrok is not installed or its authtoken is invalid / 未安装 ngrok 或 authtoken 无效
- Tunnel is intentionally limited to the inference-only gateway / 隧道仅暴露推理网关

**Solutions / 解决方案:**
1. Configure a long random public token:
   ```bash
   export ANTI_API_PUBLIC_TOKEN='replace-with-a-long-random-secret'
   ```
2. Install the tunnel binary yourself from its official distribution; Anti-API no longer downloads ngrok automatically.
3. Start the tunnel from `http://localhost:8964/remote-panel`. It targets the public inference port (default `8966`), not the dashboard.
4. Clients must send:
   ```http
   Authorization: Bearer replace-with-a-long-random-secret
   ```
5. If an old tunnel process is still running, stop it from the Remote panel. Do not use process-wide `killall` unless you intentionally manage the process yourself.

---

### 3. Quota Not Loading / 配额不显示

**Symptoms / 症状:**
- Some accounts show 0% quota
- Quota bars empty on first load

**Causes / 原因:**
- OAuth token expired / OAuth 令牌过期
- Network timeout on first request / 首次请求网络超时
- Certificate validation issues / 证书验证问题

**Solutions / 解决方案:**
1. Click **Refresh** in the Quota panel
2. Re-authenticate only accounts you own or administer
3. Install the correct enterprise CA if TLS validation fails; do not disable certificate verification as a first response
4. Check console warnings for the specific provider quota fetch

---

### 4. OAuth Login Failed / OAuth 登录失败

**Symptoms / 症状:**
- Browser opens but login fails
- Access denied or redirect loop

**Solutions / 解决方案:**
1. Use an account that you own or are authorized to administer
2. Confirm the OAuth callback port is free and mapped only on loopback by default
3. Prefer a local browser on the same machine for callback-based providers
4. For Docker on a remote host, use SSH port forwarding or the provider's device-code flow when available

---

### 5. Streaming Not Working / 流式响应不工作

**Symptoms / 症状:**
- Response arrives all at once
- No incremental updates

**Solutions / 解决方案:**
1. Ensure the request sets `"stream": true`
2. Confirm the client supports Server-Sent Events
3. Check proxies or firewalls that buffer chunked responses

---

### 6. Tool Calling Errors / 工具调用错误

**Symptoms / 症状:**
- `tool_calls` missing
- Argument parsing fails

**Solutions / 解决方案:**
1. Verify the tool schema matches the OpenAI or Anthropic format expected by the client
2. Use a model that supports tool calling for that provider
3. Check translator logs for schema cleaning or validation failures

---

### 7. Server Won't Start / 服务无法启动

**Symptoms / 症状:**
```
Error: Port 8964 already in use
```
or
```
ANTI_API_HOST must be a loopback address
```

**Solutions / 解决方案:**
1. Stop the existing Anti-API process or choose another local port:
   ```bash
   bun run src/main.ts start --port 8080
   ```
2. Keep the full control plane on loopback. For LAN or tunnel access, configure:
   ```bash
   export ANTI_API_PUBLIC_TOKEN='replace-with-a-long-random-secret'
   export ANTI_API_PUBLIC_PORT=8966
   ```
   With a configured token, the separate inference listener defaults to
   `0.0.0.0`. Set `ANTI_API_PUBLIC_HOST=127.0.0.1` when a local reverse proxy
   or tunnel is the only intended caller.
3. Docker Compose publishes management ports to host loopback by default. Do not publish them to all interfaces.

---

## Getting Help / 获取帮助

1. Check local console logs after redacting credentials
2. Enable verbose mode with `bun run src/main.ts start -v`
3. Open a GitHub issue with:
   - Error message without secrets
   - Steps to reproduce
   - Version or commit
   - Whether the failure is on the local control plane or the public inference gateway

Do not paste access tokens, refresh tokens, account files, or unredacted logs into public issues. Use the private reporting process in `SECURITY.md` for security findings.
