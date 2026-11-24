#!/usr/bin/env python3
"""
Antigravity Credentials Extractor & Exporter
Zero-dependency script (standard library only) to extract or generate Google Antigravity
credentials for anti-api without needing SSH on headless servers.

Features:
1. Auto-extracts OAuth tokens directly from local Antigravity IDE (Windows/macOS/Linux).
2. Fallback / interactive Google OAuth login in browser if IDE is not installed or for new accounts.
3. Automatically fetches email and Cloud Code Project ID.
4. Can upload directly to a remote anti-api instance via HTTP/HTTPS (POST /auth/login).
5. Generates auth.json and accounts.json ready for copying.
"""

import sys
import os
import json
import base64
import re
import urllib.request
import urllib.parse
import webbrowser
import secrets
import hashlib
from http.server import HTTPServer, BaseHTTPRequestHandler

OAUTH_CONFIG = {
    "clientId": "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    "clientSecret": "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",
    "callbackPort": 51121,
    "authUrl": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenUrl": "https://oauth2.googleapis.com/token",
    "userInfoUrl": "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    "projectUrl": "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "scopes": [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/userinfo.profile",
        "https://www.googleapis.com/auth/cclog",
        "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
}

def find_ide_db_path() -> str | None:
    candidates = []
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", "")
        if appdata:
            candidates.append(os.path.join(appdata, "Antigravity IDE", "User", "globalStorage", "state.vscdb"))
            candidates.append(os.path.join(appdata, "Antigravity", "User", "globalStorage", "state.vscdb"))
    elif sys.platform == "darwin":
        home = os.path.expanduser("~")
        candidates.append(os.path.join(home, "Library", "Application Support", "Antigravity", "User", "globalStorage", "state.vscdb"))
        candidates.append(os.path.join(home, "Library", "Application Support", "Antigravity IDE", "User", "globalStorage", "state.vscdb"))
    else:
        home = os.path.expanduser("~")
        candidates.append(os.path.join(home, ".config", "Antigravity", "User", "globalStorage", "state.vscdb"))
        candidates.append(os.path.join(home, ".config", "Antigravity IDE", "User", "globalStorage", "state.vscdb"))

    for p in candidates:
        if os.path.exists(p):
            return p
    return None

def extract_from_local_ide():
    import sqlite3

    db_path = find_ide_db_path()
    if not db_path:
        return None

    try:
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute("SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.oauthToken'")
        row = cur.fetchone()
        conn.close()

        if not row or not row[0]:
            return None

        raw_val = row[0]
        decoded_b1 = base64.b64decode(raw_val)
        matches = [m for m in re.findall(rb"[A-Za-z0-9+/=]{50,}", decoded_b1)]
        if not matches:
            return None

        decoded_b2 = base64.b64decode(matches[0])
        text = decoded_b2.decode("latin1", errors="ignore")
        refresh_tokens = re.findall(r"1//[a-zA-Z0-9_\-]+", text)
        if not refresh_tokens:
            return None

        return refresh_tokens[0]
    except Exception as e:
        print(f"[!] Warning: failed to extract from local IDE: {e}")
        return None

def refresh_tokens(refresh_token: str):
    data = urllib.parse.urlencode({
        "client_id": OAUTH_CONFIG["clientId"],
        "client_secret": OAUTH_CONFIG["clientSecret"],
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode("utf-8")

    req = urllib.request.Request(OAUTH_CONFIG["tokenUrl"], data=data)
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        return res["access_token"], int(res.get("expires_in", 3600))

def fetch_user_info(access_token: str):
    req = urllib.request.Request(
        OAUTH_CONFIG["userInfoUrl"],
        headers={"Authorization": f"Bearer {access_token}"}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode("utf-8"))

def fetch_project_id(access_token: str) -> str:
    try:
        body = json.dumps({"metadata": {"ideType": "ANTIGRAVITY"}}).encode("utf-8")
        req = urllib.request.Request(
            OAUTH_CONFIG["projectUrl"],
            data=body,
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": "application/json",
                "User-Agent": "antigravity/1.107.0",
            }
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("cloudaicompanionProject") or "aicode-consumers"
    except Exception:
        return "aicode-consumers"

class OAuthCallbackHandler(BaseHTTPRequestHandler):
    auth_code = None
    expected_state = None

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if "code" in params and "state" in params:
            if params["state"][0] == OAuthCallbackHandler.expected_state:
                OAuthCallbackHandler.auth_code = params["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(b"<html><body style='font-family:sans-serif;background:#18181b;color:#f4f4f5;text-align:center;padding:50px;'><h1>Login completato con successo!</h1><p>Puoi chiudere questa scheda del browser e tornare al terminale.</p></body></html>")
                return

        self.send_response(400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"<html><body><h1>Autenticazione fallita o stato non valido.</h1></body></html>")

def login_via_browser():
    state = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    code_challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("utf-8")).digest()).decode("utf-8").rstrip("=")

    port = OAUTH_CONFIG["callbackPort"]
    redirect_uri = f"http://localhost:{port}/oauth-callback"

    OAuthCallbackHandler.auth_code = None
    OAuthCallbackHandler.expected_state = state

    server = HTTPServer(("127.0.0.1", port), OAuthCallbackHandler)

    params = {
        "client_id": OAUTH_CONFIG["clientId"],
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(OAUTH_CONFIG["scopes"]),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    url = f"{OAUTH_CONFIG['authUrl']}?{urllib.parse.urlencode(params)}"

    print(f"\n[+] Apertura browser per login Google...")
    print(f"    URL: {url}\n")
    webbrowser.open(url)

    print("[*] In attesa del completamento nel browser...")
    server.timeout = 300
    while not OAuthCallbackHandler.auth_code:
        server.handle_request()

    code = OAuthCallbackHandler.auth_code
    server.server_close()

    if not code:
        raise RuntimeError("Nessun codice di autorizzazione ricevuto.")

    token_data = urllib.parse.urlencode({
        "client_id": OAUTH_CONFIG["clientId"],
        "client_secret": OAUTH_CONFIG["clientSecret"],
        "code": code,
        "grant_type": "authorization_code",
        "redirect_uri": redirect_uri,
        "code_verifier": code_verifier,
    }).encode("utf-8")

    req = urllib.request.Request(OAUTH_CONFIG["tokenUrl"], data=token_data)
    with urllib.request.urlopen(req) as resp:
        tokens = json.loads(resp.read().decode("utf-8"))
        return tokens["access_token"], tokens["refresh_token"], int(tokens.get("expires_in", 3600))

def upload_to_anti_api(server_url: str, auth_payload: dict, control_token: str | None = None) -> bool:
    endpoint = f"{server_url.rstrip('/')}/auth/login"
    body = json.dumps({
        "provider": "antigravity",
        "accessToken": auth_payload["accessToken"],
        "refreshToken": auth_payload["refreshToken"],
        "email": auth_payload.get("userEmail"),
        "name": auth_payload.get("userName"),
    }).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    if control_token:
        headers["x-api-key"] = control_token

    try:
        req = urllib.request.Request(endpoint, data=body, headers=headers)
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success"):
                print(f"[OK] Credenziali inviate con successo a {endpoint} per {auth_payload.get('userEmail')}!")
                return True
            else:
                print(f"[!] Errore nella risposta del server: {data}")
                return False
    except Exception as e:
        print(f"[!] Impossibile caricare su {endpoint}: {e}")
        return False

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Estrae o genera credenziali Antigravity per anti-api.")
    parser.add_argument("--browser", action="store_true", help="Forza il login interattivo via browser invece di estrarre dall'IDE locale")
    parser.add_argument("--upload", type=str, help="URL dell'istanza anti-api (es. http://localhost:8964) per inviare le credenziali direttamente senza SSH")
    parser.add_argument("--token", type=str, help="ANTI_API_CONTROL_TOKEN o API key se richiesta dall'istanza remota")
    parser.add_argument("--out", type=str, default="antigravity-account.json", help="Nome del file JSON locale da salvare (default: antigravity-account.json)")
    args = parser.parse_args()

    refresh_token = None
    access_token = None
    expires_in = 3600

    if not args.browser:
        print("[*] Ricerca database locale Antigravity IDE...")
        db_path = find_ide_db_path()
        if db_path:
            print(f"[*] Trovato database locale: {db_path}")
            refresh_token = extract_from_local_ide()
            if refresh_token:
                print("[+] Token estratto con successo dall'IDE locale!")
                print("[*] Generazione nuovo Access Token da Google...")
                access_token, expires_in = refresh_tokens(refresh_token)
            else:
                print("[!] Nessun account loggato trovato nell'IDE locale.")
        else:
            print("[!] Antigravity IDE non trovato nei percorsi standard.")

    if not refresh_token or not access_token:
        print("[*] Avvio login interattivo via browser...")
        access_token, refresh_token, expires_in = login_via_browser()

    print("[*] Recupero informazioni utente da Google...")
    user_info = fetch_user_info(access_token)
    email = user_info.get("email", "unknown")
    name = user_info.get("name") or email.split("@")[0]
    print(f"[+] Account: {email} ({name})")

    print("[*] Recupero Google Cloud Code Project ID...")
    project_id = fetch_project_id(access_token)
    print(f"[+] Project ID: {project_id}")

    import time
    auth_data = {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": int(time.time() * 1000) + (expires_in * 1000),
        "userEmail": email,
        "userName": name,
        "projectId": project_id,
    }

    out_file = args.out
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(auth_data, f, indent=2)
    print(f"\n[OK] Credenziali salvate localmente in '{out_file}'.")

    if args.upload:
        print(f"\n[*] Invio credenziali all'endpoint remoto {args.upload}...")
        upload_to_anti_api(args.upload, auth_data, args.token)
    else:
        print("\n" + "="*65)
        print("  COME IMPORTARE L'ACCOUNT NELLA WEB UI (SENZA SSH):")
        print("  1. Apri la dashboard di Anti-API nel browser (es. http://localhost:8964)")
        print("  2. Clicca su '+ Add Account'")
        print(f"  3. Trascina semplicemente il file '{out_file}' nell'apposita area")
        print("     oppure clicca per selezionarlo. Fatto! Nessun SSH necessario.")
        print("="*65 + "\n")

if __name__ == "__main__":
    main()
