#!/usr/bin/env python3
"""Cline 一键获取 refreshToken 脚本（WorkOS 设备授权码流程）。

用法：
  python3 cline_oauth.py

流程（逆向自 cline2api/auth.go）：
  1. POST api.workos.com/user_management/authorize/device → 拿授权链接
  2. 打印链接，等待用户在浏览器授权（自动轮询 authenticate）
  3. 授权成功 → 用 WorkOS token 调 api.cline.bot/api/v1/auth/register
  4. 打印 Cline 的 refreshToken → 填入 Cloudflare Worker 机密变量

依赖：仅 Python 3 标准库，无需 pip 安装任何东西。
"""
import json
import sys
import time
import urllib.parse
import urllib.request

WORKOS_DEVICE = "https://api.workos.com/user_management/authorize/device"
WORKOS_AUTH = "https://api.workos.com/user_management/authenticate"
CLINE_REGISTER = "https://api.cline.bot/api/v1/auth/register"
CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"


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

    print("=" * 60)
    print("1️⃣  在浏览器打开下面这个链接：")
    print(f"    {auth_url}")
    print("2️⃣  页面会要求输入设备码（可能已自动带好）：")
    print(f"    {user_code}")
    print("3️⃣  用 Google / GitHub / 邮箱登录并授权")
    print("=" * 60)

    print("\n🔄 等待你授权（脚本自动轮询，最多 {} 秒）...".format(expires_in))
    try:
        workos = poll_token(device_code, interval, expires_in)
    except TimeoutError as e:
        print(f"❌ {e}，请重新运行脚本")
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
    print("\n" + "=" * 60)
    print(f"✅ 登录成功! 账号: {email}")
    print("\n🔑 把下面这行填进 Cloudflare Worker 的机密变量 CLINE_REFRESH_TOKEN：")
    print("    " + rt)
    print("=" * 60)


if __name__ == "__main__":
    main()