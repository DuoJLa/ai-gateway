#!/usr/bin/env python3
"""Cline 一键获取 refreshToken 脚本（WorkOS 设备授权码流程）。

用法：
  python3 cline_oauth.py

流程（逆向自 cline2api/auth.go）：
  1. POST api.workos.com/user_management/authorize/device → 拿授权链接
  2. 打印链接/推送 TG，等待用户在浏览器授权（自动轮询 authenticate）
  3. 授权成功 → 用 WorkOS token 调 api.cline.bot/api/v1/auth/register
  4. 拿到 refreshToken → 填入 Cloudflare Worker 机密变量

GitHub Actions 里的安全行为（重要）：
  * 配置了 TG_BOT_TOKEN / TG_CHAT_ID 时，授权链接与 refreshToken 一律推送到
    Telegram，**refreshToken 绝不打印到标准输出/日志**。
  * 未配置 TG 时（本地手动跑），保持原样打印，方便直接查看。

环境变量：
  TG_BOT_TOKEN         Telegram Bot Token（可选；与 TG_CHAT_ID 一起配置才推送）
  TG_CHAT_ID           Telegram 接收 chat_id（可选）
  OAUTH_POLL_TIMEOUT   授权等待秒数（可选，默认用 WorkOS 返回的 expires_in）

依赖：仅 Python 3 标准库，无需 pip 安装任何东西。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device"
WORKOS_AUTH = "https://api.workos.com/user_management/authenticate"
CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register"
CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"


def in_ci():
    return os.environ.get("GITHUB_ACTIONS") == "true"


def tg_configured():
    return bool(os.environ.get("TG_BOT_TOKEN") and os.environ.get("TG_CHAT_ID"))


def send_tg(text):
    """推送文本到 Telegram，失败返回 False。"""
    token = os.environ.get("TG_BOT_TOKEN")
    chat = os.environ.get("TG_CHAT_ID")
    if not token or not chat:
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    body = json.dumps({"chat_id": chat, "text": text}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return True
    except Exception as e:
        print(f"   ⚠️ TG 发送失败: {e}")
        return False


def mask_value(value):
    """在 CI 中把敏感值加入 GitHub Actions 日志掩码（即使误打出也被打码）。"""
    if in_ci() and value:
        print(f"::add-mask::{value}")


def post_form(url, form):
    data = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def post_json(url, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def device_auth():
    """启动 WorkOS 设备授权，返回 (device_code, user_code, 授权链接, interval, expires_in)。"""
    resp = post_form(WORKOS_DEVICE, {"client_id": CLIENT_ID})
    url = resp.get("verification_uri_complete") or resp.get("verification_uri")
    return (resp["device_code"], resp["user_code"], url,
            resp.get("interval", 5), resp.get("expires_in", 300))


def poll_token(device_code, interval, expires_in):
    """轮询 WorkOS 直到用户授权完成，返回 WorkOS access/refresh token。"""
    interval = max(interval, 5)
    deadline = time.time() + expires_in
    while time.time() < deadline:
        time.sleep(interval)
        try:
            a = post_form(WORKOS_AUTH, {
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": CLIENT_ID,
            })
            if "access_token" in a:
                return a
            err = a.get("error")
            if err == "slow_down":
                interval += 5
            elif err not in ("authorization_pending",):
                print(f"   [{err}] {a.get('error_description', '')}")
        except Exception as e:
            print(f"   轮询出错: {e}")
    raise TimeoutError("授权超时")


def main():
    print("🚀 启动 Cline WorkOS 设备授权流程...\n")
    device_code, user_code, auth_url, interval, expires_in = device_auth()

    # 可选的轮询超时覆盖
    env_timeout = os.environ.get("OAUTH_POLL_TIMEOUT")
    if env_timeout:
        try:
            expires_in = int(env_timeout)
        except ValueError:
            pass

    use_tg = tg_configured()
    print("=" * 60)
    print("1️⃣  在浏览器打开下面这个链接：")
    print(f"    {auth_url}")
    print("2️⃣  页面会要求输入设备码（可能已自动带好）：")
    print(f"    {user_code}")
    print("3️⃣  用 Google / GitHub / 邮箱登录并授权")
    print("=" * 60)

    # 把授权链接推送到 TG，方便在手机上完成授权
    if use_tg:
        tg_msg = (
            "🔑 *Cline 授权请求*\n\n"
            "请在浏览器打开下面链接并完成授权（设备码已自动带好）：\n"
            f"{auth_url}\n\n"
            f"设备码：`{user_code}`\n"
            f"脚本将自动轮询等待，最多 {expires_in} 秒。"
        )
        ok = send_tg(tg_msg)
        if not ok:
            print("❌ 授权链接推送 TG 失败（请检查 TG_BOT_TOKEN / TG_CHAT_ID）")
            sys.exit(1)
        print("📨 授权链接已推送到 Telegram。")
    else:
        print("ℹ️ 未配置 TG，授权链接仅在下方日志中显示。")

    print(f"\n🔄 等待你授权（脚本自动轮询，最多 {expires_in} 秒）...")
    try:
        workos = poll_token(device_code, interval, expires_in)
    except TimeoutError as e:
        print(f"❌ {e}，请重新运行")
        sys.exit(1)
    print("✅ WorkOS 授权成功！")

    print("\n🔗 用 WorkOS token 在 Cline 注册...")
    cline = post_json(CLINE_REGISTER, {
        "accessToken": workos["access_token"],
        "refreshToken": workos["refresh_token"],
    })
    data = cline.get("data", {})
    rt = data.get("refreshToken")
    if not rt:
        print("❌ 注册失败，响应:", json.dumps(cline, ensure_ascii=False)[:500])
        sys.exit(1)

    email = (data.get("userInfo") or {}).get("email", "unknown")
    # 邮箱同样视为敏感信息：打码，避免进入 Actions 日志
    mask_value(email)
    print("\n" + "=" * 60)
    # 打码后显示，日志里是 ***
    print(f"✅ 登录成功! 账号: {email}")

    # 关键安全点：CI + 配置了 TG 时，refreshToken 只推 TG，绝不打印到日志
    if use_tg:
        mask_value(rt)  # 兜底：即使万一打出也会被 Actions 掩码
        ok = send_tg(
            "🔑 *Cline refreshToken 已获取*\n\n"
            f"账号：`{email}`\n\n"
            "把下面这行填进 Cloudflare Worker 机密变量 `CLINE_REFRESH_TOKEN`（多账号则换行追加）：\n"
            f"`{rt}`"
        )
        if not ok:
            print("❌ refreshToken 推送 TG 失败！token 未打印到日志，请检查 TG 配置后重试。")
            sys.exit(1)
        print("🔑 refreshToken 已通过 Telegram 私密发送（未写入日志）。")
    else:
        mask_value(rt)
        print("\n🔑 把下面这行填进 Cloudflare Worker 的机密变量 CLINE_REFRESH_TOKEN：")
        print("    " + rt)
    print("=" * 60)


if __name__ == "__main__":
    main()